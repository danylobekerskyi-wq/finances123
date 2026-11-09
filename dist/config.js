import path from "node:path";
import { LIVE_SUPPORTED_PAIRS, SUPPORTED_PAIRS, } from "./types.js";
function pairsFromEnv(value, tradingMode) {
    const allowedPairs = tradingMode === "live" ? LIVE_SUPPORTED_PAIRS : SUPPORTED_PAIRS;
    if (value === undefined || value.trim() === "")
        return [...allowedPairs];
    const pairs = value
        .split(",")
        .map((pair) => pair.trim())
        .filter((pair) => allowedPairs.includes(pair));
    if (pairs.length === 0 || pairs.length !== value.split(",").length) {
        throw new Error(`AUTO_TRADER_PAIRS in ${tradingMode} mode may contain only: ${allowedPairs.join(", ")}`);
    }
    return [...new Set(pairs)];
}
function numberFromEnv(env, key, fallback, minimum = 0) {
    const raw = env[key];
    const value = raw === undefined || raw === "" ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < minimum) {
        throw new Error(`${key} must be a finite number >= ${minimum}`);
    }
    return value;
}
function booleanFromEnv(value, fallback) {
    if (value === undefined || value === "")
        return fallback;
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    throw new Error("Boolean environment values must be 'true' or 'false'");
}
const LIVE_ACKNOWLEDGEMENT = "I_UNDERSTAND_REAL_MONEY_CAN_BE_LOST";
function tradingModeFromEnv(value) {
    if (value === undefined || value === "" || value === "paper")
        return "paper";
    if (value === "live")
        return "live";
    throw new Error("TRADING_MODE must be 'paper' or 'live'");
}
function newsProviderFromEnv(value) {
    if (value === undefined || value === "" || value === "manual") {
        return "manual";
    }
    if (value === "openai")
        return "openai";
    if (value === "paper-auto")
        return "paper-auto";
    throw new Error("AUTO_NEWS_PROVIDER must be 'manual', 'openai', or 'paper-auto'");
}
function telegramNotificationModeFromEnv(value) {
    if (value === undefined || value === "" || value === "important") {
        return "important";
    }
    if (value === "all")
        return "all";
    throw new Error("TELEGRAM_NOTIFICATION_MODE must be 'important' or 'all'");
}
export function loadConfig(env = process.env) {
    const dataDir = path.resolve(env.DATA_DIR || "./data");
    const tradingMode = tradingModeFromEnv(env.TRADING_MODE);
    const riskPerTradePct = numberFromEnv(env, "RISK_PER_TRADE_PCT", 0.5, 0.01);
    const dailyLossLimitPct = numberFromEnv(env, "DAILY_LOSS_LIMIT_PCT", 1, 0.01);
    const maxExposurePct = numberFromEnv(env, "MAX_EXPOSURE_PCT", 50, 0.01);
    if (riskPerTradePct > 1) {
        throw new Error("RISK_PER_TRADE_PCT is capped at 1% by this project");
    }
    if (dailyLossLimitPct > 2) {
        throw new Error("DAILY_LOSS_LIMIT_PCT is capped at 2% by this project");
    }
    if (maxExposurePct > 100) {
        throw new Error("MAX_EXPOSURE_PCT cannot exceed 100%");
    }
    const autoTraderPollSeconds = numberFromEnv(env, "AUTO_TRADER_POLL_SECONDS", 60, 15);
    if (autoTraderPollSeconds > 300) {
        throw new Error("AUTO_TRADER_POLL_SECONDS cannot exceed 300 seconds");
    }
    const paperTradeTarget = numberFromEnv(env, "PAPER_TRADE_TARGET", 100, 1);
    if (!Number.isInteger(paperTradeTarget) || paperTradeTarget > 1_000) {
        throw new Error("PAPER_TRADE_TARGET must be an integer from 1 to 1000");
    }
    const autoNewsMaxAgeSeconds = numberFromEnv(env, "AUTO_NEWS_MAX_AGE_SECONDS", 15 * 60, 60);
    if (autoNewsMaxAgeSeconds > 15 * 60) {
        throw new Error("AUTO_NEWS_MAX_AGE_SECONDS is capped at 900 seconds");
    }
    const autoPaperTradingEnabled = booleanFromEnv(env.AUTO_PAPER_TRADING, false);
    const shadowLoggingEnabled = booleanFromEnv(env.SHADOW_LOGGING_ENABLED, false);
    const shadowWhenDailyBlocked = booleanFromEnv(env.SHADOW_WHEN_DAILY_BLOCKED, true);
    const autoLiveTradingEnabled = booleanFromEnv(env.AUTO_LIVE_TRADING, false);
    const autoNewsProvider = newsProviderFromEnv(env.AUTO_NEWS_PROVIDER);
    const telegramNotificationsEnabled = booleanFromEnv(env.TELEGRAM_NOTIFICATIONS_ENABLED, false);
    const telegramNotifyStartup = booleanFromEnv(env.TELEGRAM_NOTIFY_STARTUP, true);
    const telegramNotificationMode = telegramNotificationModeFromEnv(env.TELEGRAM_NOTIFICATION_MODE);
    const liveSwitchEnabled = booleanFromEnv(env.ENABLE_LIVE_TRADING, false);
    const liveAcknowledged = env.LIVE_TRADING_ACK === LIVE_ACKNOWLEDGEMENT;
    const liveCapitalCapCad = numberFromEnv(env, "LIVE_CAPITAL_CAP_CAD", 500, 10);
    const liveMaxOrderCad = numberFromEnv(env, "LIVE_MAX_ORDER_CAD", 250, 10);
    const liveEntrySlippagePct = numberFromEnv(env, "LIVE_ENTRY_SLIPPAGE_PCT", 0.25, 0.01);
    const liveExitSlippagePct = numberFromEnv(env, "LIVE_EXIT_SLIPPAGE_PCT", 0.25, 0.01);
    const liveArmMaxAgeMinutes = numberFromEnv(env, "LIVE_ARM_MAX_AGE_MINUTES", 60, 1);
    if (liveCapitalCapCad > 500) {
        throw new Error("LIVE_CAPITAL_CAP_CAD is capped at 500 USD by this project");
    }
    if (liveMaxOrderCad > 250 || liveMaxOrderCad > liveCapitalCapCad) {
        throw new Error("LIVE_MAX_ORDER_CAD cannot exceed 250 USD or the capital cap");
    }
    if (liveEntrySlippagePct > 0.25 || liveExitSlippagePct > 0.5) {
        throw new Error("Live slippage guards exceed this project's safety caps");
    }
    if (liveArmMaxAgeMinutes > 24 * 60) {
        throw new Error("LIVE_ARM_MAX_AGE_MINUTES cannot exceed 1440 minutes");
    }
    if (autoPaperTradingEnabled && autoLiveTradingEnabled) {
        throw new Error("AUTO_PAPER_TRADING and AUTO_LIVE_TRADING cannot both be enabled");
    }
    if (autoNewsProvider === "paper-auto" &&
        (tradingMode !== "paper" || autoLiveTradingEnabled || liveSwitchEnabled)) {
        throw new Error("AUTO_NEWS_PROVIDER=paper-auto is allowed only in paper mode with live trading disabled");
    }
    if (autoPaperTradingEnabled &&
        autoNewsProvider === "openai" &&
        !env.OPENAI_API_KEY?.trim()) {
        throw new Error("AUTO_NEWS_PROVIDER=openai requires a local OPENAI_API_KEY when AUTO_PAPER_TRADING=true");
    }
    if (telegramNotificationsEnabled &&
        (!env.TELEGRAM_BOT_TOKEN?.trim() || !env.TELEGRAM_CHAT_ID?.trim())) {
        throw new Error("Telegram notifications require TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
    }
    if (autoLiveTradingEnabled && tradingMode !== "live") {
        throw new Error("AUTO_LIVE_TRADING requires TRADING_MODE=live");
    }
    if (autoLiveTradingEnabled && (!liveSwitchEnabled || !liveAcknowledged)) {
        throw new Error(`AUTO_LIVE_TRADING requires ENABLE_LIVE_TRADING=true and LIVE_TRADING_ACK=${LIVE_ACKNOWLEDGEMENT}`);
    }
    if (autoLiveTradingEnabled && (!env.KRAKEN_API_KEY || !env.KRAKEN_API_SECRET)) {
        throw new Error("AUTO_LIVE_TRADING requires local Kraken API credentials");
    }
    if (autoLiveTradingEnabled &&
        process.cwd().toLowerCase().includes("onedrive")) {
        throw new Error("Live mode is blocked inside a OneDrive-synced folder; move the project to a local non-synced directory");
    }
    return {
        tradingMode,
        selfImprovementEnabled: booleanFromEnv(env.SELF_IMPROVEMENT_ENABLED, true),
        host: env.HOST || "127.0.0.1",
        port: numberFromEnv(env, "PORT", 3000, 1),
        krakenBaseUrl: env.KRAKEN_BASE_URL || "https://api.kraken.com",
        dataDir,
        paperStartingCad: numberFromEnv(env, "PAPER_STARTING_CAD", 500, 10),
        paperTradeTarget,
        riskPerTradePct,
        dailyLossLimitPct,
        maxExposurePct,
        rewardRisk: numberFromEnv(env, "REWARD_RISK", 2, 2),
        makerFeePct: numberFromEnv(env, "KRAKEN_MAKER_FEE_PCT", 0.25),
        takerFeePct: numberFromEnv(env, "KRAKEN_TAKER_FEE_PCT", 0.4),
        slippagePct: numberFromEnv(env, "SLIPPAGE_ALLOWANCE_PCT", 0.05),
        maxSpreadPct: numberFromEnv(env, "MAX_SPREAD_PCT", 0.25, 0.01),
        autoPaperTradingEnabled,
        shadowLoggingEnabled,
        shadowWhenDailyBlocked,
        shadowStateFile: path.resolve(env.SHADOW_STATE_FILE || path.join(dataDir, "shadow-state.json")),
        shadowJournalFile: path.resolve(env.SHADOW_JOURNAL_FILE || path.join(dataDir, "shadow-trades.jsonl")),
        autoLiveTradingEnabled,
        autoTraderPollSeconds,
        autoTraderPairs: pairsFromEnv(env.AUTO_TRADER_PAIRS, tradingMode),
        coinbaseBaseUrl: env.COINBASE_BASE_URL || "https://api.exchange.coinbase.com",
        autoNewsProvider,
        autoNewsGateFile: path.resolve(env.AUTO_NEWS_GATE_FILE || path.join(dataDir, "news-gate.json")),
        autoNewsMaxAgeSeconds,
        openAiNewsModel: env.OPENAI_NEWS_MODEL || "gpt-5.4-mini",
        openAiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
        telegramNotificationsEnabled,
        telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
        telegramChatId: env.TELEGRAM_CHAT_ID?.trim() || undefined,
        telegramNotifyStartup,
        telegramNotificationMode,
        enableKrakenOrderValidation: booleanFromEnv(env.ENABLE_KRAKEN_ORDER_VALIDATION, false),
        enableLiveOrderSubmission: tradingMode === "live" && liveSwitchEnabled && liveAcknowledged,
        liveCapitalCapCad,
        liveMaxOrderCad,
        liveEntrySlippagePct,
        liveExitSlippagePct,
        liveStateFile: path.resolve(env.LIVE_STATE_FILE || path.join(dataDir, "live-state.json")),
        liveJournalFile: path.resolve(env.LIVE_JOURNAL_FILE || path.join(dataDir, "live-trader.jsonl")),
        liveArmFile: path.resolve(env.LIVE_ARM_FILE || path.join(dataDir, "live-armed.json")),
        liveKillSwitchFile: path.resolve(env.LIVE_KILL_SWITCH_FILE || path.join(dataDir, "LIVE_STOP")),
        liveArmMaxAgeMinutes,
        krakenApiKey: env.KRAKEN_API_KEY || undefined,
        krakenApiSecret: env.KRAKEN_API_SECRET || undefined,
    };
}
