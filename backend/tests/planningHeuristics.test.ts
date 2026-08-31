import { describe, it, expect } from "vitest";
import { messageLooksLikeTripPlanningDetail } from "../src/utils/planningHeuristics";

describe("messageLooksLikeTripPlanningDetail", () => {
  it("returns false for cheap chit-chat and hotel search phrasing", () => {
    expect(messageLooksLikeTripPlanningDetail("thanks")).toBe(false);
    expect(messageLooksLikeTripPlanningDetail("Find hotels")).toBe(false);
    expect(messageLooksLikeTripPlanningDetail("Can u show me more")).toBe(false);
    expect(messageLooksLikeTripPlanningDetail("Got it 👍🏻")).toBe(false);
  });

  it("returns true when dates, money, or prefs appear", () => {
    expect(messageLooksLikeTripPlanningDetail("20-23 April")).toBe(true);
    expect(messageLooksLikeTripPlanningDetail("600 for food and hotels I can spend extra 1000")).toBe(true);
    expect(messageLooksLikeTripPlanningDetail("Not really but want to explore more food options")).toBe(true);
    expect(messageLooksLikeTripPlanningDetail("Mid range")).toBe(true);
    expect(messageLooksLikeTripPlanningDetail("$600 total budget")).toBe(true);
  });
});
