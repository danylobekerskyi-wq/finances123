import { describe, expect, it, vi } from "vitest";
import {
  AutoPaperTrader,
  type AutoTraderEvent,
} from "../src/autoTrader.js";
import type { NewsGateProvider } from "../src/newsGate.js";
import type { ReferencePriceProvider } from "../src/referencePrice.js";
import type { TradingService } from "../src/tradingService.js";
import { KrakenApiError } from "../src/kraken.js";
import type { PaperPortfolio, SupportedPair } from "../src/types.js";
import type { ShadowBroker } from "../src/shadowBroker.js";

const NOW = Date.parse("2026-08-13T20:00:00Z");

function portfolio(overrides: Partial<PaperPortfolio> = {}): PaperPortfolio {
  return {
    state: {
      startingBalanceCad: 500,
      cashCad: 500,
      position: null,
      closedTrades: [],
      updatedAt: new Date(NOW).toISOString(),
    },
    marketPriceCad: null,
    equityCad: 500,
    unrealizedPnlCad: 0,
    realizedPnlCad: 0,
    dailyRealizedPnlCad: 0,
    dailyStopCount: 0,
    dailyTradingBlocked: false,
    dailyTradingBlockReason: null,
    ...overrides,
  };
}

function referencePrices(): ReferencePriceProvider {
  return {
    getReferencePrice: vi.fn(async () => ({
      priceCad: 100,
      capturedAt: new Date(NOW).toISOString(),
      source: "Coinbase Exchange" as const,
    })),
  };
}

function newsGate(checkedAt = new Date(NOW).toISOString()): NewsGateProvider {
  return {
    getNewsStatus: vi.fn(async () => ({
      status: "clear" as const,
      checkedAt,
      note: "Checked macro calendar and current headlines",
    })),
  };
}

function trader(service: TradingService, gate = newsGate()) {
  const events: AutoTraderEvent[] = [];
  return {
    events,
    value: new AutoPaperTrader({
      service,
      referencePrices: referencePrices(),
      newsGate: gate,
      journal: { record: vi.fn(async (event) => void events.push(event)) },
      pairs: ["BTC/USD", "ETH/USD"],
      pollSeconds: 60,
      tradeTarget: 100,
      newsMaxAgeSeconds: 900,
      clock: () => NOW,
      logger: () => undefined,
    }),
  };
}

