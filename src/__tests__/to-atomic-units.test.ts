import { describe, it, expect } from "vitest";
import { toAtomicUnits } from "../utils.js";

describe("toAtomicUnits — exact integer conversion", () => {
  it("converts 6-decimal amounts (USDC on most chains)", () => {
    expect(toAtomicUnits(0.05, 6)).toBe("50000");
    expect(toAtomicUnits(1.5, 6)).toBe("1500000");
    expect(toAtomicUnits(7, 6)).toBe("7000000");
    expect(toAtomicUnits(0.04, 6)).toBe("40000");
  });

  it("converts 18-decimal amounts EXACTLY (BSC USDC) — no float drift", () => {
    expect(toAtomicUnits(7, 18)).toBe("7000000000000000000");
    expect(toAtomicUnits(0.05, 18)).toBe("50000000000000000");
    expect(toAtomicUnits(1, 18)).toBe("1000000000000000000");
    expect(toAtomicUnits(0.04, 18)).toBe("40000000000000000");
    expect(toAtomicUnits(18.25, 18)).toBe("18250000000000000000");
  });

  it("handles a whole-number amount with zero decimals", () => {
    expect(toAtomicUnits(5, 0)).toBe("5");
  });

  it("truncates sub-atomic fractional digits (floor, not round)", () => {
    // 6-decimal: 0.0000005 has a 7th decimal digit, below atomic resolution
    expect(toAtomicUnits(0.0000005, 6)).toBe("0");
    // 0.123456789 at 6 decimals -> 123456 (the .789 atomic-fraction dropped)
    expect(toAtomicUnits(0.123456789, 6)).toBe("123456");
  });

  it("converts zero", () => {
    expect(toAtomicUnits(0, 6)).toBe("0");
    expect(toAtomicUnits(0, 18)).toBe("0");
  });
});
