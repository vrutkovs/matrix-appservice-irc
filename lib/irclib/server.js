/* @flow */
/*
 * Represents a single IRC server from config.yaml
 */
"use strict";
var logging = require("../logging");
var IrcUser = require("../models/users").IrcUser;
var log = logging.get("irc-server");

class IrcServer {
    domain: string;
    config: Object;

    /**
     * Construct a new IRC Server.
     * @constructor
     * @param {string} domain : The IRC network address
     * @param {Object} serverConfig : The config options for this network.
     */
    constructor(domain: string, serverConfig: Object) {
        this.domain = domain;
        this.config = serverConfig;
    }

    isBotEnabled(): boolean {
        return this.config.botConfig.enabled;
    }

    getJoinRule(): string {
        return this.config.dynamicChannels.joinRule;
    }

    getPort(): number {
        return this.config.port;
    }

    isInWhitelist(userId: string): boolean {
        return this.config.dynamicChannels.whitelist.indexOf(userId) !== -1;
    }

    useSsl(): boolean {
        return Boolean(this.config.ssl);
    }

    getIdleTimeoutMs(): number {
        return this.config.ircClients.idleTimeout;
    }

    getMaxClients(): number {
        return this.config.ircClients.maxClients;
    }

    shouldPublishRooms(): boolean {
        return this.config.dynamicChannels.published;
    }

    allowsNickChanges(): boolean {
        return this.config.ircClients.allowNickChanges;
    }

    createBotIrcUser(): IrcUser {
        return new IrcUser(
            this, this.config.botConfig.nick, true, this.config.botConfig.password
        );
    }

    isExcludedChannel(channel: string): boolean {
        return this.config.dynamicChannels.exclude.indexOf(channel) !== -1;
    }

    hasInviteRooms(): boolean {
        return (
            this.config.dynamicChannels.enabled && this.getJoinRule() === "invite"
        )
    }

    // check if this server dynamically create rooms with aliases.
    createsDynamicAliases(): boolean {
        return (
            this.config.dynamicChannels.enabled &&
            this.config.dynamicChannels.createAlias
        );
    }

    // check if this server dynamically creates rooms which are joinable via an
    // alias only.
    createsPublicAliases(): boolean {
        return (
            this.createsDynamicAliases() &&
            this.getJoinRule() === "public"
        );
    }

    allowsPms(): boolean {
        return this.config.privateMessages.enabled;
    }

    shouldSyncMembershipToIrc(kind: string, roomId: ?string): boolean {
        return this._shouldSyncMembership(kind, roomId, true);
    }

    shouldSyncMembershipToMatrix(kind: string, channel: ?string): boolean {
        return this._shouldSyncMembership(kind, channel, false);
    }

    _shouldSyncMembership(kind: string, identifier: ?string, toIrc: boolean): boolean {
        if (["incremental", "initial"].indexOf(kind) === -1) {
            throw new Error("Bad kind: " + kind);
        }
        if (!this.config.membershipLists.enabled) {
            return false;
        }
        var shouldSync = this.config.membershipLists.global[
            toIrc ? "matrixToIrc" : "ircToMatrix"
        ][kind];

        if (!identifier) {
            return shouldSync;
        }

        // check for specific rules for the room id / channel
        if (toIrc) {
            // room rules clobber global rules
            this.config.membershipLists.rooms.forEach(function(r) {
                if (r.room === identifier && r.matrixToIrc) {
                    shouldSync = r.matrixToIrc[kind];
                }
            });
        }
        else {
            // channel rules clobber global rules
            this.config.membershipLists.channels.forEach(function(chan) {
                if (chan.channel === identifier && chan.ircToMatrix) {
                    shouldSync = chan.ircToMatrix[kind];
                }
            });
        }

        return shouldSync;
    }

    shouldJoinChannelsIfNoUsers(): boolean {
        return this.config.botConfig.joinChannelsIfNoUsers;
    }

    isMembershipListsEnabled(): boolean {
        return this.config.membershipLists.enabled;
    }

