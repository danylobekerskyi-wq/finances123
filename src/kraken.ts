import {
  createHash,
  createHmac,
  randomUUID,
} from "node:crypto";
import type {
  Candle,
  MarketDataProvider,
  MarketSnapshot,
  SupportedPair,
  Ticker,
} from "./types.js";

const KRAKEN_PAIRS: Record<SupportedPair, string> = {
  "BTC/USD": "XBTUSD",
  "ETH/USD": "ETHUSD",
  "SOL/USD": "SOLUSD",
  "XRP/USD": "XRPUSD",
  "ADA/USD": "ADAUSD",
  // Kraken keeps the legacy XDG symbol for Dogecoin in its API.
  "DOGE/USD": "XDGUSD",
  "LINK/USD": "LINKUSD",
  "LTC/USD": "LTCUSD",
  "AVAX/USD": "AVAXUSD",
  "DOT/USD": "DOTUSD",
};

type KrakenPayload = Record<string, string | number | boolean>;

export interface KrakenPairRules {
  pair: SupportedPair;
  altname: string;
  priceDecimals: number;
  lotDecimals: number;
  orderMinimum: number;
  costMinimum: number;
  tickSize: number;
  status: string;
}

export interface KrakenOrderDescription {
  pair: string;
  type: "buy" | "sell";
  ordertype: string;
  price: string;
  price2: string;
  leverage: string;
  order: string;
  close: string;
}

export interface KrakenOrderInfo {
  refid: string | null;
  status: string;
  reason?: string | null;
  opentm: number;
  closetm?: number;
  descr: KrakenOrderDescription;
  vol: string;
  vol_exec: string;
  cost: string;
  fee: string;
  price: string;
  stopprice?: string;
  limitprice?: string;
  cl_ord_id?: string;
}

export interface KrakenAddedOrder {
  descr?: { order?: string; close?: string };
  txid: string[];
}

export interface KrakenApiKeyInfo {
  apiKeyName: string;
  permissions: string[];
  ipAllowlist: string[];
  validUntil: string;
}

type FetchLike = typeof fetch;

interface KrakenEnvelope<T> {
  error: string[];
  result: T;
}

interface KrakenTickerPayload {
  a: [string, string, string];
  b: [string, string, string];
  c: [string, string];
  v: [string, string];
  l: [string, string];
  h: [string, string];
  o: string;
}

export class KrakenApiError extends Error {
  constructor(
    readonly requestLabel: string,
    readonly errors: string[],
  ) {
    super(`Kraken API error for ${requestLabel}: ${errors.join(", ")}`);
    this.name = "KrakenApiError";
  }
}

export class KrakenPairUnavailableError extends Error {
  constructor(
    readonly pair: SupportedPair,
    detail: string,
  ) {
    super(`Kraken market ${pair} is unavailable: ${detail}`);
    this.name = "KrakenPairUnavailableError";
  }
}

export function isKrakenUnavailablePairError(error: unknown): boolean {
  if (error instanceof KrakenPairUnavailableError) return true;
  return (
    error instanceof KrakenApiError &&
    error.errors.some((message) =>
      /EQuery:(?:Unknown|Invalid) asset pair/i.test(message),
    )
  );
}

async function parseKrakenEnvelope<T>(
  response: Response,
  requestLabel: string,
): Promise<KrakenEnvelope<T>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`Kraken returned non-JSON data for ${requestLabel}`);
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Kraken returned an invalid response for ${requestLabel}`);
  }
  const envelope = value as Partial<KrakenEnvelope<T>>;
  if (!Array.isArray(envelope.error)) {
    throw new Error(`Kraken response envelope is invalid for ${requestLabel}`);
  }
  const errors = envelope.error.map(String);
  // Error responses may legitimately omit `result`; surface Kraken's actual
  // message before validating the success payload shape.
  if (errors.length > 0) {
    throw new KrakenApiError(requestLabel, errors);
  }
  if (!("result" in envelope)) {
    throw new Error(`Kraken response envelope is invalid for ${requestLabel}`);
  }
  return { error: errors, result: envelope.result as T };
}

function toFiniteNumber(label: string, value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Kraken returned an invalid ${label}`);
  }
  return number;
}

function firstObjectValue<T>(record: Record<string, T>): T {
  const value = Object.values(record)[0];
  if (value === undefined) throw new Error("Kraken returned an empty result");
  return value;
}

