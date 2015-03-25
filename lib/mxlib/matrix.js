/*
 * Public API for interacting with Matrix.
 */
"use strict";
var sdk = require("./cs-extended-sdk");
var models = require("../models");
var actions = require("../actions");
var log = require("../logging").get("matrix");
var q = require("q");

var globalClient = undefined;
var hsDomain = undefined;
var stripHtmlTags = /(<([^>]+)>)/ig;

var actionToMsgtypes = {
    message: "m.text",
    emote: "m.emote",
    notice: "m.notice"
};

var getClientAs = function(userId) {
    if (userId) {
        globalClient.userId = userId;
        sdk.userId = userId;
    }
    else {
        globalClient.userId = undefined;
        sdk.userId = undefined;
        sdk.accessToken = globalClient.credentials.accessToken;
    }
    return globalClient;
};

var mkUserId = function(localpart) {
    return "@"+localpart+":"+hsDomain;
};

var getAliasLocalpart = function(alias) {
    return alias.split(":")[0].substring(1);
};

module.exports.sendNoticeRaw = function(roomId, userId, text) {
    var defer = q.defer();
    var client = getClientAs(userId);
    var content = {
         msgtype: "m.notice",
         body: text
    };
    return client.sendMessage(roomId, content);
};

module.exports.createRoomWithUser = function(fromUserId, toUserId, name) {
    var defer = q.defer();
    var client = getClientAs(fromUserId);
    var room = undefined;
    client.createRoom({
        name: name,
        visibility: "private"
    }).then(function(response) {
        room = models.createMatrixRoom(response.room_id);
        return client.invite(response.room_id, toUserId);
    }).then(function() {
        defer.resolve(room);
    }).done(undefined, function(err) {
        defer.reject(err);
    });

    return defer.promise;
}

module.exports.createRoomWithAlias = function(alias, name, topic) {
    var aliasLocalpart = getAliasLocalpart(alias);
    var defer = q.defer();
    var client = getClientAs();
    // if alias already used (M_UNKNOWN), query it and use that. Return a Room.
    client.createRoom({
        room_alias_name: aliasLocalpart,
        name: name,
        topic: topic,
        visibility: "public"
    }).then(function(response) {
        log.info("createRoom -> %s", JSON.stringify(response));
        defer.resolve(models.createMatrixRoom(response.room_id));
    }, function(err) {
        log.info("createRoom err -> %s", JSON.stringify(err));
        if (err.errcode === "M_UNKNOWN") {
            // alias already taken, must be us. Join the room alias.
            return client.joinRoom(alias);
        }
        else {
            defer.reject("Failed to create room: %s", JSON.stringify(err));
        }
    }).then(function(response) {
        log.info("createRoom join -> %s", JSON.stringify(response));
        defer.resolve(models.createMatrixRoom(response.room_id));
    })

    return defer.promise;
};

module.exports.leaveRoom = function(userId, roomId) {
    var client = getClientAs(userId);
    return client.leave(roomId);
};

module.exports.isPmRoom = function(userId, roomId, pmRoomUserId) {
    var defer = q.defer();
    var client = getClientAs(userId);
    client.roomState(roomId).then(function(response) {
        var joinedMembers = 0;
        var pmMemberPresent = false;
        for (var i=0; i<response.length; i++) {
            var event = response[i];
            if (event.type === "m.room.member" && 
                    event.content.membership === "join") {
                joinedMembers += 1;
                if (pmRoomUserId === event.state_key) {
                    pmMemberPresent = true;
                }
            }
        }
        defer.resolve(joinedMembers === 2 && pmMemberPresent);
    },
    function(err) {
        defer.reject(err);
    });
    return defer.promise;
};

module.exports.setTopic = function(room, from, topic) {
    var defer = q.defer();
    var client = getClientAs(from.userId);
    client.setRoomTopic(room.roomId, topic).then(function(suc) {
        log.info("setTopic: %s", JSON.stringify(suc));
        defer.resolve(suc);
    },
    function(err) {
        // XXX should really be trying to join like on sendMessage.
        log.error("setTopic: %s", JSON.stringify(err));
        defer.reject(err);
    });
    return defer.promise;
};

var sendMessage = function(room, from, msgtype, text) {
    msgtype = msgtype || "m.text";
    var content = {
        msgtype: msgtype,
        body: text
    };
    return module.exports.sendMessageEvent(room, from, content);
};

var sendHtml = function(room, from, msgtype, html) {
    msgtype = msgtype || "m.text";
    var fallback = html.replace(stripHtmlTags, "");
    var content = {
        msgtype: msgtype,
        body: fallback,
        format: "org.matrix.custom.html",
        formatted_body: html
    };
    return module.exports.sendMessageEvent(room, from, content);
};

module.exports.sendAction = function(room, from, action) {
    log.info("sendAction -> %s", JSON.stringify(action));
    if (actionToMsgtypes[action.action]) {
        var msgtype = actionToMsgtypes[action.action];
        if (action.formattedText) {
            return sendHtml(room, from, msgtype, action.formattedText);
        }
        return sendMessage(room, from, msgtype, action.text);
    }
};

module.exports.sendMessageEvent = function(room, from, content, doNotJoin) {
    var defer = q.defer();
    var client = getClientAs(from.userId);
    client.sendMessage(room.roomId, content).then(function(suc) {
        log.info("sendMessage: %s", JSON.stringify(suc));
        defer.resolve(suc);
    },
    function(err) {
        if (err.errcode == "M_FORBIDDEN" && !doNotJoin) {
            // try joining the room
            client.joinRoom(room.roomId).done(function(response) {
                module.exports.sendMessageEvent(room, from, content, true);
            }, function(err) {
                log.error("sendMessageEvent: Couldn't join room: %s",
                    JSON.stringify(err));
                defer.reject(err);
            });
        }
        else {
            log.error("sendMessageEvent: %s", JSON.stringify(err));
            defer.reject(err);
        }
    });
    return defer.promise;
};

module.exports.getMatrixUser = function(userLocalpart) {
    // TODO optimise this by not trying to register users which
    // have already been made
    var defer = q.defer();

    var client = getClientAs();
    client.register("m.login.application_service", {
        user: userLocalpart
    }).done(function(response) {
        defer.resolve(models.createMatrixUser(response.user_id));
    },
    function(err) {
        if (err.errcode == "M_USER_IN_USE") {
            // made it before
            defer.resolve(models.createMatrixUser(mkUserId(userLocalpart)));
        }
        else {
            log.error("getMatrixUser -> %s : %s", userLocalpart,
                JSON.stringify(err));
            defer.reject({});
        }
    });
    return defer.promise;
};

module.exports.joinRoom = function(roomId, matrixUser) {
    var client = getClientAs(matrixUser.userId);
    return client.joinRoom(roomId);
};

module.exports.setMatrixClientConfig = function(config) {
    globalClient = sdk.cs.createClient(config);
    hsDomain = config.domain;
};

module.exports.decodeMxc = function(mxcUri) {
    // looks like mxc://matrix.org/mxfsKGddpulqOiEVUcNcRUcb
    var client = getClientAs();
    return client.credentials.baseUrl + "/_matrix/media/v1/download/" + 
        mxcUri.substring(6);
};