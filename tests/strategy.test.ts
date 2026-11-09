import { describe, expect, it } from "vitest";
import { evaluateSnapshot } from "../src/strategy.js";
import type { Candle, MarketSnapshot } from "../src/types.js";

const CAPTURED_AT = "2026-08-12T17:00:00.000Z";

function makeCandles(
  intervalMinutes: number,
  values: number[],
  range = 0.35,
): Candle[] {
  const latestClose = Date.parse(CAPTURED_AT) / 1000 - 60;
  const latestOpen = latestClose - intervalMinutes * 60;
  return values.map((close, index) => {
    const time = latestOpen - (values.length - 1 - index) * intervalMinutes * 60;
    const previous = values[index - 1] ?? close - 0.1;
    return {
      time,
      open: previous,
      high: Math.max(previous, close) + range,
      low: Math.min(previous, close) - range,
      close,
      vwap: (previous + close) / 2,
      volume: 10,
      trades: 20,
    };
  });
}

function snapshot(): MarketSnapshot {
  const rangeValues = Array.from(
    { length: 60 },
    (_, index) => 103 + 3 * Math.sin((index * Math.PI) / 10),
  );
  const candles15m = makeCandles(15, rangeValues, 0.2);
  const latest15m = candles15m.at(-1)!;
  Object.assign(latest15m, {
    open: 99.9,
    high: 100.2,
    low: 99.7,
    close: 100.05,
    vwap: 99.95,
  });

  const moves = Array.from({ length: 60 }, (_, index) =>
    99.2 + index * 0.015 + (index % 2 === 0 ? 0.18 : -0.12),
  );
  const candles5m = makeCandles(5, moves, 0.08);
  const candles1m = makeCandles(1, moves, 0.05);
  const latest5m = candles5m.at(-1)!;
  const breakoutLevel = Math.max(
    ...candles5m.slice(-21, -1).map((candle) => candle.high),
  );
  Object.assign(latest5m, {
    open: breakoutLevel - 0.1,
    high: breakoutLevel + 0.3,
    low: breakoutLevel - 0.15,
    close: breakoutLevel + 0.2,
    vwap: breakoutLevel + 0.05,
    volume: 1,
  });

  const executablePrice = latest5m.close + 0.02;

  return {
    ticker: {
      pair: "BTC/USD",
      ask: executablePrice,
      bid: executablePrice - 0.04,
      last: executablePrice - 0.02,
      openUtc: 99,
      high24h: 107,
      low24h: 98,
      volume24h: 100,
    },
    candles1m,
    candles5m,
    candles15m,
    candles1h: makeCandles(60, rangeValues),
    capturedAt: CAPTURED_AT,
    source: "Kraken",
  };
}

const baseOptions = {
  balanceCad: 500,
  riskPct: 0.5,
  maxExposurePct: 50,
  rewardRisk: 2,
  feePctPerSide: 0.4,
  slippagePctPerSide: 0.05,
  maxSpreadPct: 0.25,
};

