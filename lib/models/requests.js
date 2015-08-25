/* @flow */
/*
 * A request is effectively an incoming action from either Matrix or IRC. This
 * is specifically NOT HTTP requests given transactions can have many events
 * in them, and IRC is just a TCP stream.
 *
 * Each request needs to be accounted for, so this file manages the requests
 * over its lifetime, specifically for logging.
 */
"use strict";

var matrixLib = require("../mxlib/matrix");
var ircLib = require("../irclib/irc");
var stats = require("../config/stats");
var logging = require("../logging");
var log = logging.get("req");
var RequestFactory = require("matrix-appservice-bridge").RequestFactory;

var DELAY_TIMEOUT_MS = 10000;
var DEAD_TIMEOUT_MS = 1000 * 60 * 5; // 5min

// valid error codes to fail a request
module.exports.ERR_VIRTUAL_USER = "virtual-user";

var outstandingRequests = {
    // request_id : Request
};

var factory = new RequestFactory();

factory.addDefaultResolveCallback(function(req, resolve) {
    var duration = req.getDuration();
    req.log.debug("SUCCESS - %s ms", duration);
    stats.request(req.isFromIrc, "success", duration);
    delete outstandingRequests[req.getId()];
});

factory.addDefaultRejectCallback(function(req, err) {
    var duration = req.getDuration();
    delete outstandingRequests[req.getId()];
    if (err === module.exports.ERR_VIRTUAL_USER) {
        req.log.debug("IGNORED - %s ms (Sender is a virtual user.)",
            duration);
        return;
    }
    stats.request(req.isFromIrc, "fail", duration);
    req.log.debug("FAILED - %s ms (%s)", duration, JSON.stringify(err));
});

factory.addDefaultTimeoutCallback(function(request) {
    var delta = request.getDuration();
    stats.request(request.isFromIrc, "delay", delta);
    request.log.error(
        "DELAYED - Taking too long. (>%sms)", DELAY_TIMEOUT_MS
    );
    // start another much longer timer after which point we decide that
    // the request is dead in the water
    setTimeout(function() {
        if (!request.getPromise().isPending()) {
            return;
        }
        request.log.error(
            "DEAD - Removing request (>%sms)",
            (DELAY_TIMEOUT_MS + DEAD_TIMEOUT_MS)
        );
        stats.request(request.isFromIrc, "fail", delta);
    }, DEAD_TIMEOUT_MS);
}, DELAY_TIMEOUT_MS);

// find an outstanding request
module.exports.findRequest = function(requestId: string): ?Request {
    return outstandingRequests[requestId];
};

/**
 * Create a new request.
 * @param {boolean} isFromIrc : True if this request originated from IRC.
 * @return {Request} A new request.
 */
module.exports.newRequest = function(isFromIrc: boolean): Request {
    var request = factory.newRequest();
    outstandingRequests[request.getId()] = request;

    // FIXME: cruft to keep the rest of the project happy.
    var logger = logging.newRequestLogger(log, request.getId(), isFromIrc);
    request.log = logger;
    request.isFromIrc = isFromIrc;
    request.mxLib = matrixLib.getMatrixLibFor(request);
    request.ircLib = ircLib.getIrcLibFor(request);
    // expose an error handler to prevent defer boilerplate leaking everywhere
    request.errFn = function(err) {
        if (err.stack) {
            request.log.error(err.stack);
        }
        request.reject(err);
    };
    request.sucFn = function() {
        request.resolve();
    };

    return request;
};
