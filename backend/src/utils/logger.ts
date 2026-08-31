import { env } from "../config/env";

type Level = "error" | "warn" | "info" | "debug";

const order: Record<Level, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function currentLevel(): Level {
  return env.LOG_LEVEL;
}

function enabled(level: Level): boolean {
  return order[level] <= order[currentLevel()];
}

function safeMeta(meta: unknown): string {
  if (meta === undefined) {
    return "";
  }
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return " [meta]";
  }
}

export const logger = {
  error(message: string, err?: unknown, meta?: Record<string, unknown>): void {
    if (!enabled("error")) {
      return;
    }
    if (err !== undefined) {
      console.error(message, err, meta !== undefined ? safeMeta(meta) : "");
    } else {
      console.error(message + (meta !== undefined ? safeMeta(meta) : ""));
    }
  },

  warn(message: string, meta?: Record<string, unknown>): void {
    if (!enabled("warn")) {
      return;
    }
    console.warn(message + (meta !== undefined ? safeMeta(meta) : ""));
  },

  info(message: string, meta?: Record<string, unknown>): void {
    if (!enabled("info")) {
      return;
    }
    console.log(message + (meta !== undefined ? safeMeta(meta) : ""));
  },

  debug(message: string, meta?: Record<string, unknown>): void {
    if (!enabled("debug")) {
      return;
    }
    console.log(`[debug] ${message}` + (meta !== undefined ? safeMeta(meta) : ""));
  },
};
