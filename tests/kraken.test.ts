import { describe, expect, it, vi } from "vitest";
import {
  KrakenClient,
  isKrakenUnavailablePairError,
  signKrakenRequest,
} from "../src/kraken.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("KrakenClient", () => {
  it("parses ticker fields from Kraken's envelope", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        error: [],
        result: {
          XXBTZUSD: {
            a: ["101.00", "1", "1"],
            b: ["100.00", "1", "1"],
            c: ["100.50", "1"],
            v: ["10", "20"],
            l: ["90", "91"],
            h: ["110", "111"],
            o: "95",
          },
        },
      }),
    );
    const client = new KrakenClient({ fetchImpl: fetchImpl as typeof fetch });

    await expect(client.getTicker("BTC/USD")).resolves.toMatchObject({
      pair: "BTC/USD",
      ask: 101,
      bid: 100,
      last: 100.5,
      volume24h: 20,
    });
  });

  it("uses the Kraken SOL/USD market code for an expanded paper pair", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      expect(String(input)).toContain("pair=SOLUSD");
      return jsonResponse({
        error: [],
        result: {
          SOLUSD: {
            a: ["201.00", "1", "1"],
            b: ["200.00", "1", "1"],
            c: ["200.50", "1"],
            v: ["10", "20"],
            l: ["190", "191"],
            h: ["210", "211"],
            o: "195",
          },
        },
      });
    });
    const client = new KrakenClient({ fetchImpl: fetchImpl as typeof fetch });

    await expect(client.getTicker("SOL/USD")).resolves.toMatchObject({
      pair: "SOL/USD",
      last: 200.5,
    });
  });

  it("uses Kraken's XDG/USD API symbol for Dogecoin", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      expect(String(input)).toContain("pair=XDGUSD");
      expect(String(input)).not.toContain("pair=DOGECAD");
      return jsonResponse({
        error: [],
        result: {
          XDGUSD: {
            a: ["0.2001", "1", "1"],
            b: ["0.2000", "1", "1"],
            c: ["0.2000", "1"],
            v: ["10", "20"],
            l: ["0.19", "0.19"],
            h: ["0.21", "0.21"],
            o: "0.195",
          },
        },
      });
    });
    const client = new KrakenClient({ fetchImpl: fetchImpl as typeof fetch });

    await expect(client.getTicker("DOGE/USD")).resolves.toMatchObject({
      pair: "DOGE/USD",
      last: 0.2,
    });
  });

  it("surfaces Kraken's API error when an error response omits result", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: ["EQuery:Unknown asset pair"] }),
    );
    const client = new KrakenClient({ fetchImpl: fetchImpl as typeof fetch });

    await expect(client.getClosedCandles("DOGE/USD", 5)).rejects.toThrow(
      "Kraken API error for /0/public/OHLC (pair=XDGUSD): EQuery:Unknown asset pair",
    );
  });

  it("classifies invalid Kraken market errors for safe pair skipping", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: ["EQuery:Invalid asset pair"] }),
    );
    const client = new KrakenClient({ fetchImpl: fetchImpl as typeof fetch });

    const error = await client
      .assertPairAvailable("ADA/USD")
      .catch((caught: unknown) => caught);
    expect(isKrakenUnavailablePairError(error)).toBe(true);
    expect(String(error)).toContain("pair=ADAUSD");
  });

  it("treats an empty AssetPairs result as an unavailable market", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: [], result: {} }),
    );
    const client = new KrakenClient({ fetchImpl: fetchImpl as typeof fetch });

    const error = await client
      .assertPairAvailable("ADA/USD")
      .catch((caught: unknown) => caught);
    expect(isKrakenUnavailablePairError(error)).toBe(true);
    expect(String(error)).toContain("ADA/USD");
  });

  it("discards the documented still-forming final OHLC row", async () => {
    const rows = [
      [1, "10", "11", "9", "10.5", "10.2", "2", 4],
      [2, "10.5", "12", "10", "11.5", "11", "3", 5],
      [3, "11.5", "99", "1", "50", "40", "9", 9],
    ];
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: [], result: { XXBTZUSD: rows, last: 3 } }),
    );
    const client = new KrakenClient({ fetchImpl: fetchImpl as typeof fetch });

    const candles = await client.getClosedCandles("BTC/USD", 5);
    expect(candles).toHaveLength(2);
    expect(candles.at(-1)?.close).toBe(11.5);
  });

  it("reports a clear error when an upstream gateway returns HTML", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("<html>blocked</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const client = new KrakenClient({ fetchImpl: fetchImpl as typeof fetch });
    await expect(client.getTicker("BTC/USD")).rejects.toThrow(
      "Kraken returned non-JSON data",
    );
  });

  it("matches Kraken's official REST signature example", () => {
    const signature = signKrakenRequest(
      "/0/private/AddOrder",
      {
        nonce: 1616492376594,
        ordertype: "limit",
        pair: "XBTUSD",
        price: 37500,
        type: "buy",
        volume: 1.25,
      },
      "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==",
    );
    expect(signature).toBe(
      "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==",
    );
  });

  it("hardcodes validate=true for private order checks", async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("validate")).toBe("true");
      expect(body.get("ordertype")).toBe("limit");
      return jsonResponse({ error: [], result: { descr: "validated" } });
    });
    const client = new KrakenClient({
      fetchImpl: fetchImpl as typeof fetch,
      clock: () => 1_700_000_000_000,
      apiKey: "test-key",
      apiSecret: Buffer.from("test-secret").toString("base64"),
      enableOrderValidation: true,
    });

    await expect(
      client.validateLimitOrder({
        pair: "ETH/USD",
        side: "buy",
        volume: 0.1,
        price: 2500,
      }),
    ).resolves.toEqual({ descr: "validated" });
  });

  it("submits only the fixed FOK long shape with an attached stop in live mode", async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("validate")).toBe("false");
      expect(body.get("timeinforce")).toBe("FOK");
      expect(body.get("type")).toBe("buy");
      expect(body.get("close[ordertype]")).toBe("stop-loss");
      expect(body.get("close[price]")).toBe("98.00");
      expect(body.get("leverage")).toBeNull();
      return jsonResponse({ error: [], result: { txid: ["ENTRY-1"] } });
    });
    const client = new KrakenClient({
      fetchImpl: fetchImpl as typeof fetch,
      clock: () => 1_700_000_000_000,
      apiKey: "test-key",
      apiSecret: Buffer.from("test-secret").toString("base64"),
      enableLiveOrderSubmission: true,
    });

    await expect(
      client.placeFokLongWithStop({
        pair: "BTC/USD",
        volume: "0.00100000",
        limitPriceCad: "100.25",
        stopPriceCad: "98.00",
        clientOrderId: "ct-e-test",
      }),
    ).resolves.toEqual({ txid: ["ENTRY-1"] });
  });

  it("never exposes the API key returned by GetApiKeyInfo", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        error: [],
        result: {
          apiKeyName: "bot",
          apiKey: "must-not-leak",
          permissions: ["query-funds"],
          ipAllowlist: [],
          validUntil: "0",
        },
      }),
    );
    const client = new KrakenClient({
      fetchImpl: fetchImpl as typeof fetch,
      apiKey: "test-key",
      apiSecret: Buffer.from("test-secret").toString("base64"),
    });

    const info = await client.getApiKeyInfo();
    expect(info).toEqual({
      apiKeyName: "bot",
      permissions: ["query-funds"],
      ipAllowlist: [],
      validUntil: "0",
    });
    expect(JSON.stringify(info)).not.toContain("must-not-leak");
  });

  it("serializes private requests so Kraken nonces cannot arrive out of order", async () => {
    let active = 0;
    let maximumActive = 0;
    const nonces: number[] = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      nonces.push(Number(new URLSearchParams(String(init?.body)).get("nonce")));
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      const path = new URL(String(url)).pathname;
      return path.endsWith("/Balance")
        ? jsonResponse({ error: [], result: { ZUSD: "500" } })
        : jsonResponse({ error: [], result: { open: {} } });
    });
    let clock = 1000;
    const client = new KrakenClient({
      fetchImpl: fetchImpl as typeof fetch,
      clock: () => clock++,
      apiKey: "test-key",
      apiSecret: Buffer.from("test-secret").toString("base64"),
    });

    await Promise.all([client.getAccountBalances(), client.getOpenOrders()]);
    expect(maximumActive).toBe(1);
    expect(nonces).toEqual([1000, 1001]);
  });
});
