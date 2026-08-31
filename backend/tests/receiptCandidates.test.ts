import { describe, it, expect } from "vitest";
import { listReceiptImageCandidates } from "../src/services/receiptParseService";

describe("listReceiptImageCandidates", () => {
  it("orders image extensions before ambiguous URLs and drops obvious video paths", () => {
    const urls = [
      "https://x.com/v.mp4",
      "https://x.com/a.jpg",
      "https://cdn/signed-no-ext?token=1",
      "https://x.com/b.png",
    ];
    expect(listReceiptImageCandidates(urls)).toEqual([
      "https://x.com/a.jpg",
      "https://x.com/b.png",
      "https://cdn/signed-no-ext?token=1",
    ]);
  });

  it("returns empty for undefined or empty", () => {
    expect(listReceiptImageCandidates(undefined)).toEqual([]);
    expect(listReceiptImageCandidates([])).toEqual([]);
  });
});
