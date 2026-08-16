import { describe, it, expect, vi, beforeEach } from "vitest";
import { armTabOpen } from "../tab.js";
import { HistoricalV1MigrationRequiredError } from "../types.js";

const FAC = "https://facilitator.test";

describe("armTabOpen", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rejects historical V1 deterministically without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = armTabOpen(
      FAC,
      "Swig1",
      1000n,
      "solana:mainnet",
      "Seller1",
    );
    await expect(result).rejects.toBeInstanceOf(
      HistoricalV1MigrationRequiredError,
    );
    await expect(result).rejects.toThrow(/native_tab_v1_migration_required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
