import { describe, it, expect } from "vitest";
import {
  buildExpenseSplitFields,
  extractExplicitNameAmountPairs,
  extractSplitAmongNames,
  extractSplitBonuses,
  stripSplitBonusClauses,
} from "../src/services/intentService";

describe("extractSplitAmongNames", () => {
  it("parses split between / among", () => {
    expect(extractSplitAmongNames("uber $20 split between Sam and Jordan")).toEqual(["Sam", "Jordan"]);
    expect(extractSplitAmongNames("$30 split among Alex, Blake, Casey")).toEqual(["Alex", "Blake", "Casey"]);
  });

  it("parses owed by and to", () => {
    expect(extractSplitAmongNames("$15 lunch owed by Sam and Pat")).toEqual(["Sam", "Pat"]);
    expect(extractSplitAmongNames("Add uber $10 to Chris")).toEqual(["Chris"]);
  });

  it("parses for … when it looks like people", () => {
    expect(extractSplitAmongNames("$45 dinner for Morgan and Riley")).toEqual(["Morgan", "Riley"]);
  });

  it("does not treat for dinner as names when single food word", () => {
    expect(extractSplitAmongNames("$20 for dinner")).toBeUndefined();
  });

  it("does not capture subgroup phrase as names", () => {
    expect(extractSplitAmongNames("for the ski subgroup")).toBeUndefined();
  });
});

describe("splitBonuses (uneven add-ons)", () => {
  it("parses for Name +$X and strips before resolving split-between names", () => {
    const msg = "$20 uber split between Sam and Jordan and for Jordan +$10";
    expect(extractSplitBonuses(msg)).toEqual([{ name: "Jordan", addAmount: 10 }]);
    const stripped = stripSplitBonusClauses(msg);
    expect(extractSplitAmongNames(stripped)).toEqual(["Sam", "Jordan"]);
  });

  it("merges duplicate names in bonuses", () => {
    const msg = "split between A and B and for A +$5 and for A +$3";
    expect(extractSplitBonuses(msg)).toEqual([{ name: "A", addAmount: 8 }]);
  });
});

describe("splitExplicitAmounts (custom $ per person)", () => {
  it("parses Name $X pairs that sum to receipt total", () => {
    const msg = "$20 uber Sam $7 Jordan $13";
    const pairs = extractExplicitNameAmountPairs(msg);
    expect(pairs).toEqual([
      { name: "Sam", amount: 7 },
      { name: "Jordan", amount: 13 },
    ]);
    const sum = pairs.reduce((s, p) => s + p.amount, 0);
    const fields = buildExpenseSplitFields(msg, 20);
    expect(sum).toBe(20);
    expect(fields.splitExplicitAmounts).toEqual(pairs);
  });

  it("does not use explicit mode when shares don’t match receipt total", () => {
    const msg = "$20 uber Sam $5 Jordan $5";
    const fields = buildExpenseSplitFields(msg, 20);
    expect(fields.splitExplicitAmounts).toBeUndefined();
  });
});
