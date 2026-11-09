import { describe, expect, it } from "vitest";
import { atr, classifyRegime, ema, rsi } from "../src/indicators.js";
import type { Candle } from "../src/types.js";

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: 1_700_000_000 + index * 3_600,
    open: close - 0.2,
    high: close + 0.5,
    low: close - 0.5,
    close,
    vwap: close,
    volume: 10,
    trades: 20,
  }));
}

describe("indicators", () => {
  it("computes known EMA and RSI edge cases", () => {
    expect(ema([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(rsi(Array.from({ length: 16 }, (_, index) => index + 1), 14)).toBe(100);
  });

  it("classifies an orderly uptrend as bullish", () => {
    const candles = candlesFromCloses(
      Array.from({ length: 60 }, (_, index) => 100 + index),
    );
    expect(classifyRegime(candles).regime).toBe("BULLISH");
  });

  it("uses true range for ATR", () => {
    const candles = candlesFromCloses(
      Array.from({ length: 20 }, (_, index) => 100 + index),
    );
    expect(atr(candles, 14)).toBeCloseTo(1.5, 6);
  });
});