    getUserLocalpart(nick: string): string {
        // the template is just a literal string with special vars; so find/replace
        // the vars and strip the @
        var uid = this.config.matrixClients.userTemplate.replace(
            /\$SERVER/g, this.domain
        );
        return uid.replace(/\$NICK/g, nick).substring(1);
    }

    claimsUserId(userId: string): boolean {
        // the server claims the given user ID if the ID matches the user ID template.
        var regex = templateToRegex(
            this.config.matrixClients.userTemplate,
            {
                "$SERVER": this.domain
            },
            {
                "$NICK": "(.*)"
            },
            ":.*"
        );
        return new RegExp(regex).test(userId);
    }

    getNickFromUserId(userId: string): ?string {
        // extract the nick from the given user ID
        var regex = templateToRegex(
            this.config.matrixClients.userTemplate,
            {
                "$SERVER": this.domain
            },
            {
                "$NICK": "(.*)"
            },
            ":.*"
        );
        var match = new RegExp(regex).exec(userId);
        if (!match) {
            return null;
        }
        return match[1];
    }

    claimsAlias(alias: string): boolean {
        // the server claims the given alias if the alias matches the alias template
        var regex = templateToRegex(
            this.config.dynamicChannels.aliasTemplate,
            {
                "$SERVER": this.domain
            },
            {
                "$CHANNEL": "(.*)"
            },
            ":.*"
        );
        return new RegExp(regex).test(alias);
    }

    getChannelFromAlias(alias: string): ?string {
        // extract the channel from the given alias
        var regex = templateToRegex(
            this.config.dynamicChannels.aliasTemplate,
            {
                "$SERVER": this.domain
            },
            {
                "$CHANNEL": "([^:]*)"
            },
            ":.*"
        );
        var match = new RegExp(regex).exec(alias);
        if (!match) {
            return null;
        }
        log.info("getChannelFromAlias -> %s -> %s -> %s", alias, regex, match[1]);
        return match[1];
    }

    getNick(userId: string, displayName: string): string {
        var localpart = userId.substring(1).split(":")[0];
        var display = displayName || localpart;
        var template = this.config.ircClients.nickTemplate;
        var nick = template.replace(/\$USERID/g, userId);
        nick = nick.replace(/\$LOCALPART/g, localpart);
        nick = nick.replace(/\$DISPLAY/g, display);
        return nick;
    }

    getAliasRegex(): string {
        return templateToRegex(
            this.config.dynamicChannels.aliasTemplate,
            {
                "$SERVER": this.domain  // find/replace $server
            },
            {
                "$CHANNEL": ".*"  // the nick is unknown, so replace with a wildcard
            },
            // The regex applies to the entire alias, so add a wildcard after : to
            // match all domains.
            ":.*"
        );
    }

    getUserRegex(): string {
        return templateToRegex(
            this.config.matrixClients.userTemplate,
            {
                "$SERVER": this.domain  // find/replace $server
            },
            {
                "$NICK": ".*"  // the nick is unknown, so replace with a wildcard
            },
            // The regex applies to the entire user ID, so add a wildcard after : to
            // match all domains.
            ":.*"
        );
    }
}

function templateToRegex(template: string, literalVars: Object, regexVars: Object,
                         suffix: string) {
    // The 'template' is a literal string with some special variables which need
    // to be find/replaced.
    var regex = template;
    Object.keys(literalVars).forEach(function(varPlaceholder) {
        regex = regex.replace(
            new RegExp(escapeRegExp(varPlaceholder), 'g'),
            literalVars[varPlaceholder]
        );
    });

    // at this point the template is still a literal string, so escape it before
    // applying the regex vars.
    regex = escapeRegExp(regex);
    // apply regex vars
    Object.keys(regexVars).forEach(function(varPlaceholder) {
        regex = regex.replace(
            // double escape, because we bluntly escaped the entire string before
            // so our match is now escaped.
            new RegExp(escapeRegExp(escapeRegExp(varPlaceholder)), 'g'),
            regexVars[varPlaceholder]
        );
    });

    suffix = suffix || "";
    return regex + suffix;
}

function escapeRegExp(string) {
    // https://developer.mozilla.org/en/docs/Web/JavaScript/Guide/Regular_Expressions
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = IrcServer;
