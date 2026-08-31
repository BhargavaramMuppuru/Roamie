import { describe, it, expect } from "vitest";
import { parseChatRosterFromResponseBody } from "../src/services/linqClient";

describe("parseChatRosterFromResponseBody", () => {
  it("reads handles from nested data.chat (Linq Partner GET chat shape)", () => {
    const rows = parseChatRosterFromResponseBody({
      data: {
        chat: {
          id: "9ea77642-b6ec-48c7-9d97-cb4778490b73",
          handles: [
            {
              id: "h1",
              handle: "+16504687798",
              is_me: true,
              name: "Roamie Bot",
            },
            {
              id: "h2",
              handle: "+14474480657",
              is_me: false,
              display_name: "Alex",
            },
          ],
        },
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      user_id: "h1",
      handle: "+16504687798",
      name: "Roamie Bot",
      display_name: undefined,
    });
    expect(rows[1]).toEqual({
      user_id: "h2",
      handle: "+14474480657",
      name: undefined,
      display_name: "Alex",
    });
  });

  it("reads flat Chat JSON with handles array", () => {
    const rows = parseChatRosterFromResponseBody({
      id: "chat-1",
      handles: [{ id: "x", handle: "+10000000000" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.handle).toBe("+10000000000");
  });

  it("prefers participants array when present", () => {
    const rows = parseChatRosterFromResponseBody({
      participants: [{ user_id: "u1", handle: "+19998887777", name: "Pat" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Pat");
  });
});
