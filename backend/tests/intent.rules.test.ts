import { describe, it, expect, vi, beforeEach } from "vitest";

const { openaiCreateMock } = vi.hoisted(() => ({
  openaiCreateMock: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: openaiCreateMock,
      },
    };
  },
}));

import { parseIntent } from "../src/services/intentService";

/** Primary parse is always OpenAI; mock UNKNOWN so regex/heuristic fallback is exercised. */
const unknownJson = { choices: [{ message: { content: '{"intent":"UNKNOWN"}' } }] };

describe("parseIntent (OpenAI primary, regex fallback)", () => {
  beforeEach(() => {
    openaiCreateMock.mockReset();
    openaiCreateMock.mockResolvedValue(unknownJson);
  });

  it("parses CREATE_TRIP from natural trip text via rule fallback", async () => {
    const text = "Miami trip May 15 to May 18, 6 people, $1200 budget";
    const intent = await parseIntent(text);
    expect(intent.intent).toBe("CREATE_TRIP");
    expect(intent.destination).toMatch(/Miami/i);
    expect(intent.budget).toBe(1200);
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("parses CREATE_TRIP with same-month day range (no space before dash)", async () => {
    const intent = await parseIntent("NYC trip April 20-25 budget $1500");
    expect(intent.intent).toBe("CREATE_TRIP");
    expect(intent.destination).toMatch(/NYC/i);
    expect(intent.budget).toBe(1500);
    expect(intent.startDate).toBe(`${new Date().getFullYear()}-04-20`);
    expect(intent.endDate).toBe(`${new Date().getFullYear()}-04-25`);
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("parses CREATE_TRIP without the word trip (destination + dates + budget)", async () => {
    const intent = await parseIntent("Vegas May 20-23 budget $1000");
    expect(intent.intent).toBe("CREATE_TRIP");
    expect(intent.destination).toMatch(/Vegas/i);
    expect(intent.budget).toBe(1000);
    expect(intent.startDate).toBe(`${new Date().getFullYear()}-05-20`);
    expect(intent.endDate).toBe(`${new Date().getFullYear()}-05-23`);
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("parses CREATE_TRIP from go-to phrasing without trip keyword", async () => {
    const intent = await parseIntent("we want to go to Vegas May 20-23 budget $1000");
    expect(intent.intent).toBe("CREATE_TRIP");
    expect(intent.destination).toMatch(/Vegas/i);
    expect(intent.budget).toBe(1000);
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("parses CREATE_TRIP from 'trip for <destination>' wording", async () => {
    const intent = await parseIntent("let’s plan a trip for Miami");
    expect(intent.intent).toBe("CREATE_TRIP");
    expect(intent.destination).toMatch(/Miami/i);
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("parses CONFIRM_ATTENDANCE for yes", async () => {
    const intent = await parseIntent("yes I'm in");
    expect(intent.intent).toBe("CONFIRM_ATTENDANCE");
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("parses CONFIRM_ATTENDANCE for skin-tone thumb emoji", async () => {
    const intent = await parseIntent("👍🏻");
    expect(intent.intent).toBe("CONFIRM_ATTENDANCE");
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("parses ADD_EXPENSE from $ and keyword", async () => {
    const intent = await parseIntent("Paid $42.50 for uber");
    expect(intent.intent).toBe("ADD_EXPENSE");
    expect(intent.amount).toBe(42.5);
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("parses ADD_EXPENSE when the amount comes after the meal (natural phrasing)", async () => {
    const intent = await parseIntent("Lunch at cheesecake $20");
    expect(intent.intent).toBe("ADD_EXPENSE");
    expect(intent.amount).toBe(20);
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("parses REQUEST_SETTLEMENT", async () => {
    const intent = await parseIntent("who owes what, settle up?");
    expect(intent.intent).toBe("REQUEST_SETTLEMENT");
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("parses REQUEST_WEATHER via rule fallback", async () => {
    expect((await parseIntent("what's the weather?")).intent).toBe("REQUEST_WEATHER");
    openaiCreateMock.mockClear();
    expect((await parseIntent("forecast for the trip")).intent).toBe("REQUEST_WEATHER");
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("parses REQUEST_HOTELS for plural hotels and natural phrasing", async () => {
    expect((await parseIntent("Find hotels")).intent).toBe("REQUEST_HOTELS");
    expect((await parseIntent("find a hotel")).intent).toBe("REQUEST_HOTELS");
    expect(openaiCreateMock).toHaveBeenCalledTimes(2);
  });

  it("parses REQUEST_MORE_HOTELS when asking for different stays", async () => {
    expect((await parseIntent("more hotel options please")).intent).toBe("REQUEST_MORE_HOTELS");
    expect((await parseIntent("these are not my preferences, want more hotels")).intent).toBe(
      "REQUEST_MORE_HOTELS",
    );
    expect(openaiCreateMock).toHaveBeenCalledTimes(2);
  });

  it("parses SET_DISPLAY_NAME for my name is …", async () => {
    const intent = await parseIntent("my name is Alex");
    expect(intent.intent).toBe("SET_DISPLAY_NAME");
    expect(intent.manualDisplayName).toMatch(/Alex/i);
    expect(openaiCreateMock).not.toHaveBeenCalled();
  });

  it("parses SET_CONTACT_NAMES for phone — name roster", async () => {
    const intent = await parseIntent("names: +14474480657 — Sam, +17033325179 — Jordan");
    expect(intent.intent).toBe("SET_CONTACT_NAMES");
    expect(intent.phoneNamePairs?.length).toBe(2);
    expect(openaiCreateMock).not.toHaveBeenCalled();
  });

  it("parses DELETE_EXPENSE via regex before OpenAI", async () => {
    const intent = await parseIntent("delete last expense");
    expect(intent.intent).toBe("DELETE_EXPENSE");
    expect(intent.targetExpenseIndex).toBe(1);
    expect(openaiCreateMock).not.toHaveBeenCalled();
  });

  it("parses EDIT_EXPENSE for update-by-description phrasing", async () => {
    const intent = await parseIntent("update uber to $20");
    expect(intent.intent).toBe("EDIT_EXPENSE");
    expect(intent.targetExpenseDescription).toMatch(/uber/i);
    expect(intent.editExpenseNewAmount).toBe(20);
    expect(openaiCreateMock).not.toHaveBeenCalled();
  });

  it("parses EDIT_EXPENSE for previous-expense phrasing", async () => {
    const intent = await parseIntent("edit my previous expense to $20");
    expect(intent.intent).toBe("EDIT_EXPENSE");
    expect(intent.targetExpenseIndex).toBe(1);
    expect(intent.editExpenseNewAmount).toBe(20);
    expect(openaiCreateMock).not.toHaveBeenCalled();
  });

  it("parses CREATE_GROUP_TRIP when phone numbers appear", async () => {
    const intent = await parseIntent("invite +14155552671 and +14155552672 to the trip");
    expect(intent.intent).toBe("CREATE_GROUP_TRIP");
    expect(intent.invitees?.length).toBeGreaterThanOrEqual(1);
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("uses AI primary result when rules do not match", async () => {
    openaiCreateMock.mockResolvedValue({
      choices: [{ message: { content: '{"intent":"REQUEST_ITINERARY"}' } }],
    });
    const intent = await parseIntent("something ambiguous xyz123");
    expect(intent.intent).toBe("REQUEST_ITINERARY");
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });
});
