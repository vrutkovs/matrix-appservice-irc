/*
 * Provides storage for dynamically created IRC channel/room ID mappings, in
 * addition to other things like the home server token.
 */
"use strict";
import IrcServer from "./irclib/server"

var q = require("q");

var rooms = require("./models/rooms");
var IrcRoom = rooms.IrcRoom;
var MatrixRoom = rooms.MatrixRoom;
var MatrixUser = require("./models/users").MatrixUser;
var IrcUser = require("./models/users").IrcUser;
var log = require("./logging").get("database");
var toIrcLowerCase = require("./irclib/formatting").toIrcLowerCase;
var UserBridgeStore = require("matrix-appservice-bridge").UserBridgeStore;
var RoomBridgeStore = require("matrix-appservice-bridge").RoomBridgeStore;
var BridgeMatrixUser = require("matrix-appservice-bridge").MatrixUser;
var JungleUser = require("matrix-appservice-bridge").JungleUser;
var JungleRoom = require("matrix-appservice-bridge").JungleRoom;
var BridgeMatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var userStore, roomStore = null;

var Datastore = require("nedb");

var collection = {
    rooms: { db: null, loc: "/rooms.db", defer: q.defer() },
    config: { db: null, loc: "/config.db", defer: q.defer() },
    users: { db: null, loc: "/users.db", defer: q.defer() }
};

var dbPromise = null;

var serverMappings = {
    // domain : IrcServer
};

var getCollection = function(name: string): Object {
    return collection[name].db;
};

// wrapper to use promises
var callbackFn = function(d, err, result) {
    if (err) {
        d.reject(err);
    }
    else {
        d.resolve(result);
    }
};

var upsert = function(database, d, query, updateVals) {
    database.update(query, updateVals, {upsert: true}, function(err, result) {
        callbackFn(d, err, result);
    });
};

/**
 * @param {!Object} database : The database collection to search.
 * @param {Deferred} d : The deferred to resolve/reject on completion.
 * @param {!Object} query : The query to execute.
 * @param {boolean} multiple : True to return multiple entries.
 * @param {Function=} transformFn : Optional. The function to invoke to transform
 * each result.
 */
var select = function(database, d, query, multiple, transformFn) {
    if (multiple) {
        database.find(query, function(err, docs) {
            callbackFn(d, err, transformFn ? transformFn(docs) : docs);
        });
    }
    else {
        database.findOne(query, function(err, docs) {
            callbackFn(d, err, transformFn ? transformFn(docs) : docs);
        });
    }
};

/**
 * Connect to the NEDB database.
 * @param {string} databaseUri : The URI which contains the path to the db directory.
 * @return {Promise} Resolved when connected to the database.
 */
module.exports.connectToDatabase = function(databaseUri: string): Promise {
    if (dbPromise) {
        return dbPromise;
    }
    log.info("connectToDatabase -> %s", databaseUri);

    if (databaseUri.indexOf("nedb://") !== 0) {
        return q.reject(
            "Must use a nedb:// URI of the form nedb://databasefolder"
        );
    }
    var baseDbName = databaseUri.substring("nedb://".length);

    var promises = [];
    Object.keys(collection).forEach(function(dbKey) {
        promises.push(collection[dbKey].defer.promise);

        collection[dbKey].db = new Datastore({
            filename: baseDbName + collection[dbKey].loc,
            autoload: true,
            onload: function(err) {
                if (err) {
                    collection[dbKey].defer.reject(err);
                }
                else {
                    if (dbKey === "users") {
                        userStore = new UserBridgeStore(collection[dbKey].db);
                    }
                    else if (dbKey === "rooms") {
                        roomStore = new RoomBridgeStore(collection[dbKey].db);
                    }
                    collection[dbKey].defer.resolve();
                }
            }
        });
    });

    dbPromise = q.all(promises);

    return dbPromise;
};

/**
 * Wait for a connection to the database. You must have called
 * {@link connectToDatabase} at least once.
 * @return {Promise} Resolved when connected to the database. Null if
 * connectToDatabase was not called.
 */
module.exports.waitForDatabase = function(): ?Promise {
    return dbPromise;
};

/*
 * Creates the mappings specified in the config and remembers the server to
 * return.
 */
module.exports.setServerFromConfig = function(server: IrcServer, serverConfig: Object) {
    serverMappings[server.domain] = server;
    var promises = [];
    var channels = Object.keys(serverConfig.mappings);
    for (var i = 0; i < channels.length; i++) {
        var channel = channels[i];
        for (var k = 0; k < serverConfig.mappings[channel].length; k++) {
            var ircRoom = new IrcRoom(server, channel);
            var mxRoom = new MatrixRoom(
                serverConfig.mappings[channel][k]
            );
            promises.push(module.exports.rooms.set(ircRoom, mxRoom, true));
        }
    }
    return q.all(promises);
};

module.exports.config = {
    set: function(info: Object): Promise {
        var d = q.defer();
        upsert(getCollection("config"), d, {},
            {
                $set: info
            }
        );
        return d.promise;
    },

    get: function(): Promise {
        var d = q.defer();
        select(getCollection("config"), d, {}, false);
        return d.promise;
    }
}

