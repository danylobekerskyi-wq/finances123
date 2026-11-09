import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperBroker } from "../src/paperBroker.js";
import { calculateLongPlan } from "../src/risk.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function brokerAt(clock: () => number): Promise<PaperBroker> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paper-broker-"));
  temporaryDirectories.push(directory);
  return new PaperBroker({
    dataFile: path.join(directory, "state.json"),
    startingBalanceCad: 500,
    dailyLossLimitPct: 2,
    feePctPerSide: 0.4,
    slippagePctPerSide: 0.05,
    clock,
  });
}

function plan() {
  return calculateLongPlan({
    balanceCad: 500,
    riskPct: 0.5,
    entry: 100,
    stop: 98,
    feePctPerSide: 0.4,
    slippagePctPerSide: 0.05,
    maxExposurePct: 50,
    rewardRisk: 2,
  });
}

describe("PaperBroker", () => {
  it("persists a simulated position and realizes fees/slippage on close", async () => {
    const broker = await brokerAt(() => Date.parse("2026-08-12T17:00:00Z"));
    const opened = await broker.openPosition("BTC/USD", plan());
    expect(opened.entryPriceCad).toBeGreaterThan(100);

    const closed = await broker.closePosition(105, "MANUAL");
    expect(closed.realizedPnlCad).toBeGreaterThan(0);
    const portfolio = await broker.getPortfolio(null);
    expect(portfolio.state.position).toBeNull();
    expect(portfolio.state.closedTrades).toHaveLength(1);
    expect(portfolio.equityCad).toBeGreaterThan(500);
  });

  it("blocks new entries after two stop exits in one Winnipeg day", async () => {
    const broker = await brokerAt(() => Date.parse("2026-08-12T17:00:00Z"));
    for (let count = 0; count < 2; count += 1) {
      await broker.openPosition("BTC/USD", plan());
      await broker.closePosition(98, "STOP");
    }
    const portfolio = await broker.getPortfolio(null);
    expect(portfolio.dailyStopCount).toBe(2);
    expect(portfolio.dailyTradingBlocked).toBe(true);
    await expect(broker.openPosition("BTC/USD", plan())).rejects.toThrow(
      "Two stop-loss exits",
    );
  });

  it("can keep a separate shadow ledger running without weakening main defaults", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "shadow-ledger-"));
    temporaryDirectories.push(directory);
    const broker = new PaperBroker({
      dataFile: path.join(directory, "state.json"),
      startingBalanceCad: 500,
      dailyLossLimitPct: 2,
      feePctPerSide: 0.4,
      slippagePctPerSide: 0.05,
      clock: () => Date.parse("2026-08-12T17:00:00Z"),
      enforceDailyRiskLimits: false,
    });
    for (let count = 0; count < 2; count += 1) {
      await broker.openPosition("BTC/USD", plan());
      await broker.closePosition(98, "STOP");
    }
    const portfolio = await broker.getPortfolio(null);
    expect(portfolio.dailyStopCount).toBe(2);
    expect(portfolio.dailyTradingBlocked).toBe(false);
    await expect(broker.openPosition("BTC/USD", plan())).resolves.toBeDefined();
  });
});
