import path from "path";
import { readFileSync } from "fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createWebhookTestApp } from "./helpers/testApp";
import { signWebhookPayload } from "./helpers/signWebhook";
import * as eventController from "../src/controllers/eventController";

vi.mock("../src/controllers/eventController", () => ({
  handleEvent: vi.fn().mockResolvedValue(undefined),
}));

describe("POST /webhook/linq", () => {
  const app = createWebhookTestApp();
  const secret = process.env.LINQ_WEBHOOK_SECRET!;

  beforeEach(() => {
    vi.mocked(eventController.handleEvent).mockClear();
  });

  function postSignedFixture(filename: string) {
    const rawBody = readFileSync(path.join(process.cwd(), "tests/fixtures/webhooks", filename), "utf8");
    const timestamp = "1740000000";
    const signature = signWebhookPayload(secret, timestamp, rawBody);
    return request(app)
      .post("/webhook/linq")
      .set("Content-Type", "application/json")
      .set("x-webhook-timestamp", timestamp)
      .set("x-webhook-signature", signature)
      .send(rawBody);
  }

  it("returns 401 when signature is wrong", async () => {
    const rawBody = '{"event_id":"x"}';
    const timestamp = "1740000000";
    await request(app)
      .post("/webhook/linq")
      .set("Content-Type", "application/json")
      .set("x-webhook-timestamp", timestamp)
      .set("x-webhook-signature", "deadbeef")
      .send(rawBody)
      .expect(401);
    expect(eventController.handleEvent).not.toHaveBeenCalled();
  });

  it("returns 200 and forwards JSON body to handleEvent when signature is valid", async () => {
    await postSignedFixture("message-received-nested.json").expect(200);
    expect(eventController.handleEvent).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(eventController.handleEvent).mock.calls[0][0] as { event_id?: string };
    expect(payload.event_id).toBe("evt-msg-001");
  });

  it("accepts x-linq-signature and x-linq-timestamp headers", async () => {
    const rawBody = readFileSync(
      path.join(process.cwd(), "tests/fixtures/webhooks", "reaction-attendance.json"),
      "utf8",
    );
    const timestamp = "1740000001";
    const signature = signWebhookPayload(secret, timestamp, rawBody);
    await request(app)
      .post("/webhook/linq")
      .set("Content-Type", "application/json")
      .set("x-linq-timestamp", timestamp)
      .set("x-linq-signature", signature)
      .send(rawBody)
      .expect(200);
    expect(eventController.handleEvent).toHaveBeenCalled();
  });
});
