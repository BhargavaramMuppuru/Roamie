"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const env_1 = require("../config/env");
const order = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};
function currentLevel() {
    return env_1.env.LOG_LEVEL;
}
function enabled(level) {
    return order[level] <= order[currentLevel()];
}
function safeMeta(meta) {
    if (meta === undefined) {
        return "";
    }
    try {
        return ` ${JSON.stringify(meta)}`;
    }
    catch {
        return " [meta]";
    }
}
exports.logger = {
    error(message, err, meta) {
        if (!enabled("error")) {
            return;
        }
        if (err !== undefined) {
            console.error(message, err, meta !== undefined ? safeMeta(meta) : "");
        }
        else {
            console.error(message + (meta !== undefined ? safeMeta(meta) : ""));
        }
    },
    warn(message, meta) {
        if (!enabled("warn")) {
            return;
        }
        console.warn(message + (meta !== undefined ? safeMeta(meta) : ""));
    },
    info(message, meta) {
        if (!enabled("info")) {
            return;
        }
        console.log(message + (meta !== undefined ? safeMeta(meta) : ""));
    },
    debug(message, meta) {
        if (!enabled("debug")) {
            return;
        }
        console.log(`[debug] ${message}` + (meta !== undefined ? safeMeta(meta) : ""));
    },
};
