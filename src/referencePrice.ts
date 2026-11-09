import type { SupportedPair } from "./types.js";

const COINBASE_USD_PRODUCTS: Record<SupportedPair, string> = {
  "BTC/USD": "BTC-USD",
  "ETH/USD": "ETH-USD",
  "SOL/USD": "SOL-USD",
  "XRP/USD": "XRP-USD",
  "ADA/USD": "ADA-USD",
  "DOGE/USD": "DOGE-USD",
  "LINK/USD": "LINK-USD",
  "LTC/USD": "LTC-USD",
  "AVAX/USD": "AVAX-USD",
  "DOT/USD": "DOT-USD",
};

type FetchLike = typeof fetch;

export interface ReferencePrice {
  // Legacy field names are kept to avoid breaking the rest of v031 internally.
  // In this USD build all numeric values below are USD amounts.
  priceCad: number;
  bidCad?: number;
  askCad?: number;
  capturedAt: string;
  source: "Coinbase Exchange";
}

export interface ReferencePriceProvider {
  getReferencePrice(pair: SupportedPair): Promise<ReferencePrice>;
}

export interface CoinbaseReferenceClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

function positiveNumber(name: string, value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Coinbase returned an invalid ${name}`);
  }
  return parsed;
}

function firstBookPrice(name: "bid" | "ask", value: unknown): number {
  if (!Array.isArray(value) || value.length === 0 || !Array.isArray(value[0])) {
    throw new Error(`Coinbase returned an invalid ${name} book`);
  }
  return positiveNumber(`${name} price`, value[0][0]);
}

export class CoinbaseReferenceClient implements ReferencePriceProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: CoinbaseReferenceClientOptions = {}) {
    this.baseUrl = options.baseUrl || "https://api.exchange.coinbase.com";
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async getReferencePrice(pair: SupportedPair): Promise<ReferencePrice> {
    const product = COINBASE_USD_PRODUCTS[pair];
    const url = new URL(`/products/${encodeURIComponent(product)}/book`, this.baseUrl);
    url.searchParams.set("level", "1");

    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Coinbase HTTP ${response.status} for ${product}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Coinbase returned non-JSON order-book data");
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("Coinbase returned an invalid order-book payload");
    }

    const book = payload as Record<string, unknown>;
    if (book.auction_mode === true) {
      throw new Error("Coinbase product is in auction mode");
    }
    const bid = firstBookPrice("bid", book.bids);
    const ask = firstBookPrice("ask", book.asks);
    if (ask < bid) throw new Error("Coinbase ask is below bid");
    if (typeof book.time !== "string" || !Number.isFinite(Date.parse(book.time))) {
      throw new Error("Coinbase returned an invalid order-book time");
    }

    return {
      priceCad: (bid + ask) / 2,
      bidCad: bid,
      askCad: ask,
      capturedAt: new Date(Date.parse(book.time)).toISOString(),
      source: "Coinbase Exchange",
    };
  }
}
