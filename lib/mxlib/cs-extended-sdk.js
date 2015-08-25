/*
 * Wraps the matrix-js-sdk to provide Extended CS API functionality as outlined
 * in http://matrix.org/docs/spec/#client-server-v2-api-extensions
 */
"use strict";

var matrixSdk = require("matrix-js-sdk");
var logger = require("../logging").get("matrix-js-sdk");
var ClientFactory = require("matrix-appservice-bridge").ClientFactory;

var factory = new ClientFactory({
    sdk: matrixSdk
});
factory.setLogFunction(function(text, isError) {
    if (isError) {
        logger.error(text);
        return;
    }
    logger.debug(text);
});

module.exports.getClientAs = function(userId, request) {
    return factory.getClientAs(userId, request);
};

module.exports.setClientConfig = function(config) {
    factory.configure(config.baseUrl, config.accessToken);
};
