/* @flow */
"use strict";
import {MatrixUser, IrcUser} from "../models/users";
import {IrcAction} from "../models/actions";
import IrcServer from "./server";
import {ConnectionInstance} from "./client-connection";

var q = require("q");
var EventEmitter = require("events").EventEmitter;
var ident = require("./ident");
var clientConnection = require("./client-connection");
var clientEvents = require("./client-events");
var names = require("./names");
var IrcRoom = require("../models/rooms").IrcRoom;
var log = require("../logging").get("irc-client");

// The length of time to wait before trying to join the channel again
var JOIN_TIMEOUT_MS = 15 * 1000; // 15s

class BridgedClient extends EventEmitter {
    matrixUser: MatrixUser;
    ircUser: IrcUser;
    server: IrcServer;
    nick: string;
    password: ?string;
    userId: ?string;
    unsafeClient: Object;
    disabled: boolean;
    isBot: boolean;
    lastActionTs: number;
    _idleTimeout: number;
    inst: ?ConnectionInstance;
    instCreationFailed: boolean;
    explicitDisconnect: boolean;
    chanList: Array<string>;
    _connectDefer: Object;
    _id: string;
    callbacks: Object;
    log: Object;
    // EventEmitter types
    emit: Function;
    on: Function;
    addListener: Function;

    /**
     * Create a new bridged IRC client.
     * @constructor
     * @param {Object} ircUser : The IRC user to create a connection for.
     * @param {Object} matrixUser : Optional. The matrix user this virtual IRC user.
     * @param {boolean} isBot : True if this is the bot
     */
    constructor(ircUser: IrcUser, matrixUser: MatrixUser, isBot: boolean) {
        super();
        this.matrixUser = matrixUser;
        this.setIrcUserInfo(ircUser);
        this.isBot = Boolean(isBot);
        this.disabled = this.isBot && !ircUser.server.isBotEnabled();
        this.lastActionTs = Date.now();
        this.inst = null;
        this.instCreationFailed = false;
        this.explicitDisconnect = false;
        this.chanList = [];
        this._connectDefer = q.defer();
        this._id = (Math.random() * 1e20).toString(36);
        // decorate log lines with the nick and domain, along with an instance id
        var prefix = "<" + this.nick + "@" + this.server.domain + "#" + this._id + "> ";
        if (this.userId) {
            prefix += "(" + this.userId + ") ";
        }
        this.log = {
            debug: function() {
                arguments[0] = prefix + arguments[0];
                log.debug.apply(log, arguments);
            },
            info: function() {
                arguments[0] = prefix + arguments[0];
                log.info.apply(log, arguments);
            },
            error: function() {
                arguments[0] = prefix + arguments[0];
                log.error.apply(log, arguments);
            }
        };
    }

    setIrcUserInfo(ircUser: IrcUser) { // TODO remove this
        this.ircUser = ircUser;
        this.server = ircUser.server;
        this.nick = ircUser.nick;
        this.password = ircUser.password;
        this.userId = this.matrixUser ? this.matrixUser.userId : ircUser.username;
    }

    isDead(): boolean {
        if (this.instCreationFailed || (this.inst && this.inst.dead)) {
            return true;
        }
        return false;
    }

    /**
     * @param {Object} callbacks
     * @return {ConnectionInstance} A new connected connection instance.
     */
    connect(callbacks: Object): Promise<ConnectionInstance> {
        this.callbacks = callbacks;
        var self = this;
        var server = this.server;
        var defer = q.defer();

        names.getIrcNames(this.ircUser, this.matrixUser).then(function(nameInfo) {
            self.log.info(
                "Connecting to IRC server %s as %s (user=%s)",
                server.domain, nameInfo.nick, nameInfo.username
            );

            return clientConnection.create(server, {
                nick: nameInfo.nick,
                username: nameInfo.username,
                realname: nameInfo.realname,
                password: self.password
            }, function(inst) {
                self._onConnectionCreated(inst, nameInfo, callbacks);
            });
        }).done(function(connInst) {
            self.inst = connInst;
            self.unsafeClient = connInst.client;
            self.log.debug("connected!");
            self.emit("client-connected", self);
            // we may have been assigned a different nick, so update it from source
            self.nick = connInst.client.nick;
            self._connectDefer.resolve();
            self._keepAlive();
            connInst.client.addListener("registered", function() {
                var oldNick = self.nick;
                if (oldNick !== self.unsafeClient.nick) {
                    self.log.info(
                        "REGISTERED: Nick changed from '" + oldNick + "' to '" +
                        self.unsafeClient.nick + "'."
                    );
                    self.nick = self.unsafeClient.nick;
                    self.emit("nick-change", self, oldNick, self.unsafeClient.nick);
                }
            });
            connInst.client.addListener("nick", function(old, newNick) {
                if (old === self.nick) {
                    self.log.info(
                        "NICK: Nick changed from '" + old + "' to '" + newNick + "'."
                    );
                    self.nick = newNick;
                    self.emit("nick-change", self, old, newNick);
                }
            });
            defer.resolve(connInst);
        }, function(e) {
            self.log.debug("Failed to connect.");
            self.instCreationFailed = true;
            defer.reject(e);
        });

        return defer.promise;
    }

