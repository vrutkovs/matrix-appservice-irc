/* @flow */
/*
 * A room ID specifies a Matrix room uniquely.
 * A server domain and a channel specifies an IRC room uniquely.
 * A "Room" is a combination of a unique Matrix room and a unique IRC room.
 * A Matrix room can have many Rooms (bridged to many irc channels).
 * An IRC channel can have many Rooms (bridged to many Matrix rooms).
 * Some of these bridges can be hard-coded by the launch configuration.
 * Some of these bridges are dynamically generated if:
 *  - A Matrix user invites a Virtual IRC User to a room (PM)
 *  - A Matrix user tries to join a room alias which maps to an IRC channel.
 */
"use strict";
import IrcServer from "./../irclib/server";

class IrcRoom {
    protocol: string;
    server: IrcServer;
    channel: string;

    /**
     * Construct a new IRC room.
     * @constructor
     * @param {IrcServer} server : The IRC server which contains this room.
     * @param {String} channel : The channel this room represents.
     */
    constructor(server: IrcServer, channel: string) {
        this.protocol = "irc";
        this.server = server;
        this.channel = channel;
    }
}

class MatrixRoom {
    protocol: string;
    roomId: string;
    /**
     * Construct a new Matrix room.
     * @constructor
     * @param {String} roomId : The room ID for this Matrix room.
     */
    constructor(roomId: string) {
        this.protocol = "matrix";
        this.roomId = roomId;
    }
}

module.exports.MatrixRoom = MatrixRoom;
module.exports.IrcRoom = IrcRoom;
