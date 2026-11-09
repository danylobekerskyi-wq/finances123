import { describe, expect, it, vi } from "vitest";
import type { AutoTraderEvent } from "../src/autoTrader.js";
import { TelegramTradingReporter } from "../src/telegramReporter.js";
import type { TradingService } from "../src/tradingService.js";

const NOW = Date.parse("2026-08-25T12:00:00Z");

function report(position = false) {
  return {
    progress: {
      targetTrades: 100,
      closedTrades: 5,
      remainingTrades: 95,
      targetReached: false,
      wins: 1,
      losses: 4,
      breakeven: 0,
      winRatePct: 20,
      realizedPnlCad: -5.46,
      averageResultR: -0.61,
      profitFactor: 0.25,
    },
    portfolio: {
      state: {
        startingBalanceCad: 500,
        cashCad: 494.54,
        position: position
          ? {
              id: "position-2",
              pair: "BTC/USD" as const,
              units: 0.001,
              entryPriceCad: 112_000,
              entryNotionalCad: 112,
              entryFeeCad: 0.45,
              stopCad: 110_000,
              targetCad: 116_000,
              openedAt: new Date(NOW).toISOString(),
              plannedRiskCad: 2.5,
            }
          : null,
        closedTrades: [],
        updatedAt: new Date(NOW).toISOString(),
      },
      marketPriceCad: null,
      equityCad: 494.54,
      unrealizedPnlCad: 0,
      realizedPnlCad: -5.46,
      dailyRealizedPnlCad: 0,
      dailyStopCount: 0,
      dailyTradingBlocked: false,
      dailyTradingBlockReason: null,
    },
    autoClosedTrade: null,
  };
}

function createReporter(
  fetchImpl: typeof fetch,
  position = false,
  notificationMode: "important" | "all" = "important",
) {
  const service = {
    getPaperReportSnapshot: vi.fn(async () => report(position)),
  } as unknown as TradingService;
  const errors: string[] = [];
  return {
    service,
    errors,
    reporter: new TelegramTradingReporter({
      botToken: "123456:test-token-value",
      chatId: "-100123456",
      service,
      fetchImpl,
      clock: () => NOW,
      logger: (message) => errors.push(message),
      notificationMode,
    }),
  };
}

function event(
  action: AutoTraderEvent["action"],
  detail = "test",
): AutoTraderEvent {
  return {
    at: new Date(NOW).toISOString(),
    action,
    detail,
    pair: "BTC/USD",
    closedTrades: 5,
    targetTrades: 100,
    remainingTrades: 95,
  };
}

describe("TelegramTradingReporter", () => {
  it("ignores WAIT and NO_ENTRY events", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { reporter, service } = createReporter(fetchImpl);

    await expect(reporter.notify(event("NO_ENTRY"))).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.getPaperReportSnapshot).not.toHaveBeenCalled();
  });

  it("sends a detailed paper-open report without enabling live trading", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("{}", { status: 200 }),
    );
    const { reporter } = createReporter(fetchImpl, true);

    await expect(
      reporter.notify(event("PAPER_TRADE_OPENED")),
    ).resolves.toBe(true);
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { text: string };
    expect(body.text).toContain("PAPER-угоду відкрито");
    expect(body.text).toContain("BTC/USD");
    expect(body.text).toContain("Реальні ордери: ВИМКНЕНО");
  });

  it("deduplicates repeated blocker notifications for six hours", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("{}", { status: 200 }),
    );
    const { reporter } = createReporter(fetchImpl);
    const blocked = event("DAILY_BLOCKED", "Two stop-loss exits occurred");

    await expect(reporter.notify(blocked)).resolves.toBe(true);
    await expect(reporter.notify(blocked)).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not interrupt the bot when Telegram returns an error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("unauthorized", { status: 401 }),
    );
    const { reporter, errors } = createReporter(fetchImpl);

    await expect(reporter.notify(event("ERROR"))).resolves.toBe(false);
    expect(errors).toContain("Telegram send failed");
  });

  it("sends a standalone connection test", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("{}", { status: 200 }),
    );
    const { reporter } = createReporter(fetchImpl);

    await expect(reporter.sendTest()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends WAIT and NO_ENTRY events in all-events channel mode", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("{}", { status: 200 }),
    );
    const { reporter } = createReporter(fetchImpl, false, "all");

    await expect(
      reporter.notify(event("NO_ENTRY", "No confirmed setup")),
    ).resolves.toBe(true);
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { text: string };
    expect(body.text).toContain("NO_ENTRY");
    expect(body.text).toContain("No confirmed setup");
  });

  it("explains why a shadow entry was skipped", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("{}", { status: 200 }),
    );
    const { reporter } = createReporter(fetchImpl, false, "all");
    const blocked = event(
      "SHADOW_NO_ENTRY",
      "Daily protection remains active and no confirmed shadow setup exists",
    );
    blocked.decision = "WAIT_SETUP_NOT_CONFIRMED";
    blocked.blockedReason = "Two stop-loss exits occurred during the Winnipeg trading day";
    blocked.scanExplanations = [
      {
        pair: "BTC/USD",
        decision: "WAIT_SETUP_NOT_CONFIRMED",
        reasons: [
          "No latest closed 1M, 5M, or 15M candle closed above its resistance",
        ],
        reEvaluateWhen:
          "Wait for a 1M, 5M, or 15M candle to close above the highest high of its previous 20 closed candles",
      },
    ];

    await expect(reporter.notify(blocked)).resolves.toBe(true);
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { text: string };
    expect(body.text).toContain("Чому бот прийняв це рішення");
    expect(body.text).toContain("Денний PAPER-захист");
    expect(body.text).toContain("Проскановано пар: 1");
    expect(body.text).toContain("Жодна остання закрита свічка");
    expect(body.text).toContain("Що потрібно далі");
  });

  it("still sends an event when the portfolio snapshot is unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("{}", { status: 200 }),
    );
    const { reporter, service, errors } = createReporter(fetchImpl, false, "all");
    vi.mocked(service.getPaperReportSnapshot).mockRejectedValueOnce(
      new Error("Kraken timeout"),
    );

    await expect(reporter.notify(event("ERROR", "Kraken timeout"))).resolves.toBe(
      true,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(errors).toContain("Telegram report snapshot failed");
  });
});
