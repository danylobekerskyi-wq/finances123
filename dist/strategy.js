import { chooseHoldingMinutes } from "./holdingTime.js";
import { fibonacciSignal } from "./fibonacci.js";
import { atr, classifyRegime } from "./indicators.js";
import { calculateLongPlan } from "./risk.js";
const MAX_ENTRY_DATA_AGE_SECONDS = 10 * 60;
const MAX_REFERENCE_AGE_SECONDS = 10 * 60;
const MAX_REFERENCE_DIFFERENCE_PCT = 0.5;
const MAX_TARGET_DISTANCE_PCT = 4;
function maximum(candles, field) {
    return Math.max(...candles.map((candle) => candle[field]));
}
function latestClosedCandleAgeSeconds(snapshot) {
    const latest = snapshot.candles1m.at(-1);
    if (!latest)
        return Number.POSITIVE_INFINITY;
    const candleClosedAtMs = (latest.time + 60) * 1000;
    return Math.max(0, (Date.parse(snapshot.capturedAt) - candleClosedAtMs) / 1000);
}
function spreadPct(snapshot) {
    const { ask, bid } = snapshot.ticker;
    return ((ask - bid) / ((ask + bid) / 2)) * 100;
}
function detectBreakoutClose(candles, timeframe) {
    const latest = candles.at(-1);
    if (!latest || candles.length < 21)
        return null;
    const prior = candles.slice(-21, -1);
    const level = maximum(prior, "high");
    // A wick through resistance is not a signal. The latest fully closed
    // candle must finish above the highest high of the previous 20 closed
    // candles. Retest, volume and RSI are intentionally not required.
    if (latest.close <= level)
        return null;
    const timeframeAtr = atr(candles, 14);
    return {
        name: "BREAKOUT_CLOSE",
        timeframe,
        stop: Math.min(latest.low, level) - timeframeAtr * 0.15,
        obstacle: null,
        reasons: [
            `Latest closed ${timeframe} candle finished above its resistance ${level.toFixed(2)}`,
            `${timeframe} breakout close is sufficient; no retest is required`,
        ],
        reEvaluateWhen: `Signal is invalidated if a closed ${timeframe} candle returns below ${level.toFixed(2)}`,
    };
}
function emptyResult(snapshot, decision, regime, spread, age, reasons, reEvaluateWhen, referenceDifference, newsStatus, setup = "NONE", trigger5m = false, triggerTimeframe = null) {
    return {
        decision,
        pair: snapshot.ticker.pair,
        exchange: "Kraken",
        capturedAt: snapshot.capturedAt,
        currentPriceCad: snapshot.ticker.last,
        bidCad: snapshot.ticker.bid,
        askCad: snapshot.ticker.ask,
        spreadPct: spread,
        dataAgeSeconds: age,
        regime1h: regime,
        setup15m: setup,
        trigger5m,
        triggerTimeframe,
        reasons,
        reEvaluateWhen,
        referencePriceDifferencePct: referenceDifference,
        newsStatus,
        plan: null,
        signalExpiresAt: null,
    };
}
export function evaluateSnapshot(snapshot, options) {
    const spread = spreadPct(snapshot);
    const age = latestClosedCandleAgeSeconds(snapshot);
    const newsStatus = options.newsStatus || "unknown";
    if (snapshot.candles1m.length < 55 ||
        snapshot.candles5m.length < 55 ||
        snapshot.candles15m.length < 55 ||
        snapshot.candles1h.length < 55 ||
        !Number.isFinite(age) || !Number.isFinite(spread) || spread < 0 ||
        !Number.isFinite(snapshot.ticker.ask) || snapshot.ticker.ask <= 0 ||
        age > MAX_ENTRY_DATA_AGE_SECONDS ||
        spread > options.maxSpreadPct) {
        const reasons = [
            age > MAX_ENTRY_DATA_AGE_SECONDS
                ? `Latest closed 1M candle is ${age.toFixed(0)} seconds old`
                : "Not enough closed candles for multi-timeframe analysis",
        ];
        if (spread > options.maxSpreadPct) {
            reasons.push(`Spread ${spread.toFixed(3)}% exceeds ${options.maxSpreadPct.toFixed(3)}%`);
        }
        return emptyResult(snapshot, "NO_TRADE_DATA_NOT_RELIABLE", "RANGE", spread, age, reasons, "Wait for a fresh, complete Kraken snapshot with an acceptable spread", null, newsStatus);
    }
    const { regime } = classifyRegime(snapshot.candles1h);
    let referenceDifference = null;
    if (options.referencePriceCad === undefined ||
        options.referencePriceCapturedAt === undefined) {
        return emptyResult(snapshot, "NO_TRADE_CROSSCHECK_REQUIRED", regime, spread, age, ["A second current price source was not supplied"], "Cross-check Kraken against a second source captured within 10 minutes", null, newsStatus);
    }
    const referenceAge = (Date.parse(snapshot.capturedAt) -
        Date.parse(options.referencePriceCapturedAt)) /
        1000;
    referenceDifference =
        (Math.abs(snapshot.ticker.last - options.referencePriceCad) /
            snapshot.ticker.last) *
            100;
    if (!Number.isFinite(referenceAge) ||
        Math.abs(referenceAge) > MAX_REFERENCE_AGE_SECONDS ||
        !Number.isFinite(referenceDifference) || options.referencePriceCad <= 0 || referenceDifference > MAX_REFERENCE_DIFFERENCE_PCT) {
        return emptyResult(snapshot, "NO_TRADE_DATA_NOT_RELIABLE", regime, spread, age, [
            `Reference source differs by ${referenceDifference.toFixed(3)}% or is stale`,
        ], "Refresh both exchange and reference prices before evaluating an entry", referenceDifference, newsStatus);
    }
    const fib = fibonacciSignal(snapshot.candles1m);
    const fibonacciSetup = fib && regime === "BULLISH" ? {
        name: "FIBONACCI_SCALP", timeframe: "1M", stop: fib.stop, obstacle: fib.obstacle,
        reasons: ["Closed bullish 1M rejection of the 38.2–61.8% Fibonacci pullback in an hourly uptrend"],
        reEvaluateWhen: "Wait for a fresh closed Fibonacci rejection candle",
    } : null;
    const setup = (options.strategy === "fibonacci" ? fibonacciSetup : (detectBreakoutClose(snapshot.candles15m, "15M") ||
        detectBreakoutClose(snapshot.candles5m, "5M") ||
        detectBreakoutClose(snapshot.candles1m, "1M"))) || {
        name: "NONE",
        timeframe: null,
        stop: null,
        obstacle: null,
        reasons: [
            options.strategy === "fibonacci" ? "No confirmed Fibonacci pullback with bullish trend and closed-candle rejection" : "No latest closed 1M, 5M, or 15M candle closed above its resistance",
        ],
        reEvaluateWhen: "Wait for a 1M, 5M, or 15M candle to close above the highest high of its previous 20 closed candles",
    };
    const trigger = setup.name !== "NONE";
    if (setup.name === "NONE" || !trigger || setup.stop === null) {
        const reasons = [...setup.reasons];
        if (!trigger)
            reasons.push("A wick above resistance without a candle close is not a signal on any timeframe");
        return emptyResult(snapshot, "WAIT_SETUP_NOT_CONFIRMED", regime, spread, age, reasons, setup.reEvaluateWhen, referenceDifference, newsStatus, setup.name, trigger, setup.timeframe);
    }
    if (setup.stop >= snapshot.ticker.ask) {
        return emptyResult(snapshot, "WAIT_SETUP_NOT_CONFIRMED", regime, spread, age, ["Technical invalidation is not below the executable ask"], setup.reEvaluateWhen, referenceDifference, newsStatus, setup.name, trigger, setup.timeframe);
    }
    let plan;
    try {
        plan = calculateLongPlan({
            balanceCad: options.balanceCad,
            riskPct: options.riskPct,
            entry: snapshot.ticker.ask,
            stop: setup.stop,
            feePctPerSide: options.feePctPerSide,
            slippagePctPerSide: options.slippagePctPerSide,
            maxExposurePct: options.maxExposurePct,
            rewardRisk: options.rewardRisk,
        });
    }
    catch (error) {
        return emptyResult(snapshot, "NO_TRADE_COSTS_TOO_HIGH", regime, spread, age, [error instanceof Error ? error.message : "Risk calculation failed"], setup.reEvaluateWhen, referenceDifference, newsStatus, setup.name, trigger, setup.timeframe);
    }
    if (plan.positionNotionalCad < 10 ||
        plan.targetDistancePct > MAX_TARGET_DISTANCE_PCT ||
        (setup.obstacle !== null && setup.obstacle < plan.minimumTarget)) {
        return emptyResult(snapshot, "NO_TRADE_COSTS_TOO_HIGH", regime, spread, age, [
            plan.targetDistancePct > MAX_TARGET_DISTANCE_PCT
                ? `Fees, slippage, and stop require a ${plan.targetDistancePct.toFixed(2)}% target`
                : "Available room or position size is insufficient for 2R net of costs",
        ], setup.reEvaluateWhen, referenceDifference, newsStatus, setup.name, trigger, setup.timeframe);
    }
    const newsAge = options.newsCheckedAt
        ? (Date.parse(snapshot.capturedAt) - Date.parse(options.newsCheckedAt)) / 1000
        : Number.POSITIVE_INFINITY;
    if (newsStatus !== "clear" || !Number.isFinite(newsAge) || Math.abs(newsAge) > 15 * 60) {
        return emptyResult(snapshot, "NO_TRADE_NEWS_CHECK_REQUIRED", regime, spread, age, [
            ...setup.reasons,
            "A 1M, 5M, or 15M breakout candle closed above resistance",
            newsStatus === "blocked"
                ? "A material news or macro event blocks new entries"
                : "A current news and macro-event check is required",
        ], "Re-scan after confirming no material event risk within the next 15 minutes", referenceDifference, newsStatus, setup.name, trigger, setup.timeframe);
    }
    plan.maxHoldingMinutes = chooseHoldingMinutes(plan.entry, plan.minimumTarget, atr(snapshot.candles1m, 14));
    const expiresAt = new Date(Date.parse(snapshot.capturedAt) + (options.strategy === "fibonacci" ? 60 : 600) * 1000);
    return {
        decision: "BUY_SETUP_CONFIRMED",
        pair: snapshot.ticker.pair,
        exchange: "Kraken",
        capturedAt: snapshot.capturedAt,
        currentPriceCad: snapshot.ticker.last,
        bidCad: snapshot.ticker.bid,
        askCad: snapshot.ticker.ask,
        spreadPct: spread,
        dataAgeSeconds: age,
        regime1h: regime,
        setup15m: setup.name,
        trigger5m: trigger,
        triggerTimeframe: setup.timeframe,
        reasons: [...setup.reasons, "The closed-candle setup is confirmed"],
        reEvaluateWhen: setup.reEvaluateWhen,
        referencePriceDifferencePct: referenceDifference,
        newsStatus,
        plan,
        signalExpiresAt: expiresAt.toISOString(),
    };
}
