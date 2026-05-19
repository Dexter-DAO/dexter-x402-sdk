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

  it("is exact for amounts the old float implementation drifted on", () => {
    // These amounts are TRUE regression guards: the old
    // Math.floor(amount * Math.pow(10, 18)) produced wrong trailing digits
    // because amount * 1e18 lands on a non-representable double.
    //   0.07 * 1e18 -> 70000000000000010  (exact 70000000000000000)
    //   0.14 * 1e18 -> 140000000000000020 (exact 140000000000000000)
    //   0.55 * 1e18 -> 550000000000000060 (exact 550000000000000000)
    //   0.57 * 1e18 -> 569999999999999940 (exact 570000000000000000)
    //   1.11 * 1e18 -> 1110000000000000100 (exact 1110000000000000000)
    // The expected values below are the exact integers (cents x 10^16).
    expect(toAtomicUnits(0.07, 18)).toBe("70000000000000000");
    expect(toAtomicUnits(0.14, 18)).toBe("140000000000000000");
    expect(toAtomicUnits(0.55, 18)).toBe("550000000000000000");
    expect(toAtomicUnits(0.57, 18)).toBe("570000000000000000");
    expect(toAtomicUnits(1.11, 18)).toBe("1110000000000000000");
  });

  it("converts zero", () => {
    expect(toAtomicUnits(0, 6)).toBe("0");
    expect(toAtomicUnits(0, 18)).toBe("0");
  });

  it("expands exponential-notation inputs correctly", () => {
    // Number.toString() emits exponential form for very small/large values;
    // toAtomicUnits must expand it before BigInt parsing.
    expect(toAtomicUnits(5e-7, 18)).toBe("500000000000"); // 0.0000005 × 10^18
    expect(toAtomicUnits(1e-7, 18)).toBe("100000000000"); // 0.0000001 × 10^18
    expect(toAtomicUnits(5e-7, 6)).toBe("0");             // below 6-dec atomic resolution
    expect(toAtomicUnits(1e21, 6)).toBe("1000000000000000000000000000"); // 1e21 × 10^6
  });

  it("rejects negative amounts", () => {
    expect(() => toAtomicUnits(-1, 6)).toThrow();
    expect(() => toAtomicUnits(-0.05, 18)).toThrow();
  });

  it("rejects non-finite amounts and invalid decimals", () => {
    expect(() => toAtomicUnits(NaN, 6)).toThrow();
    expect(() => toAtomicUnits(Infinity, 6)).toThrow();
    expect(() => toAtomicUnits(-Infinity, 6)).toThrow();
    expect(() => toAtomicUnits(1, -1)).toThrow();
    expect(() => toAtomicUnits(1, 1.5)).toThrow();
  });

  it("treats -0 as zero", () => {
    expect(toAtomicUnits(-0, 6)).toBe("0");
  });
});
