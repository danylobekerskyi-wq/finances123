import { createHash, createHmac, randomUUID, } from "node:crypto";
const KRAKEN_PAIRS = {
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
export class KrakenApiError extends Error {
    requestLabel;
    errors;
    constructor(requestLabel, errors) {
        super(`Kraken API error for ${requestLabel}: ${errors.join(", ")}`);
        this.requestLabel = requestLabel;
        this.errors = errors;
        this.name = "KrakenApiError";
    }
}
export class KrakenPairUnavailableError extends Error {
    pair;
    constructor(pair, detail) {
        super(`Kraken market ${pair} is unavailable: ${detail}`);
        this.pair = pair;
        this.name = "KrakenPairUnavailableError";
    }
}
export function isKrakenUnavailablePairError(error) {
    if (error instanceof KrakenPairUnavailableError)
        return true;
    return (error instanceof KrakenApiError &&
        error.errors.some((message) => /EQuery:(?:Unknown|Invalid) asset pair/i.test(message)));
}
async function parseKrakenEnvelope(response, requestLabel) {
    let value;
    try {
        value = await response.json();
    }
    catch {
        throw new Error(`Kraken returned non-JSON data for ${requestLabel}`);
    }
    if (!value || typeof value !== "object") {
        throw new Error(`Kraken returned an invalid response for ${requestLabel}`);
    }
    const envelope = value;
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
    return { error: errors, result: envelope.result };
}
function toFiniteNumber(label, value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new Error(`Kraken returned an invalid ${label}`);
    }
    return number;
}
function firstObjectValue(record) {
    const value = Object.values(record)[0];
    if (value === undefined)
        throw new Error("Kraken returned an empty result");
    return value;
}
export class KrakenClient {
    baseUrl;
    fetchImpl;
    clock;
    apiKey;
    apiSecret;
    enableOrderValidation;
    enableLiveOrderSubmission;
    lastNonce = 0;
    privateRequestChain = Promise.resolve();
    constructor(options = {}) {
        this.baseUrl = options.baseUrl || "https://api.kraken.com";
        this.fetchImpl = options.fetchImpl || fetch;
        this.clock = options.clock || Date.now;
        this.apiKey = options.apiKey;
        this.apiSecret = options.apiSecret;
        this.enableOrderValidation = options.enableOrderValidation || false;
        this.enableLiveOrderSubmission = options.enableLiveOrderSubmission || false;
    }
    nextNonce() {
        const candidate = Math.trunc(this.clock());
        this.lastNonce = Math.max(candidate, this.lastNonce + 1);
        return this.lastNonce;
    }
    async publicGet(path, params) {
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
        const envelope = await parseKrakenEnvelope(response, requestLabel);
        return envelope.result;
    }
    credentials() {
        if (!this.apiKey || !this.apiSecret) {
            throw new Error("Kraken API credentials are not configured");
        }
        return { apiKey: this.apiKey, apiSecret: this.apiSecret };
    }
    async privatePost(path, payload = {}) {
        const operation = async () => {
            const credentials = this.credentials();
            const signedPayload = {
                nonce: this.nextNonce(),
                ...payload,
            };
            const body = encodeKrakenPayload(signedPayload);
            const signature = signKrakenRequest(path, signedPayload, credentials.apiSecret);
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
            const envelope = await parseKrakenEnvelope(response, path);
            return envelope.result;
        };
        const result = this.privateRequestChain.then(operation, operation);
        this.privateRequestChain = result.then(() => undefined, () => undefined);
        return result;
    }
    assertLiveOrderSubmission() {
        if (!this.enableLiveOrderSubmission) {
            throw new Error("Kraken live order submission is disabled");
        }
        this.credentials();
    }
    async getTicker(pair) {
        const result = await this.publicGet("/0/public/Ticker", { pair: KRAKEN_PAIRS[pair] });
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
    async getClosedCandles(pair, intervalMinutes) {
        const result = await this.publicGet("/0/public/OHLC", { pair: KRAKEN_PAIRS[pair], interval: intervalMinutes });
        const rows = Object.entries(result).find(([key, value]) => key !== "last" && Array.isArray(value))?.[1];
        if (!Array.isArray(rows))
            throw new Error("Kraken OHLC result is missing candles");
        const candles = rows.map((row, index) => {
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
    async getSnapshot(pair) {
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
    async getPairRules(pair) {
        const result = await this.publicGet("/0/public/AssetPairs", { pair: KRAKEN_PAIRS[pair] });
        const value = Object.values(result)[0];
        if (value === undefined) {
            throw new KrakenPairUnavailableError(pair, "not listed by AssetPairs");
        }
        const altname = String(value.altname || KRAKEN_PAIRS[pair]);
        const priceDecimals = toFiniteNumber("pair_decimals", value.pair_decimals);
        const lotDecimals = toFiniteNumber("lot_decimals", value.lot_decimals);
        const rules = {
            pair,
            altname,
            priceDecimals,
            lotDecimals,
            orderMinimum: toFiniteNumber("ordermin", value.ordermin),
            costMinimum: toFiniteNumber("costmin", value.costmin),
            tickSize: toFiniteNumber("tick_size", value.tick_size ?? 1 / 10 ** priceDecimals),
            status: String(value.status || "unknown"),
        };
        if (!Number.isInteger(rules.priceDecimals) ||
            !Number.isInteger(rules.lotDecimals) ||
            rules.orderMinimum <= 0 ||
            rules.costMinimum <= 0 ||
            rules.tickSize <= 0) {
            throw new Error("Kraken returned invalid pair trading rules");
        }
        return rules;
    }
    async assertPairAvailable(pair) {
        const rules = await this.getPairRules(pair);
        if (rules.status !== "online") {
            throw new KrakenPairUnavailableError(pair, `AssetPairs status is ${rules.status}`);
        }
    }
    async getApiKeyInfo() {
        const result = await this.privatePost("/0/private/GetApiKeyInfo");
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
    async getAccountBalances() {
        const result = await this.privatePost("/0/private/Balance");
        return Object.fromEntries(Object.entries(result).map(([asset, value]) => [
            asset,
            toFiniteNumber(`balance for ${asset}`, value),
        ]));
    }
    async getOpenOrders() {
        const result = await this.privatePost("/0/private/OpenOrders", { trades: false });
        return result.open || {};
    }
    async getClosedOrders(input = {}) {
        const payload = { trades: false };
        if (input.clientOrderId)
            payload.cl_ord_id = input.clientOrderId;
        if (input.startUnix !== undefined)
            payload.start = Math.trunc(input.startUnix);
        const result = await this.privatePost("/0/private/ClosedOrders", payload);
        return result.closed || {};
    }
    async queryOrders(txids) {
        if (txids.length === 0 || txids.length > 50) {
            throw new Error("QueryOrders requires between 1 and 50 order ids");
        }
        return this.privatePost("/0/private/QueryOrders", { txid: txids.join(","), trades: false });
    }
    async placeFokLongWithStop(input) {
        this.assertLiveOrderSubmission();
        return this.privatePost("/0/private/AddOrder", {
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
    async placeFokSell(input) {
        this.assertLiveOrderSubmission();
        return this.privatePost("/0/private/AddOrder", {
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
    async placeProtectiveStop(input) {
        this.assertLiveOrderSubmission();
        return this.privatePost("/0/private/AddOrder", {
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
    async cancelOrder(txid) {
        this.assertLiveOrderSubmission();
        return this.privatePost("/0/private/CancelOrder", { txid });
    }
    async validateLimitOrder(input) {
        if (!this.enableOrderValidation) {
            throw new Error("Kraken order validation is disabled");
        }
        this.credentials();
        if (!(input.volume > 0) || !(input.price > 0)) {
            throw new Error("Volume and price must be positive");
        }
        const payload = {
            ordertype: "limit",
            type: input.side,
            volume: input.volume.toFixed(8),
            pair: KRAKEN_PAIRS[input.pair],
            price: input.price.toFixed(2),
            cl_ord_id: `chat-${randomUUID().replaceAll("-", "").slice(0, 13)}`,
            deadline: new Date(this.clock() + 10_000).toISOString(),
            validate: true,
        };
        return this.privatePost("/0/private/AddOrder", payload);
    }
}
export function encodeKrakenPayload(payload) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
        params.append(key, String(value));
    }
    return params.toString();
}
export function signKrakenRequest(urlPath, payload, apiSecret) {
    const nonce = payload.nonce;
    if (nonce === undefined)
        throw new Error("Kraken payload requires a nonce");
    const encoded = encodeKrakenPayload(payload);
    const hash = createHash("sha256").update(`${nonce}${encoded}`).digest();
    const message = Buffer.concat([Buffer.from(urlPath), hash]);
    return createHmac("sha512", Buffer.from(apiSecret, "base64"))
        .update(message)
        .digest("base64");
}
