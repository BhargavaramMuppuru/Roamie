"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const webhook_1 = __importDefault(require("./routes/webhook"));
const admin_1 = __importDefault(require("./routes/admin"));
const env_1 = require("./config/env");
const logger_1 = require("./utils/logger");
const scheduler_1 = require("./services/scheduler");
const app = (0, express_1.default)();
app.set("trust proxy", env_1.env.TRUST_PROXY ? 1 : false);
app.use((0, helmet_1.default)({
    contentSecurityPolicy: false,
}));
app.use(express_1.default.json({
    limit: "10mb",
    verify: (req, _res, buffer) => {
        req.rawBody = buffer.toString("utf8");
    },
}));
app.get("/", (_req, res) => {
    res.send("Roamie backend is running");
});
app.use("/webhook", webhook_1.default);
app.use("/admin", admin_1.default);
app.listen(env_1.env.PORT, () => {
    logger_1.logger.info(`Roamie is listening on port ${env_1.env.PORT}`);
    (0, scheduler_1.startScheduler)();
});
