import type { Candle } from "./types.js";

// Closed-candle impulse followed by a 38.2–61.8% pullback and bullish rejection.
export function fibonacciSignal(candles: readonly Candle[]) {
  if (candles.length < 22) return null;
  const prior = candles.slice(-22, -2);
  const pullback = candles.at(-2)!;
  const trigger = candles.at(-1)!;
  if ([...prior, pullback, trigger].some(c =>
    ![c.open,c.high,c.low,c.close,c.time].every(Number.isFinite) || c.low <= 0 ||
    c.low > Math.min(c.open,c.close) || c.high < Math.max(c.open,c.close))) return null;
  const low = Math.min(...prior.map(c => c.low));
  const high = Math.max(...prior.map(c => c.high));
  const lowIndex = prior.findIndex(c => c.low === low);
  const highIndex = prior.findIndex(c => c.high === high);
  if (high <= low || lowIndex >= highIndex) return null;
  const range = high - low;
  const zoneLow = high - range * 0.618;
  const zoneHigh = high - range * 0.382;
  if (pullback.low < zoneLow || pullback.low > zoneHigh ||
      trigger.close <= trigger.open || trigger.close <= pullback.high ||
      trigger.low < zoneLow || trigger.close >= high) return null;
  return { stop: high - range * 0.786, obstacle: high, zoneLow, zoneHigh };
}

// Conservative adaptation from persisted, closed outcomes only; never raises risk.
export function learnedRiskMultiplier(outcomes: readonly number[]): number {
  const recent = outcomes.slice(-20);
  if (recent.some(x => !Number.isFinite(x))) return 0;
  if (recent.length < 10) return 1;
  const mean = recent.reduce((a,b) => a+b,0) / recent.length;
  return mean < 0 ? 0.5 : 1;
}