export interface KrakenClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  clock?: () => number;
  apiKey?: string;
  apiSecret?: string;
  enableOrderValidation?: boolean;
  enableLiveOrderSubmission?: boolean;
}

export class KrakenClient implements MarketDataProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => number;
  private readonly apiKey?: string;
  private readonly apiSecret?: string;
  private readonly enableOrderValidation: boolean;
  private readonly enableLiveOrderSubmission: boolean;
  private lastNonce = 0;
  private privateRequestChain: Promise<void> = Promise.resolve();

  constructor(options: KrakenClientOptions = {}) {
    this.baseUrl = options.baseUrl || "https://api.kraken.com";
    this.fetchImpl = options.fetchImpl || fetch;
    this.clock = options.clock || Date.now;
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.enableOrderValidation = options.enableOrderValidation || false;
    this.enableLiveOrderSubmission = options.enableLiveOrderSubmission || false;
  }

  private nextNonce(): number {
    const candidate = Math.trunc(this.clock());
    this.lastNonce = Math.max(candidate, this.lastNonce + 1);
    return this.lastNonce;
  }

  private async publicGet<T>(
    path: string,
    params: Record<string, string | number>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Kraken HTTP ${response.status} for ${path}`);
    }
    const requestLabel = params.pair === undefined
      ? path
      : `${path} (pair=${String(params.pair)})`;
    const envelope = await parseKrakenEnvelope<T>(response, requestLabel);
    return envelope.result;
  }

  private credentials(): { apiKey: string; apiSecret: string } {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error("Kraken API credentials are not configured");
    }
    return { apiKey: this.apiKey, apiSecret: this.apiSecret };
  }

  private async privatePost<T>(
    path: string,
    payload: KrakenPayload = {},
  ): Promise<T> {
    const operation = async (): Promise<T> => {
      const credentials = this.credentials();
      const signedPayload: KrakenPayload = {
        nonce: this.nextNonce(),
        ...payload,
      };
      const body = encodeKrakenPayload(signedPayload);
      const signature = signKrakenRequest(
        path,
        signedPayload,
        credentials.apiSecret,
      );
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "API-Key": credentials.apiKey,
          "API-Sign": signature,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Kraken HTTP ${response.status} for ${path}`);
      }
      const envelope = await parseKrakenEnvelope<T>(response, path);
      return envelope.result;
    };
    const result = this.privateRequestChain.then(operation, operation);
    this.privateRequestChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertLiveOrderSubmission(): void {
    if (!this.enableLiveOrderSubmission) {
      throw new Error("Kraken live order submission is disabled");
    }
    this.credentials();
  }

  async getTicker(pair: SupportedPair): Promise<Ticker> {
    const result = await this.publicGet<Record<string, KrakenTickerPayload>>(
      "/0/public/Ticker",
      { pair: KRAKEN_PAIRS[pair] },
    );
    const payload = firstObjectValue(result);
    return {
      pair,
      ask: toFiniteNumber("ask", payload.a[0]),
      bid: toFiniteNumber("bid", payload.b[0]),
      last: toFiniteNumber("last price", payload.c[0]),
      volume24h: toFiniteNumber("24h volume", payload.v[1]),
      low24h: toFiniteNumber("24h low", payload.l[1]),
      high24h: toFiniteNumber("24h high", payload.h[1]),
      openUtc: toFiniteNumber("UTC open", payload.o),
    };
  }

  async getClosedCandles(
    pair: SupportedPair,
    intervalMinutes: 1 | 5 | 15 | 60,
  ): Promise<Candle[]> {
    const result = await this.publicGet<Record<string, unknown>>(
      "/0/public/OHLC",
      { pair: KRAKEN_PAIRS[pair], interval: intervalMinutes },
    );
    const rows = Object.entries(result).find(
      ([key, value]) => key !== "last" && Array.isArray(value),
    )?.[1];
    if (!Array.isArray(rows)) throw new Error("Kraken OHLC result is missing candles");

    const candles = rows.map((row, index): Candle => {
      if (!Array.isArray(row) || row.length < 8) {
        throw new Error(`Kraken OHLC row ${index} is malformed`);
      }
      return {
        time: toFiniteNumber("candle time", row[0]),
        open: toFiniteNumber("candle open", row[1]),
        high: toFiniteNumber("candle high", row[2]),
        low: toFiniteNumber("candle low", row[3]),
        close: toFiniteNumber("candle close", row[4]),
        vwap: toFiniteNumber("candle vwap", row[5]),
        volume: toFiniteNumber("candle volume", row[6]),
        trades: toFiniteNumber("candle trades", row[7]),
      };
    });

    // Kraken documents the final row as the still-forming candle.
    return candles.slice(0, -1);
  }

  async getSnapshot(pair: SupportedPair): Promise<MarketSnapshot> {
    const [ticker, candles1m, candles5m, candles15m, candles1h] = await Promise.all([
      this.getTicker(pair),
      this.getClosedCandles(pair, 1),
      this.getClosedCandles(pair, 5),
      this.getClosedCandles(pair, 15),
      this.getClosedCandles(pair, 60),
    ]);
    return {
      ticker,
      candles1m,
      candles5m,
      candles15m,
      candles1h,
      capturedAt: new Date(this.clock()).toISOString(),
      source: "Kraken",
    };
  }

  async getPairRules(pair: SupportedPair): Promise<KrakenPairRules> {
    const result = await this.publicGet<Record<string, Record<string, unknown>>>(
      "/0/public/AssetPairs",
      { pair: KRAKEN_PAIRS[pair] },
    );
    const value = Object.values(result)[0];
    if (value === undefined) {
      throw new KrakenPairUnavailableError(pair, "not listed by AssetPairs");
    }
    const altname = String(value.altname || KRAKEN_PAIRS[pair]);
    const priceDecimals = toFiniteNumber("pair_decimals", value.pair_decimals);
    const lotDecimals = toFiniteNumber("lot_decimals", value.lot_decimals);
    const rules: KrakenPairRules = {
      pair,
      altname,
      priceDecimals,
      lotDecimals,
      orderMinimum: toFiniteNumber("ordermin", value.ordermin),
      costMinimum: toFiniteNumber("costmin", value.costmin),
      tickSize: toFiniteNumber(
        "tick_size",
        value.tick_size ?? 1 / 10 ** priceDecimals,
      ),
      status: String(value.status || "unknown"),
    };
    if (
      !Number.isInteger(rules.priceDecimals) ||
      !Number.isInteger(rules.lotDecimals) ||
      rules.orderMinimum <= 0 ||
      rules.costMinimum <= 0 ||
      rules.tickSize <= 0
    ) {
      throw new Error("Kraken returned invalid pair trading rules");
    }
    return rules;
  }

  async assertPairAvailable(pair: SupportedPair): Promise<void> {
    const rules = await this.getPairRules(pair);
    if (rules.status !== "online") {
      throw new KrakenPairUnavailableError(
        pair,
        `AssetPairs status is ${rules.status}`,
      );
    }
  }

  async getApiKeyInfo(): Promise<KrakenApiKeyInfo> {
    const result = await this.privatePost<Record<string, unknown>>(
      "/0/private/GetApiKeyInfo",
    );
    return {
      apiKeyName: String(result.apiKeyName || ""),
      permissions: Array.isArray(result.permissions)
        ? result.permissions.map(String)
        : [],
      ipAllowlist: Array.isArray(result.ipAllowlist)
        ? result.ipAllowlist.map(String)
        : [],
      validUntil: String(result.validUntil || "0"),
    };
  }

  async getAccountBalances(): Promise<Record<string, number>> {
    const result = await this.privatePost<Record<string, string>>(
      "/0/private/Balance",
    );
    return Object.fromEntries(
      Object.entries(result).map(([asset, value]) => [
        asset,
        toFiniteNumber(`balance for ${asset}`, value),
      ]),
    );
  }

  async getOpenOrders(): Promise<Record<string, KrakenOrderInfo>> {
    const result = await this.privatePost<{
      open: Record<string, KrakenOrderInfo>;
    }>("/0/private/OpenOrders", { trades: false });
    return result.open || {};
  }

  async getClosedOrders(input: {
    clientOrderId?: string;
    startUnix?: number;
  } = {}): Promise<Record<string, KrakenOrderInfo>> {
    const payload: KrakenPayload = { trades: false };
    if (input.clientOrderId) payload.cl_ord_id = input.clientOrderId;
    if (input.startUnix !== undefined) payload.start = Math.trunc(input.startUnix);
    const result = await this.privatePost<{
      closed: Record<string, KrakenOrderInfo>;
    }>("/0/private/ClosedOrders", payload);
    return result.closed || {};
  }

  async queryOrders(txids: string[]): Promise<Record<string, KrakenOrderInfo>> {
    if (txids.length === 0 || txids.length > 50) {
      throw new Error("QueryOrders requires between 1 and 50 order ids");
    }
    return this.privatePost<Record<string, KrakenOrderInfo>>(
      "/0/private/QueryOrders",
      { txid: txids.join(","), trades: false },
    );
  }

  async placeFokLongWithStop(input: {
    pair: SupportedPair;
    volume: string;
    limitPriceCad: string;
    stopPriceCad: string;
    clientOrderId: string;
  }): Promise<KrakenAddedOrder> {
    this.assertLiveOrderSubmission();
    return this.privatePost<KrakenAddedOrder>("/0/private/AddOrder", {
      ordertype: "limit",
      type: "buy",
      volume: input.volume,
      pair: KRAKEN_PAIRS[input.pair],
      price: input.limitPriceCad,
      timeinforce: "FOK",
      oflags: "fciq",
      cl_ord_id: input.clientOrderId,
      "close[ordertype]": "stop-loss",
      "close[price]": input.stopPriceCad,
      deadline: new Date(this.clock() + 10_000).toISOString(),
      validate: false,
    });
  }

  async placeFokSell(input: {
    pair: SupportedPair;
    volume: string;
    limitPriceCad: string;
    clientOrderId: string;
  }): Promise<KrakenAddedOrder> {
    this.assertLiveOrderSubmission();
    return this.privatePost<KrakenAddedOrder>("/0/private/AddOrder", {
      ordertype: "limit",
      type: "sell",
      volume: input.volume,
      pair: KRAKEN_PAIRS[input.pair],
      price: input.limitPriceCad,
      timeinforce: "FOK",
      oflags: "fciq",
      cl_ord_id: input.clientOrderId,
      deadline: new Date(this.clock() + 10_000).toISOString(),
      validate: false,
    });
  }

  async placeProtectiveStop(input: {
    pair: SupportedPair;
    volume: string;
    stopPriceCad: string;
    clientOrderId: string;
  }): Promise<KrakenAddedOrder> {
    this.assertLiveOrderSubmission();
    return this.privatePost<KrakenAddedOrder>("/0/private/AddOrder", {
      ordertype: "stop-loss",
      type: "sell",
      volume: input.volume,
      pair: KRAKEN_PAIRS[input.pair],
      price: input.stopPriceCad,
      oflags: "fciq",
      cl_ord_id: input.clientOrderId,
      deadline: new Date(this.clock() + 10_000).toISOString(),
      validate: false,
    });
  }

  async cancelOrder(txid: string): Promise<{ count: number; pending?: boolean }> {
    this.assertLiveOrderSubmission();
    return this.privatePost<{ count: number; pending?: boolean }>(
      "/0/private/CancelOrder",
      { txid },
    );
  }

  async validateLimitOrder(input: {
    pair: SupportedPair;
    side: "buy" | "sell";
    volume: number;
    price: number;
  }): Promise<unknown> {
    if (!this.enableOrderValidation) {
      throw new Error("Kraken order validation is disabled");
    }
    this.credentials();
    if (!(input.volume > 0) || !(input.price > 0)) {
      throw new Error("Volume and price must be positive");
    }

    const payload: KrakenPayload = {
      ordertype: "limit",
      type: input.side,
      volume: input.volume.toFixed(8),
      pair: KRAKEN_PAIRS[input.pair],
      price: input.price.toFixed(2),
      cl_ord_id: `chat-${randomUUID().replaceAll("-", "").slice(0, 13)}`,
      deadline: new Date(this.clock() + 10_000).toISOString(),
      validate: true,
    };
    return this.privatePost<unknown>("/0/private/AddOrder", payload);
  }
}

export function encodeKrakenPayload(
  payload: Record<string, string | number | boolean>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    params.append(key, String(value));
  }
  return params.toString();
}

export function signKrakenRequest(
  urlPath: string,
  payload: Record<string, string | number | boolean>,
  apiSecret: string,
): string {
  const nonce = payload.nonce;
  if (nonce === undefined) throw new Error("Kraken payload requires a nonce");
  const encoded = encodeKrakenPayload(payload);
  const hash = createHash("sha256").update(`${nonce}${encoded}`).digest();
  const message = Buffer.concat([Buffer.from(urlPath), hash]);
  return createHmac("sha512", Buffer.from(apiSecret, "base64"))
    .update(message)
    .digest("base64");
}
