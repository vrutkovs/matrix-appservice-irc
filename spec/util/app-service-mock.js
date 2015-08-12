"use strict";
var q = require("q");
var AppService = require("matrix-appservice").AppService;

module.exports.create = function() {
    var as = new AppService();
    as.listen = function() {}; // monkey patch a blank listener
    as.on = jasmine.createSpy("AppService.on(eventType, fn)");

    var onFunctions = {
        // event type: [fn, fn]
    };
    as.on.andCallFake(function(eventType, fn) {
        if (!onFunctions[eventType]) {
            onFunctions[eventType] = [];
        }
        onFunctions[eventType].push(fn);
    });
    as._trigger = function(eventType, content) {
        var promises = [];
        if (onFunctions[eventType]) {
            for (var i = 0; i < onFunctions[eventType].length; i++) {
                promises.push(onFunctions[eventType][i](content));
            }
        }
        if (promises.length === 1) {
            return promises[0];
        }
        return q.all(promises);
    };

    return as;
};