    disconnect(reason: string): Promise<any> {
        this.explicitDisconnect = true;
        var d = q.defer();
        if (!this.inst || this.inst.dead) {
            return q();
        }
        this.inst.disconnect(reason, function() {
            d.resolve();
        });
        return d.promise;
    }

    /**
     * Change this user's nick.
     * @param {string} newNick : The new nick for the user.
     * @return {Promise<String>} Which resolves to a message to be sent to the user.
     */
    changeNick(newNick: string): Promise<String> {
        // TODO: This is dupe logic with server.js
        // strip illegal chars according to RFC 1459 Sect 2.3.1
        // but allow _ because most IRC servers allow that.
        var nick = newNick.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");
        // nicks must start with a letter
        if (!/^[A-Za-z]/.test(nick)) {
            return q.reject("Nick '" + nick + "' must start with a letter.");
        }
        var maxNickLen = 9; // RFC 1459 default
        if (this.unsafeClient.supported &&
                typeof this.unsafeClient.supported.nicklength == "number") {
            maxNickLen = this.unsafeClient.supported.nicklength;
        }
        if (nick.length > maxNickLen) {
            return q.reject("Nick '" + nick + "' is too long. (Max: " + maxNickLen + ")");
        }
        if (nick === this.nick) {
            return q("Your nick is already '" + nick + "'.");
        }

        var d = q.defer();
        this.unsafeClient.once("nick", function(old, n) {
            d.resolve("Nick changed from '" + old + "' to '" + n + "'.");
        });
        this.unsafeClient.send("NICK", nick);
        return d.promise;
    }

    joinChannel(channel: string): Promise<String> {
        if (this.disabled) { return q("disabled"); }
        return joinChannel(this, channel);
    }

    leaveChannel(channel: string): Promise<Object> {
        if (this.disabled) { return q("disabled"); }
        if (!this.inst || this.inst.dead) {
            return q(); // we were never connected to the network.
        }
        if (Object.keys(this.unsafeClient.chans).indexOf(channel) === -1) {
            return q(); // we were never joined to it.
        }
        if (channel.indexOf("#") !== 0) {
            return q(); // PM room
        }
        var self = this;
        var defer = q.defer();
        this._removeChannel(channel);
        self.log.debug("Leaving channel %s", channel);
        this.unsafeClient.part(channel, "User left", function() {
            self.log.debug("Left channel %s", channel);
            defer.resolve();
        });

        return defer.promise;
    }

    sendAction(room: IrcRoom, action: IrcAction): Promise<Object> {
        if (this.disabled) { return q("disabled"); }
        this._keepAlive();
        switch (action.action) {
            case "message":
                return sendMessage(this, room, "message", action.text);
            case "notice":
                return sendMessage(this, room, "notice", action.text);
            case "emote":
                return sendMessage(this, room, "action", action.text);
            case "topic":
                return setTopic(this, room, action.text);
            default:
                this.log.error("Unknown action type: %s", action.action);
        }
        return q.reject("Unknown action type: %s", action.action);
    }

    whois(nick: string): Promise<Object> {
        if (this.disabled) {
            return q({
                server: this.server,
                nick: nick
            });
        }
        var defer = q.defer();
        var self = this;
        this.unsafeClient.whois(nick, function(whois) {
            if (!whois.user) {
                defer.reject("Cannot find nick on whois.");
                return;
            }
            defer.resolve({
                server: self.server,
                nick: nick
            });
        });
        return defer.promise;
    }

    getLastActionTs(): number {
        return this.lastActionTs;
    }

    _keepAlive() {
        this.lastActionTs = Date.now();
        var idleTimeout = this.server.getIdleTimeoutMs();
        if (idleTimeout > 0) {
            if (this._idleTimeout) {
                // stop the timeout
                clearTimeout(this._idleTimeout);
            }
            this.log.debug(
                "_keepAlive; Restarting %ss idle timeout", idleTimeout
            );
            // restart the timeout
            var self = this;
            this._idleTimeout = setTimeout(function() {
                self.log.info("Idle timeout has expired");
                if (self.server.shouldSyncMembershipToIrc("initial")) {
                    self.log.info(
                        "Not disconnecting because %s is mirroring matrix " +
                        "membership lists",
                        self.server.domain
                    );
                    return;
                }
                if (self.isBot) {
                    self.log.info("Not disconnecting because this is the bot");
                    return;
                }
                self.disconnect(
                    "Idle timeout reached: " + idleTimeout + "s"
                ).done(function() {
                    self.log.info("Idle timeout reached: Disconnected");
                }, function(e) {
                    self.log.error("Error when disconnecting: %s", JSON.stringify(e));
                });
            }, (1000 * idleTimeout));
        }
    }

    _removeChannel(channel: string) {
        var i = this.chanList.indexOf(channel);
        if (i === -1) {
            return;
        }
        this.chanList.splice(i, 1);
    }

