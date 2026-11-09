/** Bounded scalp time budget, not a prediction of when profit will arrive. */
export function chooseHoldingMinutes(entry, target, atr1m) {
    if (![entry, target, atr1m].every(Number.isFinite) || entry <= 0 || target <= entry || atr1m <= 0) {
        throw new Error("Cannot choose holding time from invalid price or volatility");
    }
    return Math.max(3, Math.min(30, Math.ceil(2 * (target - entry) / atr1m)));
}
