/* @flow */
/*
 * An action is an event that can be bridged between protocols. A typical
 * example would be a Message, but this could be a topic change, a nick change,
 * etc.
 *
 * The purpose of this file is to provide a standard representation for actions,
 * and provide conversion facilities between them.
 */
"use strict";

var ircFormatting = require("../irclib/formatting");
var matrixLib = require("../mxlib/matrix");
var log = require("../logging").get("actions");
var ACTIONS = {
    MESSAGE: "message",
    EMOTE: "emote",
    TOPIC: "topic",
    NOTICE: "notice",
    IMAGE: "image",
    FILE: "file"
};

class IrcAction {
    action: string;
    protocol: string;
    text: string;

    constructor(action: string, text: string) {
        this.action = action;
        this.text = text;
        this.protocol = "irc";
    }
}

class MatrixAction {
    action: string;
    protocol: string;
    body: string;
    htmlBody: ?string;

    constructor(action: string, body: string, htmlBody: ?string) {
        this.action = action;
        this.body = body;
        this.htmlBody = htmlBody;
        this.protocol = "matrix";
    }
}

module.exports.irc = {
    createMessage: function(text) {
        return new IrcAction(ACTIONS.MESSAGE, text);
    },
    createEmote: function(text) {
        return new IrcAction(ACTIONS.EMOTE, text);
    },
    createNotice: function(notice) {
        return new IrcAction(ACTIONS.NOTICE, notice);
    },
    createTopic: function(topic) {
        return new IrcAction(ACTIONS.TOPIC, topic);
    }
};

module.exports.matrix = {
    createNotice: function(text) {
        return new MatrixAction(ACTIONS.NOTICE, text);
    },
    createAction: function(event) {
        event.content = event.content || {};

        if (event.type === "m.room.message") {
            var fmtText = (event.content.format === "org.matrix.custom.html" ?
                event.content.formatted_body : undefined);
            var body = event.content.body;

            var msgTypeToAction = {
                "m.emote": ACTIONS.EMOTE,
                "m.notice": ACTIONS.NOTICE,
                "m.image": ACTIONS.IMAGE,
                "m.file": ACTIONS.FILE
            };
            var action = msgTypeToAction[event.content.msgtype] || ACTIONS.MESSAGE;
            if (event.content.msgtype === "m.image" ||
                    event.content.msgtype === "m.file") {
                var fileSize = "";
                if (event.content.info && event.content.info.size &&
                        typeof event.content.info.size === "number") {
                    fileSize = " (" + Math.round(event.content.info.size / 1024) +
                        "KB)";
                }
                body = matrixLib.decodeMxc(event.content.url) +
                        " - " + event.content.body + fileSize;
            }
            var mxAction = new MatrixAction(action, body, fmtText);
            return mxAction;
        }
        else if (event.type === "m.room.topic") {
            return new MatrixAction(ACTIONS.TOPIC, event.content.topic);
        }
    }
};

module.exports.toMatrix = function(action: IrcAction): ?MatrixAction {
    if (action.protocol !== "irc") {
        log.error("Bad src protocol: %s", action.protocol);
        return null;
    }
    switch (action.action) {
        case ACTIONS.MESSAGE:
        case ACTIONS.EMOTE:
        case ACTIONS.NOTICE:
            var fmtText = ircFormatting.ircToHtml(action.text);
            var htmlBody = (fmtText !== action.text) ? fmtText : null;
            return new MatrixAction(action.action, action.text, htmlBody);
        case ACTIONS.TOPIC:
            return new MatrixAction(action.action, action.text);
        default:
            log.error("IRC->MX: Unknown action: %s", action.action);
            return null;
    }
};

module.exports.toIrc = function(action: MatrixAction): ?IrcAction {
    if (action.protocol !== "matrix") {
        log.error("Bad src protocol: %s", action.protocol);
        return null;
    }
    switch (action.action) {
        case ACTIONS.MESSAGE:
        case ACTIONS.EMOTE:
        case ACTIONS.NOTICE:
            var text = action.body;
            if (action.htmlBody) {
                text = ircFormatting.htmlToIrc(action.htmlBody);
            }
            return new IrcAction(action.action, text);
        case ACTIONS.IMAGE:
            return new IrcAction(ACTIONS.NOTICE, "Posted an Image: " + action.body);
        case ACTIONS.FILE:
            return new IrcAction(ACTIONS.NOTICE, "Posted a File: " + action.body);
        case ACTIONS.TOPIC:
            return new IrcAction(ACTIONS.TOPIC, action.body);
        default:
            log.error("MX->IRC: Unknown action: %s", action.action);
            return null;
    }
};
