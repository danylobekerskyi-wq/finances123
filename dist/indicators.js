function requireLength(values, period) {
    if (values.length < period) {
        throw new Error(`Need at least ${period} values; received ${values.length}`);
    }
}
export function average(values) {
    if (values.length === 0)
        throw new Error("Cannot average an empty array");
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
export function ema(values, period) {
    requireLength(values, period);
    const multiplier = 2 / (period + 1);
    let result = average(values.slice(0, period));
    for (let index = period; index < values.length; index += 1) {
        const value = values[index];
        if (value === undefined)
            continue;
        result = (value - result) * multiplier + result;
    }
    return result;
}
export function rsi(values, period = 14) {
    requireLength(values, period + 1);
    let gains = 0;
    let losses = 0;
    for (let index = 1; index <= period; index += 1) {
        const current = values[index];
        const previous = values[index - 1];
        if (current === undefined || previous === undefined)
            continue;
        const change = current - previous;
        if (change >= 0)
            gains += change;
        else
            losses -= change;
    }
    let averageGain = gains / period;
    let averageLoss = losses / period;
    for (let index = period + 1; index < values.length; index += 1) {
        const current = values[index];
        const previous = values[index - 1];
        if (current === undefined || previous === undefined)
            continue;
        const change = current - previous;
        const gain = Math.max(change, 0);
        const loss = Math.max(-change, 0);
        averageGain = (averageGain * (period - 1) + gain) / period;
        averageLoss = (averageLoss * (period - 1) + loss) / period;
    }
    if (averageLoss === 0)
        return 100;
    const relativeStrength = averageGain / averageLoss;
    return 100 - 100 / (1 + relativeStrength);
}
export function atr(candles, period = 14) {
    if (candles.length < period + 1) {
        throw new Error(`Need at least ${period + 1} candles for ATR`);
    }
    const ranges = [];
    for (let index = 1; index < candles.length; index += 1) {
        const current = candles[index];
        const previous = candles[index - 1];
        if (!current || !previous)
            continue;
        ranges.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
    }
    let result = average(ranges.slice(0, period));
    for (let index = period; index < ranges.length; index += 1) {
        const value = ranges[index];
        if (value === undefined)
            continue;
        result = (result * (period - 1) + value) / period;
    }
    return result;
}
export function classifyRegime(candles) {
    if (candles.length < 55)
        throw new Error("Need 55 closed 1H candles");
    const closes = candles.map((candle) => candle.close);
    const ema20Value = ema(closes, 20);
    const ema50Value = ema(closes, 50);
    const latest = candles.at(-1);
    const comparison = candles.at(-5);
    if (!latest || !comparison)
        throw new Error("Missing regime candles");
    if (latest.close > ema20Value &&
        ema20Value > ema50Value &&
        latest.close > comparison.close) {
        return { regime: "BULLISH", ema20: ema20Value, ema50: ema50Value };
    }
    if (latest.close < ema20Value &&
        ema20Value < ema50Value &&
        latest.close < comparison.close) {
        return { regime: "BEARISH", ema20: ema20Value, ema50: ema50Value };
    }
    return { regime: "RANGE", ema20: ema20Value, ema50: ema50Value };
}
