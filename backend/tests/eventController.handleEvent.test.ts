import path from "path";
import { readFileSync } from "fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/utils/idempotency", () => ({
  claimEvent: vi.fn(),
}));

vi.mock("../src/services/reactionService", () => ({
  handleReaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/stateMachine", () => ({
  runStateMachine: vi.fn().mockResolvedValue(undefined),
}));

import { handleEvent } from "../src/controllers/eventController";
import * as idempotency from "../src/utils/idempotency";
import * as reactionService from "../src/services/reactionService";
import * as stateMachine from "../src/services/stateMachine";
import type { LinqWebhookEvent } from "../src/types/linq";

function loadFixture(name: string): LinqWebhookEvent {
  const full = path.join(process.cwd(), "tests/fixtures/webhooks", name);
  return JSON.parse(readFileSync(full, "utf8")) as LinqWebhookEvent;
}

describe("handleEvent", () => {
  beforeEach(() => {
    vi.mocked(idempotency.claimEvent).mockResolvedValue(true);
    vi.mocked(reactionService.handleReaction).mockClear();
    vi.mocked(stateMachine.runStateMachine).mockClear();
  });

  it("short-circuits duplicate events without handlers", async () => {
    vi.mocked(idempotency.claimEvent).mockResolvedValue(false);
    await handleEvent(loadFixture("message-received-nested.json"));
    expect(reactionService.handleReaction).not.toHaveBeenCalled();
    expect(stateMachine.runStateMachine).not.toHaveBeenCalled();
  });

  it("routes inbound messages to runStateMachine", async () => {
    await handleEvent(loadFixture("message-received-nested.json"));
    expect(stateMachine.runStateMachine).toHaveBeenCalledTimes(1);
    expect(reactionService.handleReaction).not.toHaveBeenCalled();
    expect(idempotency.claimEvent).toHaveBeenCalled();
  });

  it("routes reactions to handleReaction", async () => {
    await handleEvent(loadFixture("reaction-attendance.json"));
    expect(reactionService.handleReaction).toHaveBeenCalledTimes(1);
    expect(stateMachine.runStateMachine).not.toHaveBeenCalled();
    expect(idempotency.claimEvent).toHaveBeenCalled();
  });

  it("ignores self-originated messages", async () => {
    await handleEvent(loadFixture("message-from-me.json"));
    expect(reactionService.handleReaction).not.toHaveBeenCalled();
    expect(stateMachine.runStateMachine).not.toHaveBeenCalled();
    expect(idempotency.claimEvent).toHaveBeenCalled();
  });
});
