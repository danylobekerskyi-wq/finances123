import { describe, expect, it } from "vitest";
import path from "node:path";
import { loadConfig } from "../src/config.js";

describe("live configuration guards", () => {
  it("defaults to paper mode with live submission disabled", () => {
    const config = loadConfig({});
    expect(config.tradingMode).toBe("paper");
    expect(config.paperTradeTarget).toBe(100);
    expect(config.autoNewsProvider).toBe("manual");
    expect(config.openAiNewsModel).toBe("gpt-5.4-mini");
    expect(config.enableLiveOrderSubmission).toBe(false);
    expect(config.autoLiveTradingEnabled).toBe(false);
    expect(config.shadowLoggingEnabled).toBe(false);
    expect(config.shadowWhenDailyBlocked).toBe(true);
    expect(config.telegramNotificationsEnabled).toBe(false);
    expect(config.telegramNotificationMode).toBe("important");
  });

  it("requires local Telegram credentials only when notifications are enabled", () => {
    expect(() =>
      loadConfig({ TELEGRAM_NOTIFICATIONS_ENABLED: "true" }),
    ).toThrow("TELEGRAM_BOT_TOKEN");
    const config = loadConfig({
      TELEGRAM_NOTIFICATIONS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "123456:test-token-value",
      TELEGRAM_CHAT_ID: "-100123456",
    });
    expect(config.telegramNotificationsEnabled).toBe(true);
    expect(config.telegramNotifyStartup).toBe(true);
    expect(config.enableLiveOrderSubmission).toBe(false);
  });

  it("supports all Telegram event types without enabling live trading", () => {
    const config = loadConfig({
      TELEGRAM_NOTIFICATIONS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "123456:test-token-value",
      TELEGRAM_CHAT_ID: "@paper_trade_reports",
      TELEGRAM_NOTIFICATION_MODE: "all",
    });
    expect(config.telegramNotificationMode).toBe("all");
    expect(config.enableLiveOrderSubmission).toBe(false);
    expect(() =>
      loadConfig({ TELEGRAM_NOTIFICATION_MODE: "everything" }),
    ).toThrow("TELEGRAM_NOTIFICATION_MODE");
  });

  it("configures an opt-in shadow ledger without enabling live trading", () => {
    const config = loadConfig({
      SHADOW_LOGGING_ENABLED: "true",
      SHADOW_WHEN_DAILY_BLOCKED: "true",
      DATA_DIR: "./test-data",
    });
    expect(config.shadowLoggingEnabled).toBe(true);
    expect(config.shadowStateFile).toBe(
      path.resolve("./test-data", "shadow-state.json"),
    );
    expect(config.enableLiveOrderSubmission).toBe(false);
  });

  it("requires a local API key for automatic paper news search", () => {
    expect(() =>
      loadConfig({
        AUTO_PAPER_TRADING: "true",
        AUTO_NEWS_PROVIDER: "openai",
      }),
    ).toThrow("OPENAI_API_KEY");
    expect(
      loadConfig({
        AUTO_PAPER_TRADING: "true",
        AUTO_NEWS_PROVIDER: "openai",
        OPENAI_API_KEY: "local-test-key",
      }).autoNewsProvider,
    ).toBe("openai");
  });


  it("allows paper-auto news refresh only when live capability is disabled", () => {
    expect(
      loadConfig({
        TRADING_MODE: "paper",
        AUTO_PAPER_TRADING: "true",
        AUTO_NEWS_PROVIDER: "paper-auto",
      }).autoNewsProvider,
    ).toBe("paper-auto");
    expect(() =>
      loadConfig({
        TRADING_MODE: "paper",
        AUTO_NEWS_PROVIDER: "paper-auto",
        ENABLE_LIVE_TRADING: "true",
        LIVE_TRADING_ACK: "I_UNDERSTAND_REAL_MONEY_CAN_BE_LOST",
      }),
    ).toThrow("paper mode with live trading disabled");
  });

  it("accepts a bounded paper trade target", () => {
    expect(loadConfig({ PAPER_TRADE_TARGET: "25" }).paperTradeTarget).toBe(25);
    expect(() => loadConfig({ PAPER_TRADE_TARGET: "0" })).toThrow(
      "PAPER_TRADE_TARGET",
    );
    expect(() => loadConfig({ PAPER_TRADE_TARGET: "1001" })).toThrow(
      "PAPER_TRADE_TARGET",
    );
  });

  it("accepts all ten configured USD pairs in paper mode", () => {
    const pairs = [
      "BTC/USD",
      "ETH/USD",
      "SOL/USD",
      "XRP/USD",
      "ADA/USD",
      "DOGE/USD",
      "LINK/USD",
      "LTC/USD",
      "AVAX/USD",
      "DOT/USD",
    ];
    expect(
      loadConfig({
        TRADING_MODE: "paper",
        AUTO_TRADER_PAIRS: pairs.join(","),
      }).autoTraderPairs,
    ).toEqual(pairs);
  });

  it("rejects unknown pairs and keeps expanded live automation blocked", () => {
    expect(() =>
      loadConfig({ AUTO_TRADER_PAIRS: "BTC/USD,SCAM/USD" }),
    ).toThrow("AUTO_TRADER_PAIRS");
    expect(() =>
      loadConfig({
        TRADING_MODE: "live",
        AUTO_TRADER_PAIRS: "BTC/USD,SOL/USD",
      }),
    ).toThrow("live mode");
  });

  it("requires all explicit switches before autonomous live mode", () => {
    expect(() =>
      loadConfig({
        TRADING_MODE: "live",
        AUTO_LIVE_TRADING: "true",
        ENABLE_LIVE_TRADING: "true",
        KRAKEN_API_KEY: "key",
        KRAKEN_API_SECRET: "secret",
      }),
    ).toThrow("LIVE_TRADING_ACK");
  });

  it("enables live capability only with the exact acknowledgement", () => {
    const config = loadConfig({
      TRADING_MODE: "live",
      ENABLE_LIVE_TRADING: "true",
      LIVE_TRADING_ACK: "I_UNDERSTAND_REAL_MONEY_CAN_BE_LOST",
    });
    expect(config.enableLiveOrderSubmission).toBe(true);
    expect(config.liveCapitalCapCad).toBe(500);
    expect(config.liveMaxOrderCad).toBe(250);
  });

  it("rejects capital and order caps above the project limits", () => {
    expect(() => loadConfig({ LIVE_CAPITAL_CAP_CAD: "501" })).toThrow(
      "capped at 500",
    );
    expect(() => loadConfig({ LIVE_MAX_ORDER_CAD: "251" })).toThrow(
      "cannot exceed 250",
    );
  });
});
