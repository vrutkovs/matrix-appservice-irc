"use strict";
var yaml = require("js-yaml");
var fs = require("fs");
var nopt = require("nopt");

var Validator = require("./build/config/validator");
var AppService = require("matrix-appservice").AppService;
var irc = require("./build/irc-appservice.js");
var hotReload = require("./build/hot-reload.js");

var opts = nopt({
    "generate-registration": Boolean,
    "skip-crc-check": Boolean,
    "config": String,
    "verbose": Boolean,
    "help": Boolean
}, {
    "c": "--config",
    "v": "--verbose",
    "s": "--skip-crc-check",
    "h": "--help"
});

if (opts.help) {
    var help = {
        "--config -c": (
            "Specify a config file to load. Will look for '"+
            Validator.getFileLocation()+"' if omitted."
        ),
        "--verbose -v": "Turn on verbose logging. This will log all incoming IRC events.",
        "--generate-registration": "Create the registration YAML for this application service.",
        "--skip-crc-check -s": (
            "Start the application service even if it detects a mismatched home server"+
            "\n      token. Only use this if you know what you're doing (e.g. a change"+
            "\n      to the config file which you know is safe to make without updating"+
            "\n      the application service registration)."
        ),
        "--help -h": "Display this help message."
    };
    console.log("Node.js IRC Application Service");
    console.log("\nOptions:")
    Object.keys(help).forEach(function(cmd) {
        console.log("  %s", cmd);
        console.log("      %s", help[cmd]);
    });
    console.log();
    process.exit(0);
}
if (opts.config) {
    Validator.setFileLocation(opts.config);
}

// load the config file
var config;
try {
    var configValidator = new Validator(Validator.getFileLocation());
    config = configValidator.validate();
}
catch (e) {
    console.error(e);
    process.exit(1);
    return;
}

if (!config) {
    console.error("Failed to validate config file.");
    process.exit(1);
    return;
}
config.logging.verbose = Boolean(opts["verbose"]);

if (Boolean(opts["generate-registration"])) {
    irc.generateRegistration(config).done(function(reg) {
        var fname = "appservice-registration-irc.yaml";
        reg.outputAsYaml(fname);
        console.log(" "+Array(74).join("="));
        console.log("   Generated registration file located at:");
        console.log("       %s", fname);
        console.log("");
        console.log("   The HS token this service looks for has been"+
            " updated. You MUST update");
        console.log("   the HS even if config.yaml was not modified."+
            " This file MUST be added");
        console.log("   to the destination home "+
            "server configuration file (e.g. 'homeserver.yaml'):");
        console.log("");
        console.log('       app_service_config_files: '+
            '["appservice-registration-irc.yaml"]');
        console.log(" "+Array(74).join("="));
        process.exit(0);
    });
}
else {
    hotReload.setup();
    irc.runService(new AppService(), config, Boolean(opts["skip-crc-check"])).done();
}
