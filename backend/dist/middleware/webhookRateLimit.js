"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhookRateLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const env_1 = require("../config/env");
exports.webhookRateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60_000,
    limit: env_1.env.WEBHOOK_RATE_LIMIT_PER_MINUTE,
    standardHeaders: true,
    legacyHeaders: false,
});
