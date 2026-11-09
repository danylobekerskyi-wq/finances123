const COINBASE_USD_PRODUCTS = {
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
function positiveNumber(name, value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Coinbase returned an invalid ${name}`);
    }
    return parsed;
}
function firstBookPrice(name, value) {
    if (!Array.isArray(value) || value.length === 0 || !Array.isArray(value[0])) {
        throw new Error(`Coinbase returned an invalid ${name} book`);
    }
    return positiveNumber(`${name} price`, value[0][0]);
}
export class CoinbaseReferenceClient {
    baseUrl;
    fetchImpl;
    constructor(options = {}) {
        this.baseUrl = options.baseUrl || "https://api.exchange.coinbase.com";
        this.fetchImpl = options.fetchImpl || fetch;
    }
    async getReferencePrice(pair) {
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
        let payload;
        try {
            payload = await response.json();
        }
        catch {
            throw new Error("Coinbase returned non-JSON order-book data");
        }
        if (!payload || typeof payload !== "object") {
            throw new Error("Coinbase returned an invalid order-book payload");
        }
        const book = payload;
        if (book.auction_mode === true) {
            throw new Error("Coinbase product is in auction mode");
        }
        const bid = firstBookPrice("bid", book.bids);
        const ask = firstBookPrice("ask", book.asks);
        if (ask < bid)
            throw new Error("Coinbase ask is below bid");
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
