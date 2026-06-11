import { describe, it, expect, vi, beforeEach } from "vitest";
import { armTabOpen } from "../tab.js";

const FAC = "https://facilitator.test";

describe("armTabOpen", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("POSTs /tab/open and resolves on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ success: true, armed: true, signature: "SIG" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(armTabOpen(FAC, "Swig1", 1000n, "solana:mainnet")).resolves.toEqual({ armed: true, signature: "SIG" });
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${FAC}/tab/open`);
  });

  it("THROWS tab_open_unprotected when the facilitator rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ success: false, error: "vault_gate_failed" }),
    }));
    await expect(armTabOpen(FAC, "Swig1", 1000n, "solana:mainnet"))
      .rejects.toThrow(/tab_open_unprotected.*vault_gate_failed/);
  });
});