    _addChannel(channel: string) {
        var i = this.chanList.indexOf(channel);
        if (i !== -1) {
            return; // already added
        }
        this.chanList.push(channel);
    }

    _onConnectionCreated(connInst: ConnectionInstance, nameInfo: Object,
                         callbacks: Object) {
        var self = this;

        // listen for a connect event which is done when the TCP connection is
        // established and set ident info (this is different to the connect() callback
        // in node-irc which actually fires on a registered event..)
        connInst.client.once("connect", function() {
            var localPort = -1;
            if (connInst.client.conn && connInst.client.conn.localPort) {
                localPort = connInst.client.conn.localPort;
            }
            if (localPort > 0) {
                ident.setMapping(nameInfo.username, localPort);
            }
        });

        connInst.onDisconnect = function() {
            self.emit("client-disconnected", self);
        };

        clientEvents.addHooks(this, connInst, callbacks);
    }
}
module.exports = BridgedClient;

var setTopic = function(bridgedClient, room, topic) {
    // join the room if we haven't already
    var defer = q.defer();
    joinChannel(bridgedClient, room.channel).done(function() {
        bridgedClient.log.info(
            "Setting topic to %s in channel %s", topic, room.channel
        );
        bridgedClient.unsafeClient.send("TOPIC", room.channel, topic);
        defer.resolve();
    }, function(e) {
        defer.reject(e);
    });
    return defer.promise;
};

var sendMessage = function(bridgedClient, room, msgType, text) {
    // join the room if we haven't already
    var defer = q.defer();
    msgType = msgType || "message";
    bridgedClient._connectDefer.promise.then(function() {
        return joinChannel(bridgedClient, room.channel);
    }).done(function() {
        if (msgType == "action") {
            bridgedClient.unsafeClient.action(room.channel, text);
        }
        else if (msgType == "notice") {
            bridgedClient.unsafeClient.notice(room.channel, text);
        }
        else if (msgType == "message") {
            bridgedClient.unsafeClient.say(room.channel, text);
        }
        defer.resolve();
    });
    return defer.promise;
};

function joinChannel(bridgedClient, channel, attemptCount) {
    attemptCount = attemptCount || 1;
    if (!bridgedClient.unsafeClient) {
        return q.reject("No client");
    }
    if (Object.keys(bridgedClient.unsafeClient.chans).indexOf(channel) !== -1) {
        return q(new IrcRoom(bridgedClient.server, channel));
    }
    if (channel.indexOf("#") !== 0) {
        // PM room
        return q(new IrcRoom(self.server, channel));
    }
    if (bridgedClient.server.isExcludedChannel(channel)) {
        return q.reject(channel + " is a do-not-track channel.");
    }
    var defer = q.defer();
    bridgedClient.log.debug("Joining channel %s", channel);
    bridgedClient._addChannel(channel);
    var client = bridgedClient.unsafeClient;
    // listen for failures to join a channel (e.g. +i, +k)
    var failFn = function(err) {
        if (!err || !err.args) { return; }
        var failCodes = [
            "err_nosuchchannel", "err_toomanychannels", "err_channelisfull",
            "err_inviteonlychan", "err_bannedfromchan", "err_badchannelkey"
        ];
        bridgedClient.log.error("Join channel %s : %s", channel, err);
        if (failCodes.indexOf(err.command) !== -1 &&
                err.args.indexOf(channel) !== -1) {
            bridgedClient.log.error(
                "Cannot track channel %s: %s", channel, err.command
            );
            client.removeListener("error", failFn);
            defer.reject(err);
        }
    };
    client.once("error", failFn);

    // add a timeout to try joining again
    setTimeout(function() {
        // promise isn't resolved yet and we still want to join this channel
        if (defer.promise.isPending() && bridgedClient.chanList.indexOf(channel) !== -1) {
            // we may have joined but didn't get the callback so check the client
            if (Object.keys(bridgedClient.unsafeClient.chans).indexOf(channel) !== -1) {
                // we're joined
                bridgedClient.log.debug(
                    "Timed out joining %s - didn't get callback but " +
                    "are now joined. Resolving.", channel);
                defer.resolve(new IrcRoom(bridgedClient.server, channel));
                return;
            }
            if (attemptCount >= 5) {
                defer.reject("Failed to join " + channel + " after multiple tries");
                return;
            }

            bridgedClient.log.error(
                "Timed out trying to join %s - trying again.", channel
            );
            // try joining again.
            attemptCount += 1;
            joinChannel(bridgedClient, channel, attemptCount).done(function(s) {
                defer.resolve(s);
            }, function(e) {
                defer.reject(e);
            });
        }
    }, JOIN_TIMEOUT_MS);

    bridgedClient.unsafeClient.join(channel, function() {
        bridgedClient.log.debug("Joined channel %s", channel);
        client.removeListener("error", failFn);
        var room = new IrcRoom(bridgedClient.server, channel);
        defer.resolve(room);
    });

    return defer.promise;
}
