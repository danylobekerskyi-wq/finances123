import { describe, expect, it, vi } from "vitest";
import { CoinbaseReferenceClient } from "../src/referencePrice.js";

describe("CoinbaseReferenceClient USD build", () => {
  it("uses the fresh public BTC-USD level-1 order book directly", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      expect(url).toContain("/products/BTC-USD/book?level=1");
      return new Response(
        JSON.stringify({
          bids: [["60000", "1", 1]],
          asks: [["60010", "1", 1]],
          time: "2026-08-22T15:00:00.000Z",
          auction_mode: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new CoinbaseReferenceClient({ fetchImpl });
    await expect(client.getReferencePrice("BTC/USD")).resolves.toEqual({
      priceCad: 60005,
      bidCad: 60000,
      askCad: 60010,
      capturedAt: "2026-08-22T15:00:00.000Z",
      source: "Coinbase Exchange",
    });
  });

  it("maps SOL/USD directly to SOL-USD", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      expect(String(input)).toContain("/products/SOL-USD/book?level=1");
      return new Response(
        JSON.stringify({
          bids: [["180.00", "1", 1]],
          asks: [["180.10", "1", 1]],
          time: "2026-08-22T15:01:00.000Z",
          auction_mode: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new CoinbaseReferenceClient({ fetchImpl });
    const result = await client.getReferencePrice("SOL/USD");
    expect(result.priceCad).toBeCloseTo(180.05);
    expect(result.source).toBe("Coinbase Exchange");
  });

  it("rejects an unavailable Coinbase USD product instead of doing FX fallback", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 })) as typeof fetch;
    const client = new CoinbaseReferenceClient({ fetchImpl });
    await expect(client.getReferencePrice("DOT/USD")).rejects.toThrow(
      "Coinbase HTTP 404 for DOT-USD",
    );
  });
});
