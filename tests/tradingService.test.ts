import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { KrakenClient } from "../src/kraken.js";
import type { PaperBroker } from "../src/paperBroker.js";
import type { ReferencePriceProvider } from "../src/referencePrice.js";
import { TradingService } from "../src/tradingService.js";
import type {
  Candle,
  ClosedPaperTrade,
  MarketSnapshot,
  PaperPortfolio,
} from "../src/types.js";

const CAPTURED_AT = "2026-08-14T20:00:00.000Z";

function candles(intervalMinutes: number): Candle[] {
  const latestOpen = Date.parse(CAPTURED_AT) / 1000 - intervalMinutes * 60;
  return Array.from({ length: 60 }, (_, index) => {
    const close = 100 + Math.sin(index / 5);
    return {
      time: latestOpen - (59 - index) * intervalMinutes * 60,
      open: close - 0.05,
      high: close + 0.2,
      low: close - 0.2,
      close,
      vwap: close,
      volume: 10,
      trades: 20,
    };
  });
}

function snapshot(): MarketSnapshot {
  return {
    ticker: {
      pair: "BTC/USD",
      ask: 100.02,
      bid: 99.98,
      last: 100,
      openUtc: 99,
      high24h: 102,
      low24h: 98,
      volume24h: 100,
    },
    candles1m: candles(1),
    candles5m: candles(5),
    candles15m: candles(15),
    candles1h: candles(60),
    capturedAt: CAPTURED_AT,
    source: "Kraken",
  };
}

describe("TradingService scan reference", () => {
  it("fetches and applies a fresh provider reference when the caller omits one", async () => {
    const getReferencePrice = vi.fn(async () => ({
      priceCad: 100,
      bidCad: 99.9,
      askCad: 100.1,
      capturedAt: CAPTURED_AT,
      source: "Coinbase Exchange" as const,
    }));
    const referencePrices: ReferencePriceProvider = { getReferencePrice };
    const kraken = {
      getSnapshot: vi.fn(async () => snapshot()),
    } as unknown as KrakenClient;
    const service = new TradingService(
      loadConfig({ SELF_IMPROVEMENT_ENABLED: "false" }),
      kraken,
      { getPortfolio: async () => ({ state: { closedTrades: [] } }) } as unknown as PaperBroker,
      referencePrices,
    );

    const response = await service.scan({ pair: "BTC/USD" });

    expect(getReferencePrice).toHaveBeenCalledWith("BTC/USD");
    expect(response.reference).toMatchObject({
      priceCad: 100,
      bidCad: 99.9,
      askCad: 100.1,
    });
    expect(response.result.decision).toBe("WAIT_SETUP_NOT_CONFIRMED");
  });

  it("reports progress using only genuinely closed paper trades", async () => {
    const trade = (
      id: string,
      realizedPnlCad: number,
      resultR: number,
    ): ClosedPaperTrade => ({
      id,
      pair: "BTC/USD",
      units: 0.1,
      entryPriceCad: 100,
      entryNotionalCad: 10,
      entryFeeCad: 0.04,
      stopCad: 98,
      targetCad: 104,
      openedAt: "2026-08-14T19:00:00.000Z",
      plannedRiskCad: 0.5,
      exitPriceCad: realizedPnlCad > 0 ? 104 : 98,
      exitFeeCad: 0.04,
      closedAt: CAPTURED_AT,
      reason: realizedPnlCad > 0 ? "TARGET" : "STOP",
      realizedPnlCad,
      resultR,
    });
    const trades = [trade("win", 2, 2), trade("loss", -0.5, -1)];
    const portfolio: PaperPortfolio = {
      state: {
        startingBalanceCad: 500,
        cashCad: 501.5,
        position: null,
        closedTrades: trades,
        updatedAt: CAPTURED_AT,
      },
      marketPriceCad: null,
      equityCad: 501.5,
      unrealizedPnlCad: 0,
      realizedPnlCad: 1.5,
      dailyRealizedPnlCad: 1.5,
      dailyStopCount: 1,
      dailyTradingBlocked: false,
      dailyTradingBlockReason: null,
    };
    const broker = {
      getState: vi.fn(async () => portfolio.state),
      getPortfolio: vi.fn(async () => portfolio),
    } as unknown as PaperBroker;
    const service = new TradingService(
      loadConfig({ PAPER_TRADE_TARGET: "3" }),
      {} as KrakenClient,
      broker,
    );

    await expect(service.getPaperTestProgress()).resolves.toMatchObject({
      progress: {
        targetTrades: 3,
        closedTrades: 2,
        remainingTrades: 1,
        targetReached: false,
        wins: 1,
        losses: 1,
        winRatePct: 50,
        realizedPnlCad: 1.5,
        averageResultR: 0.5,
        profitFactor: 4,
      },
    });
  });

  it("builds a Telegram snapshot without settling an open paper position", async () => {
    const position = {
      id: "open-1",
      pair: "BTC/USD" as const,
      units: 0.1,
      entryPriceCad: 100,
      entryNotionalCad: 10,
      entryFeeCad: 0.04,
      stopCad: 98,
      targetCad: 104,
      openedAt: CAPTURED_AT,
      plannedRiskCad: 0.5,
    };
    const state = {
      startingBalanceCad: 500,
      cashCad: 489.96,
      position,
      closedTrades: [],
      updatedAt: CAPTURED_AT,
    };
    const portfolio: PaperPortfolio = {
      state,
      marketPriceCad: 101,
      equityCad: 500.02,
      unrealizedPnlCad: 0.02,
      realizedPnlCad: 0,
      dailyRealizedPnlCad: 0,
      dailyStopCount: 0,
      dailyTradingBlocked: false,
      dailyTradingBlockReason: null,
    };
    const settleTriggeredPosition = vi.fn();
    const broker = {
      getState: vi.fn(async () => state),
      getPortfolio: vi.fn(async () => portfolio),
      settleTriggeredPosition,
    } as unknown as PaperBroker;
    const kraken = {
      getTicker: vi.fn(async () => ({ bid: 101 })),
    } as unknown as KrakenClient;
    const service = new TradingService(loadConfig({ SELF_IMPROVEMENT_ENABLED: "false" }), kraken, broker);

    await expect(service.getPaperReportSnapshot()).resolves.toMatchObject({
      portfolio: { state: { position: { id: "open-1" } } },
      progress: { closedTrades: 0, targetTrades: 100 },
    });
    expect(settleTriggeredPosition).not.toHaveBeenCalled();
    expect(broker.getPortfolio).toHaveBeenCalledWith(101);
  });
});
