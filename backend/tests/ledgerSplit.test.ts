import { describe, it, expect } from "vitest";
import { isSplitFullyPaid, splitBalanceDue, SPLIT_PAY_EPS } from "../src/services/ledgerService";

describe("ledger split math", () => {
  it("computes balance due", () => {
    expect(splitBalanceDue(10, 3)).toBe(7);
    expect(splitBalanceDue(10, 10)).toBe(0);
  });

  it("detects fully paid within epsilon", () => {
    expect(isSplitFullyPaid(10, 10)).toBe(true);
    expect(isSplitFullyPaid(10, 10 - SPLIT_PAY_EPS / 2)).toBe(true);
    expect(isSplitFullyPaid(10, 5)).toBe(false);
  });
});
