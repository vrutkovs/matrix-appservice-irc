/*
 * Main entry point for this service.
 */
"use strict";
var q = require("q");
var crc = require("crc");

var AppServiceRegistration = require("matrix-appservice").AppServiceRegistration;
var matrixToIrc = require("./bridge/matrix-to-irc.js");
var ircToMatrix = require("./bridge/irc-to-matrix.js");
var membershiplists = require("./bridge/membershiplists.js");
var IrcServer = require("./irclib/server.js").IrcServer;
var ircLib = require("./irclib/irc.js");
var matrixLib = require("./mxlib/matrix");
var MatrixUser = require("./models/users").MatrixUser;
var store = require("./store");
var stats = require("./config/stats");
var ident = require("./irclib/ident");
var names = require("./irclib/names");
var logging = require("./logging");
var log = logging.get("main");

var globalServers = [];
var dbConnPromise = null;

var prepareDatabase = function(config) {
    if (dbConnPromise) {
        return dbConnPromise;
    }
    dbConnPromise = store.connectToDatabase(config.databaseUri).then(function() {
        // blow away all the previous configuration mappings, we're setting new
        // ones now.
        return store.rooms.removeConfigMappings();
    }).then(function() {
        var promises = [];
        Object.keys(config.servers).forEach(function(domain) {
            var server = new IrcServer(domain, config.servers[domain]);
            // set new mappings
            promises.push(store.setServerFromConfig(
                server, config.servers[domain]
            ));
            globalServers.push(server);
        });
        return q.all(promises);
    });
    return dbConnPromise;
};

module.exports.generateRegistration = function(config) {
    var generatedHsToken = module.exports.createHomeserverToken(config);
    var registration = new AppServiceRegistration(config.appService.appservice.url);
    registration.setAppServiceToken(config.appService.appservice.token);
    registration.setHomeserverToken(generatedHsToken);
    registration.setSenderLocalpart(config.appService.localpart);

    return prepareDatabase(config).then(function() {
        return store.rooms.getRoomIdsFromConfig();
    }).then(function(configRooms) {
        var i;
        // register room patterns
        for (i = 0; i < configRooms.length; i++) {
            registration.addRegexPattern("rooms", configRooms[i], false);
        }
        // register alias and user patterns
        for (i = 0; i < globalServers.length; i++) {
            var server = globalServers[i];
            // add an alias pattern for servers who want aliases exposed.
            if (server.createsDynamicAliases()) {
                registration.addRegexPattern(
                    "aliases", server.getAliasRegex(), true
                );
            }
            registration.addRegexPattern(
                "users", server.getUserRegex(), true
            );
        }
        // store the assigned HS token
        return store.config.set({
            hsToken: generatedHsToken
        });
    }).then(function() {
        return registration;
    });
};

module.exports.runService = function(appService, config, skipCrcCheck) {
    if (config.logging) {
        logging.configure(config.logging);
        logging.setUncaughtExceptionLogger(log);
    }
    if (config.statsd.hostname) {
        stats.setEndpoint(config.statsd);
    }
    if (config.ident.enabled) {
        ident.configure(config.ident);
        ident.run();
    }

    return prepareDatabase(config).then(function() {
        return store.config.get();
    }).then(function(storedConfig) {
        var dbToken = storedConfig ? storedConfig.hsToken : undefined;
        if (!dbToken) {
            throw new Error(
                "No stored homeserver token. Did you run --generate-registration ?"
            );
        }
        if (!skipCrcCheck && !module.exports.isValidHomeserverToken(dbToken, config)) {
            throw new Error(
                "Token " + dbToken + " failed the CRC - You have updated the " +
                "config file without calling --generate-registration.\n" +
                "Either skip this check (by adding -s) or generate a registration."
            );
        }
        if (globalServers.length === 0) {
            throw new Error("No servers specified.");
        }

        module.exports.startup(appService, globalServers, dbToken, config);
    });
};

module.exports.startup = function(as, servers, dbToken, config) {
    console.log("starting up");
    ircLib.setServers(servers);
    as.setHomeserverToken(dbToken);
    as.on("http-log", function(line) {
        log.info(line.replace(/\n/g, " "));
    });
    as.onAliasQuery = matrixToIrc.onAliasQuery;
    as.onUserQuery = matrixToIrc.onUserQuery;

    as.on("type:m.room.message", matrixToIrc.onMessage);
    as.on("type:m.room.topic", matrixToIrc.onMessage);
    as.on("type:m.room.member", function(event) {
        if (!event.content || !event.content.membership) {
            return;
        }
        var target = new MatrixUser(event.state_key, null, null);
        var sender = new MatrixUser(event.user_id, null, null);
        if (event.content.membership === "invite") {
            return matrixToIrc.onInvite(event, sender, target);
        }
        else if (event.content.membership === "join") {
            return matrixToIrc.onJoin(event, target);
        }
        else if (["ban", "leave"].indexOf(event.content.membership) !== -1) {
            return matrixToIrc.onLeave(event, target);
        }
    });

    matrixLib.setMatrixClientConfig({
        baseUrl: config.appService.homeserver.url,
        accessToken: config.appService.appservice.token,
        domain: config.appService.homeserver.domain,
        localpart: config.appService.localpart
    });
    ircLib.registerHooks({
        onMessage: ircToMatrix.onMessage,
        onPrivateMessage: ircToMatrix.onPrivateMessage,
        onJoin: ircToMatrix.onJoin,
        onPart: ircToMatrix.onPart,
        onMode: ircToMatrix.onMode
    });
    names.initQueue();
    as.listen(config.appService.http.port);

    log.info("Joining mapped Matrix rooms...");
    matrixLib.joinMappedRooms().then(function() {
        log.info("Connecting to IRC networks...");
        return ircLib.connect();
    }).done(function() {
        log.info("Syncing relevant membership lists...");
        servers.forEach(function(server) {
            membershiplists.sync(server);
        });
    });
};

module.exports.createHomeserverToken = function(config) {
    // make a checksum of the IRC server configuration. This will be checked against
    // the checksum created at the last "--generate-registration". If there is a
    // difference, it means that the user has failed to tell the HS of the new
    // registration, so we can refuse to start until that is done.
    var checksum = crc.crc32(JSON.stringify(config.servers)).toString(16);
    var randomPart = AppServiceRegistration.generateToken();
    return randomPart + "_crc" + checksum;
};

module.exports.isValidHomeserverToken = function(storedToken, liveConfig) {
    // The stored token contains a CRC. The live config can be CRC'd.
    // They should match.
    var checksum = crc.crc32(JSON.stringify(liveConfig.servers)).toString(16);
    var storedChecksum = storedToken.split("_crc")[1];
    if (!storedChecksum) {
        log.warn("Stored token does not have a CRC");
        return true;
    }
    if (checksum !== storedChecksum) {
        log.error("CRC Failure: %s != %s", checksum, storedChecksum);
    }
    return checksum === storedChecksum;
};
