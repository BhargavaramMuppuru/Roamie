import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: (...args: unknown[]) => createMock(...args),
      },
    };
  },
}));

import { formatTripWeatherChatReply } from "../src/services/weatherService";

describe("weatherService (OpenAI-only, no external weather API)", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({
      choices: [
        {
          message: {
            content:
              "Demo City: • May 20: Mild, highs near 80°F.\n\n(Model guidance — not a live forecast.)",
          },
        },
      ],
    });
  });

  it("returns guidance when destination is missing", async () => {
    const text = await formatTripWeatherChatReply({});
    expect(text).toMatch(/destination/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("builds a reply when OpenAI returns an outlook", async () => {
    const text = await formatTripWeatherChatReply({
      destination: "Demo City",
      startDate: new Date("2026-06-01T12:00:00.000Z"),
      endDate: new Date("2026-06-03T12:00:00.000Z"),
    });
    expect(text).toContain("Demo City");
    expect(text).toContain("Mild");
    expect(createMock).toHaveBeenCalled();
  });
});