function mkJungleRoomId(chan, domain) {
    return chan + " " + domain;
}

function toJungleRoom(ircRoom) {
    var jungleRoom = new JungleRoom(
        mkJungleRoomId(toIrcLowerCase(ircRoom.channel), ircRoom.server.domain)
    );
    jungleRoom.set("addr", ircRoom.server.domain);
    jungleRoom.set("chan", toIrcLowerCase(ircRoom.channel));
    return jungleRoom;
}

module.exports.rooms = {
    /**
     * Persists an IRC <--> Matrix room mapping in the database.
     * @param {IrcRoom} ircRoom : The IRC room to store.
     * @param {MatrixRoom} matrixRoom : The Matrix room to store.
     * @param {boolean} fromConfig : True if this mapping is from the config yaml.
     * @return {Promise}
     */
    set: function(ircRoom: IrcRoom, matrixRoom: MatrixRoom,
                  fromConfig: boolean): Promise {
        var addr = ircRoom.server ? ircRoom.server.domain : undefined;
        fromConfig = Boolean(fromConfig);

        log.info("rooms.set (id=%s, addr=%s, chan=%s, config=%s)",
            matrixRoom.roomId, addr, ircRoom.channel, fromConfig);

        var jungleRoom = toJungleRoom(ircRoom);
        var mxRoom = new BridgeMatrixRoom(matrixRoom.roomId);

        return roomStore.linkRooms(mxRoom, jungleRoom, {
            fromConfig: fromConfig,
            type: "channel"
        });
    },

    /**
     * Retrieve a list of IRC rooms for a given room ID.
     * @param {string} roomId : The room ID to get mapped IRC channels.
     * @return {Promise<Array<IrcRoom>>} A promise which resolves to a list of
     * rooms.
     */
    getIrcChannelsForRoomId: function(roomId: string): Promise {
        return roomStore.getLinkedJungleRooms(roomId).then(function(jungleRooms) {
            var ircRooms = [];
            jungleRooms.forEach(function(room) {
                var server = serverMappings[room.get("addr")];
                var ircRoom = new IrcRoom(server, room.get("chan"));
                if (server) {
                    ircRooms.push(ircRoom);
                }
            });
            return ircRooms;
        });
    },

    /**
     * Retrieve a list of Matrix rooms for a given server and channel.
     * @param {IrcServer} server : The server to get rooms for.
     * @param {string} channel : The channel to get mapped rooms for.
     * @return {Promise<Array<MatrixRoom>>} A promise which resolves to a list of rooms.
     */
    getMatrixRoomsForChannel: function(server: IrcServer,
                                       channel: string): Promise<Array<MatrixRoom>> {
        channel = toIrcLowerCase(channel); // all stored in lower case

        return roomStore.getLinkedMatrixRooms(
            mkJungleRoomId(channel, server.domain)
        ).then(function(mxRooms) {
            return mxRooms.map(function(r) {
                return new MatrixRoom(r.getId());
            });
        });
    },

    // NB: We need this to be different to set() because for IRC you send the
    // PM to two separate 'rooms' ('to' room is the nick), and because we want to
    // clobber uid:uid pairs.
    setPmRoom: function(ircRoom: IrcRoom, matrixRoom: MatrixRoom, userId: string,
                        virtualUserId: string): Promise {
        var addr = (
            ircRoom.server ? ircRoom.server.domain : undefined
        );

        log.info("setPmRoom (id=%s, addr=%s chan=%s real=%s virt=%s)",
            matrixRoom.roomId, addr, ircRoom.channel, userId,
            virtualUserId);

        var mxRoom = new BridgeMatrixRoom(matrixRoom.roomId);
        var jungleRoom = toJungleRoom(ircRoom);

        return roomStore.linkRooms(mxRoom, jungleRoom, {
            real_user_id: userId,
            virtual_user_id: virtualUserId,
            kind: "pm"
        });
    },

    getMatrixPmRoom: function(realUserId: string,
                              virtualUserId: string): Promise<MatrixRoom> {
        return roomStore.getLinksByData({
            real_user_id: realUserId,
            virtual_user_id: virtualUserId,
            kind: "pm"
        }).then(function(links) {
            if (!links || links.length === 0) {
                return null;
            }
            var link = links[0];
            return new MatrixRoom(link.matrix);
        });
    },

    getTrackedChannelsForServer: function(ircAddr: string): Promise<Array<string>> {
        return roomStore.getJungleRooms({
            addr: ircAddr
        }).then(function(jungleRooms) {
            return jungleRooms.map(function(room) {
                return room.get("chan");
            });
        });
    },

    getRoomIdsFromConfig: function(): Promise<Array<string>> {
        return roomStore.getLinksByData({
            fromConfig: true
        }).then(function(links) {
            return links.map(function(link) {
                return link.matrix;
            });
        });
    },

    // removes all mappings with from_config = true
    removeConfigMappings: function(): Promise {
        log.info("removeConfigMappings");

        return roomStore.getLinksByData({
            fromConfig: true
        }).then(function(links) {
            var promises = [];
            links.forEach(function(link) {
                promises.push(roomStore.unlinkRoomIds(link.matrix, link.jungle));
            });
            return q.allSettled(promises);
        });
    },

    /**
     * Retrieve a stored admin room based on the room's ID.
     * @param {String} roomId : The room ID of the admin room.
     * @return {Promise} Resolved when the room is retrieved.
     */
    getAdminRoomById: function(roomId: string): Promise<MatrixRoom> {
        return roomStore.getMatrixRoom(roomId).then(function(room) {
            if (!room || room.get("kind") !== "admin") {
                return null;
            }
            return new MatrixRoom(room.getId());
        });
    },

    /**
     * Stores a unique admin room for a given user ID.
     * @param {MatrixRoom} room : The matrix room which is the admin room for this user.
     * @param {String} userId : The user ID who is getting an admin room.
     * @return {Promise} Resolved when the room is stored.
     */
    storeAdminRoom: function(room: MatrixRoom, userId: string): Promise {
        log.info("storeAdminRoom (id=%s, user_id=%s)", room.roomId, userId);

        var mxRoom = new BridgeMatrixRoom(room.roomId);
        mxRoom.set("kind", "admin");
        mxRoom.set("admin_room_for", userId);

        return roomStore.setMatrixRoom(mxRoom, {
            kind: "admin",
            admin_room_for: userId
        });
    }
};