describe("evaluateSnapshot", () => {
  it("blocks execution without an independent reference price", () => {
    const result = evaluateSnapshot(snapshot(), baseOptions);
    expect(result.decision).toBe("NO_TRADE_CROSSCHECK_REQUIRED");
    expect(result.plan).toBeNull();
  });

  it("blocks execution without a fresh news check", () => {
    const result = evaluateSnapshot(snapshot(), {
      ...baseOptions,
      referencePriceCad: 100.1,
      referencePriceCapturedAt: CAPTURED_AT,
    });
    expect(result.decision).toBe("NO_TRADE_NEWS_CHECK_REQUIRED");
  });

  it("does not require a news request before the technical trigger exists", () => {
    const noTrigger = snapshot();
    const latest = noTrigger.candles5m.at(-1)!;
    latest.close = Math.max(
      ...noTrigger.candles5m.slice(-21, -1).map((candle) => candle.high),
    );
    const result = evaluateSnapshot(noTrigger, {
      ...baseOptions,
      referencePriceCad: 100.1,
      referencePriceCapturedAt: CAPTURED_AT,
    });
    expect(result.decision).toBe("WAIT_SETUP_NOT_CONFIRMED");
    expect(result.trigger5m).toBe(false);
  });

  it("confirms a breakout only after the 5M candle closes above resistance", () => {
    const market = snapshot();
    const result = evaluateSnapshot(market, {
      ...baseOptions,
      referencePriceCad: market.ticker.ask,
      referencePriceCapturedAt: CAPTURED_AT,
      newsStatus: "clear",
      newsCheckedAt: CAPTURED_AT,
    });
    expect(result.decision).toBe("BUY_SETUP_CONFIRMED");
    expect(result.setup15m).toBe("BREAKOUT_CLOSE");
    expect(result.trigger5m).toBe(true);
    expect(result.plan?.worstCaseLossCad).toBeLessThanOrEqual(2.5);
    expect(result.plan?.netRewardRisk).toBeGreaterThanOrEqual(1.99);
  });

  it("does not count a wick above resistance as a breakout signal", () => {
    const market = snapshot();
    const latest = market.candles5m.at(-1)!;
    const level = Math.max(
      ...market.candles5m.slice(-21, -1).map((candle) => candle.high),
    );
    latest.high = level + 0.4;
    latest.close = level;
    const result = evaluateSnapshot(market, {
      ...baseOptions,
      referencePriceCad: market.ticker.ask,
      referencePriceCapturedAt: CAPTURED_AT,
      newsStatus: "clear",
      newsCheckedAt: CAPTURED_AT,
    });
    expect(result.decision).toBe("WAIT_SETUP_NOT_CONFIRMED");
    expect(result.trigger5m).toBe(false);
  });

  it("accepts a confirmed 1M breakout when 5M and 15M do not break out", () => {
    const market = snapshot();
    market.candles5m.at(-1)!.close = Math.max(
      ...market.candles5m.slice(-21, -1).map((candle) => candle.high),
    );
    const latest1m = market.candles1m.at(-1)!;
    const level1m = Math.max(
      ...market.candles1m.slice(-21, -1).map((candle) => candle.high),
    );
    Object.assign(latest1m, {
      open: level1m - 0.05,
      high: level1m + 0.15,
      low: level1m - 0.08,
      close: level1m + 0.1,
    });
    market.ticker.ask = latest1m.close + 0.02;
    market.ticker.bid = latest1m.close - 0.02;
    market.ticker.last = latest1m.close;

    const result = evaluateSnapshot(market, {
      ...baseOptions,
      referencePriceCad: market.ticker.last,
      referencePriceCapturedAt: CAPTURED_AT,
      newsStatus: "clear",
      newsCheckedAt: CAPTURED_AT,
    });
    expect(result.decision).toBe("BUY_SETUP_CONFIRMED");
    expect(result.reasons.join(" ")).toContain("1M");
  });

  it("accepts a confirmed 15M breakout when 1M and 5M do not break out", () => {
    const market = snapshot();
    market.candles5m.at(-1)!.close = Math.max(
      ...market.candles5m.slice(-21, -1).map((candle) => candle.high),
    );
    const latest15m = market.candles15m.at(-1)!;
    const level15m = Math.max(
      ...market.candles15m.slice(-21, -1).map((candle) => candle.high),
    );
    Object.assign(latest15m, {
      open: level15m - 0.1,
      high: level15m + 0.3,
      low: level15m - 0.15,
      close: level15m + 0.2,
    });
    market.ticker.ask = latest15m.close + 0.02;
    market.ticker.bid = latest15m.close - 0.02;
    market.ticker.last = latest15m.close;

    const result = evaluateSnapshot(market, {
      ...baseOptions,
      referencePriceCad: market.ticker.last,
      referencePriceCapturedAt: CAPTURED_AT,
      newsStatus: "clear",
      newsCheckedAt: CAPTURED_AT,
    });
    expect(result.decision).toBe("BUY_SETUP_CONFIRMED");
    expect(result.reasons.join(" ")).toContain("15M");
  });
});