describe("AutoPaperTrader", () => {
  it("opens only a paper position after a confirmed signal", async () => {
    const placePaperTrade = vi.fn(async () => ({}));
    const scan = vi
      .fn()
      .mockResolvedValueOnce({
        signalId: null,
        result: {
          decision: "NO_TRADE_NEWS_CHECK_REQUIRED",
          capturedAt: new Date(NOW).toISOString(),
          setup15m: "RANGE_REVERSAL",
          trigger5m: true,
        },
      })
      .mockResolvedValueOnce({
        signalId: "signal-1",
        result: { decision: "BUY_SETUP_CONFIRMED" },
      });
    const service = {
      getPaperPortfolio: vi.fn(async () => ({
        portfolio: portfolio(),
        autoClosedTrade: null,
      })),
      scan,
      placePaperTrade,
    } as unknown as TradingService;
    const auto = trader(service);

    await expect(auto.value.runOnce()).resolves.toMatchObject({
      action: "PAPER_TRADE_OPENED",
      pair: "BTC/USD",
    });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(placePaperTrade).toHaveBeenCalledWith("signal-1");
    expect(auto.events).toHaveLength(1);
  });

  it("stops opening new positions after 100 closed paper trades", async () => {
    const scan = vi.fn();
    const completed = portfolio();
    completed.state.closedTrades = Array.from({ length: 100 }, (_, index) => ({
      id: `position-${index}`,
      pair: "BTC/USD" as const,
      units: 0.1,
      entryPriceCad: 100,
      entryNotionalCad: 10,
      entryFeeCad: 0.04,
      stopCad: 98,
      targetCad: 104,
      openedAt: new Date(NOW - 60_000).toISOString(),
      plannedRiskCad: 0.3,
      exitPriceCad: 104,
      exitFeeCad: 0.04,
      closedAt: new Date(NOW).toISOString(),
      reason: "TARGET" as const,
      realizedPnlCad: 0.32,
      resultR: 1.067,
    }));
    const service = {
      getPaperPortfolio: vi.fn(async () => ({
        portfolio: completed,
        autoClosedTrade: null,
      })),
      scan,
    } as unknown as TradingService;
    const auto = trader(service);

    await expect(auto.value.runOnce()).resolves.toMatchObject({
      action: "PAPER_TARGET_REACHED",
      closedTrades: 100,
      targetTrades: 100,
      remainingTrades: 0,
    });
    expect(scan).not.toHaveBeenCalled();
  });

  it("fails closed when the news check is stale", async () => {
    const scan = vi.fn(async () => ({
      signalId: null,
      result: {
        decision: "NO_TRADE_NEWS_CHECK_REQUIRED",
        capturedAt: new Date(NOW).toISOString(),
        setup15m: "RANGE_REVERSAL",
        trigger5m: true,
      },
    }));
    const service = {
      getPaperPortfolio: vi.fn(async () => ({
        portfolio: portfolio(),
        autoClosedTrade: null,
      })),
      scan,
    } as unknown as TradingService;
    const stale = new Date(NOW - 16 * 60 * 1000).toISOString();
    const auto = trader(service, newsGate(stale));

    await expect(auto.value.runOnce()).resolves.toMatchObject({
      action: "NEWS_GATE_BLOCKED",
    });
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("does not request news when no technical candidate exists", async () => {
    const gate = newsGate();
    const service = {
      getPaperPortfolio: vi.fn(async () => ({
        portfolio: portfolio(),
        autoClosedTrade: null,
      })),
      scan: vi.fn(async () => ({
        signalId: null,
        result: {
          decision: "WAIT_SETUP_NOT_CONFIRMED",
          capturedAt: new Date(NOW).toISOString(),
          setup15m: "NONE",
          trigger5m: false,
          triggerTimeframe: null,
          reasons: [
            "No latest closed 1M, 5M, or 15M candle closed above its resistance",
          ],
          reEvaluateWhen:
            "Wait for a 1M, 5M, or 15M candle to close above the highest high of its previous 20 closed candles",
        },
      })),
    } as unknown as TradingService;

    await expect(trader(service, gate).value.runOnce()).resolves.toMatchObject({
      action: "NO_ENTRY",
      decision: "WAIT_SETUP_NOT_CONFIRMED",
      scanExplanations: [
        expect.objectContaining({
          pair: "BTC/USD",
          decision: "WAIT_SETUP_NOT_CONFIRMED",
          reasons: expect.arrayContaining([
            expect.stringContaining("No latest closed"),
          ]),
        }),
        expect.objectContaining({ pair: "ETH/USD" }),
      ],
    });
    expect(gate.getNewsStatus).not.toHaveBeenCalled();
  });

  it("does not scan for another entry while a position is open", async () => {
    const scan = vi.fn();
    const open = portfolio();
    open.state.position = {
      id: "position-1",
      pair: "ETH/USD",
      units: 0.1,
      entryPriceCad: 100,
      entryNotionalCad: 10,
      entryFeeCad: 0.04,
      stopCad: 98,
      targetCad: 105,
      openedAt: new Date(NOW).toISOString(),
      plannedRiskCad: 0.3,
    };
    const service = {
      getPaperPortfolio: vi.fn(async () => ({
        portfolio: open,
        autoClosedTrade: null,
      })),
      scan,
    } as unknown as TradingService;
    const auto = trader(service);

    await expect(auto.value.runOnce()).resolves.toMatchObject({
      action: "POSITION_OPEN",
      pair: "ETH/USD",
    });
    expect(scan).not.toHaveBeenCalled();
  });

  it("skips an unavailable Kraken pair and continues scanning valid pairs", async () => {
    const events: AutoTraderEvent[] = [];
    const scan = vi.fn(async () => ({
      signalId: null,
      result: {
        decision: "WAIT_SETUP_NOT_CONFIRMED",
        capturedAt: new Date(NOW).toISOString(),
        setup15m: "NONE",
        trigger5m: false,
      },
    }));
    const service = {
      getPaperPortfolio: vi.fn(async () => ({
        portfolio: portfolio(),
        autoClosedTrade: null,
      })),
      scan,
    } as unknown as TradingService;
    const validatePair = vi.fn(async (pair: SupportedPair) => {
      if (pair === "ADA/USD") {
        throw new KrakenApiError("/0/public/AssetPairs (pair=ADAUSD)", [
          "EQuery:Invalid asset pair",
        ]);
      }
    });
    const auto = new AutoPaperTrader({
      service,
      referencePrices: referencePrices(),
      newsGate: newsGate(),
      journal: { record: vi.fn(async (event) => void events.push(event)) },
      pairs: ["ADA/USD", "BTC/USD"],
      pollSeconds: 60,
      tradeTarget: 100,
      newsMaxAgeSeconds: 900,
      validatePair,
      clock: () => NOW,
      logger: () => undefined,
    });

    await expect(auto.runOnce()).resolves.toMatchObject({ action: "NO_ENTRY" });
    expect(events[0]).toMatchObject({
      action: "PAIR_SKIPPED",
      pair: "ADA/USD",
    });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith(
      expect.objectContaining({ pair: "BTC/USD" }),
    );

    await auto.runOnce();
    expect(validatePair).toHaveBeenCalledTimes(2);
    expect(
      events.filter((event) => event.action === "PAIR_SKIPPED"),
    ).toHaveLength(1);
  });

  it("records a confirmed shadow trade while main daily protection stays active", async () => {
    const blocked = portfolio({
      dailyTradingBlocked: true,
      dailyTradingBlockReason:
        "Two stop-loss exits occurred during the Winnipeg trading day",
    });
    const scan = vi
      .fn()
      .mockResolvedValueOnce({
        signalId: null,
        result: {
          decision: "NO_TRADE_NEWS_CHECK_REQUIRED",
          capturedAt: new Date(NOW).toISOString(),
          setup15m: "BREAKOUT_CLOSE",
          trigger5m: true,
          triggerTimeframe: "5M",
        },
      })
      .mockResolvedValueOnce({
        signalId: "shadow-signal",
        result: { decision: "BUY_SETUP_CONFIRMED" },
      });
    const prepared = {
      pair: "BTC/USD" as const,
      plan: { entry: 100, stop: 98, minimumTarget: 105 },
      signal: {
        decision: "BUY_SETUP_CONFIRMED",
        pair: "BTC/USD",
        triggerTimeframe: "5M",
      },
    };
    const service = {
      getPaperPortfolio: vi.fn(async () => ({
        portfolio: blocked,
        autoClosedTrade: null,
      })),
      scan,
      prepareSimulatedTrade: vi.fn(async () => prepared),
    } as unknown as TradingService;
    const openPosition = vi.fn(async () => ({}));
    const shadowBroker = {
      getShadowStatus: vi.fn(async () => ({
        status: {
          mode: "shadow",
          portfolio: portfolio(),
          closedTrades: 0,
          wins: 0,
          losses: 0,
          breakeven: 0,
          winRatePct: 0,
          realizedPnlCad: 0,
          averageResultR: 0,
          profitFactor: null,
        },
        autoClosedTrade: null,
      })),
      openPosition,
    } as unknown as ShadowBroker;
    const events: AutoTraderEvent[] = [];
    const auto = new AutoPaperTrader({
      service,
      shadowBroker,
      shadowWhenDailyBlocked: true,
      referencePrices: referencePrices(),
      newsGate: newsGate(),
      journal: { record: vi.fn(async (event) => void events.push(event)) },
      pairs: ["BTC/USD"],
      pollSeconds: 60,
      tradeTarget: 100,
      newsMaxAgeSeconds: 900,
      clock: () => NOW,
      logger: () => undefined,
    });

    await expect(auto.runOnce()).resolves.toMatchObject({
      action: "SHADOW_TRADE_OPENED",
      closedTrades: 0,
      shadowClosedTrades: 0,
    });
    expect(openPosition).toHaveBeenCalledWith(
      "BTC/USD",
      prepared.plan,
      prepared.signal,
      blocked.dailyTradingBlockReason,
    );
    expect(blocked.state.position).toBeNull();
  });

  it("reports an explicit error instead of silently falling back when shadow was requested", async () => {
    const blocked = portfolio({
      dailyTradingBlocked: true,
      dailyTradingBlockReason:
        "Two stop-loss exits occurred during the Winnipeg trading day",
    });
    const service = {
      getPaperPortfolio: vi.fn(async () => ({
        portfolio: blocked,
        autoClosedTrade: null,
      })),
    } as unknown as TradingService;
    const auto = new AutoPaperTrader({
      service,
      shadowWhenDailyBlocked: true,
      referencePrices: referencePrices(),
      newsGate: newsGate(),
      journal: { record: vi.fn(async () => undefined) },
      pairs: ["BTC/USD"],
      pollSeconds: 60,
      tradeTarget: 100,
      newsMaxAgeSeconds: 900,
      clock: () => NOW,
      logger: () => undefined,
    });

    await expect(auto.runOnce()).resolves.toMatchObject({
      action: "ERROR",
      detail: expect.stringContaining("isolated broker is unavailable"),
      closedTrades: 0,
    });
  });
});