module.exports.users = {
    get: function(userLocalpart: string): Promise<MatrixUser> {
        if (!userStore) { return q.reject("No userStore instance"); }
        var d = q.defer();
        userStore.getByMatrixLocalpart(userLocalpart).done(function(usr) {
            if (!usr) {
                d.resolve(null);
                return;
            }
            d.resolve(new MatrixUser(usr.getId(), usr.getDisplayName(), true));
        }, function(e) {
            d.reject(e);
        });
        return d.promise;
    },

    set: function(user: MatrixUser, localpart: string, displayName: string,
                  setDisplayName: boolean): Promise {
        if (!userStore) { return q.reject("No userStore instance"); }
        log.info(
            "storeUser (user_id=%s, localpart=%s display_name=%s " +
            "set_display_name=%s)",
            user.userId, localpart, displayName, setDisplayName
        );

        var mxUser = new BridgeMatrixUser(user.userId);
        mxUser.setDisplayName(displayName);
        return userStore.setMatrixUser(mxUser);
    }
};

function mkJungleId(domain, userId) {
    return domain + " " + userId;
}

module.exports.ircClients = {
    get: function(userId: string, domain: string): Promise<IrcUser> {
        if (!userStore) {
            return q.reject("No userStore instance");
        }
        var server = serverMappings[domain];
        if (!server) {
            return q.reject("No known server for domain " + domain);
        }
        var d = q.defer();
        userStore.getJungleUser(mkJungleId(domain, userId)).then(function(jungleUser) {
            if (!jungleUser) {
                d.resolve(null);
                return;
            }
            d.resolve(new IrcUser(
                server, jungleUser.get("nick"), true, jungleUser.get("password"),
                jungleUser.get("username")
            ));
        });
        return d.promise;
    },
    set: function(userId: string, ircUser: IrcUser): Promise {
        if (!userStore) {
            return q.reject("No userStore instance");
        }
        var d = q.defer();
        log.info("Storing " + ircUser.toString() + " on behalf of " + userId);

        var jungleUser = new JungleUser(mkJungleId(ircUser.server.domain, userId));
        jungleUser.set("nick", ircUser.nick);
        jungleUser.set("password", ircUser.password);
        jungleUser.set("domain", ircUser.server.domain);
        jungleUser.set("username", ircUser.username);
        jungleUser.set("user_id", userId);
        var matrixUser = new BridgeMatrixUser(userId);
        userStore.setJungleUser(jungleUser).then(function() {
            return userStore.linkUsers(matrixUser, jungleUser);
        }).done(function() {
            d.resolve();
        }, function(err) {
            d.reject(err);
        });
        return d.promise;
    },
    getByUsername: function(domain: string, username: string):
                            Promise<?{ircUser: IrcUser, userId: string}> {
        if (!userStore) {
            return q.reject("No userStore instance");
        }
        var server = serverMappings[domain];
        if (!server) {
            return q.reject("No known server with domain "+domain);
        }
        var d = q.defer();
        var jungleUser = null;
        userStore.getByJungleData({
            domain: domain,
            username: username
        }).then(function(jUsers) {
            if (jUsers.length === 0) {
                return q([]);
            }
            jungleUser = jUsers[0];
            return userStore.getMatrixLinks(jungleUser.getId());
        }).done(function(matrixUserIds) {
            var userId = matrixUserIds[0];
            if (!jungleUser || !userId) {
                d.resolve(null);
                return;
            }
            var usr = new IrcUser(
                server, jungleUser.get("nick"), true,
                jungleUser.get("password"), jungleUser.get("username")
            );
            d.resolve({
                ircUser: usr,
                userId: userId
            });
        }, function(e) {
            d.reject(e);
        });
        return d.promise;
    }
};
