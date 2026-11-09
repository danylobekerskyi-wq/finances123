import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { calculateLongPlan } from "../src/risk.js";
import { ShadowBroker } from "../src/shadowBroker.js";
import type { ScanResult } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ShadowBroker", () => {
  it("persists and closes a separate simulated trade with training context", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "shadow-broker-"));
    temporaryDirectories.push(directory);
    let bid = 100;
    const broker = new ShadowBroker({
      dataFile: path.join(directory, "shadow-state.json"),
      journalFile: path.join(directory, "shadow-trades.jsonl"),
      startingBalanceCad: 500,
      dailyLossLimitPct: 1,
      feePctPerSide: 0.4,
      slippagePctPerSide: 0.05,
      clock: () => Date.parse("2026-08-16T20:00:00Z"),
      getTicker: async (pair) => ({
        pair,
        ask: bid + 0.1,
        bid,
        last: bid,
        openUtc: 100,
        high24h: 105,
        low24h: 95,
        volume24h: 1_000,
      }),
    });
    const plan = calculateLongPlan({
      balanceCad: 500,
      riskPct: 0.5,
      entry: 100,
      stop: 98,
      feePctPerSide: 0.4,
      slippagePctPerSide: 0.05,
      maxExposurePct: 50,
      rewardRisk: 2,
    });
    const signal = {
      decision: "BUY_SETUP_CONFIRMED",
      pair: "BTC/USD",
      triggerTimeframe: "5M",
      plan,
    } as ScanResult;

    await broker.openPosition(
      "BTC/USD",
      plan,
      signal,
      "Two stop-loss exits occurred during the Winnipeg trading day",
    );
    bid = 97;
    const result = await broker.getShadowStatus();
    expect(result.autoClosedTrade).toMatchObject({ reason: "STOP" });
    expect(result.status.closedTrades).toBe(1);
    expect(result.status.portfolio.dailyTradingBlocked).toBe(false);

    const lines = (await readFile(
      path.join(directory, "shadow-trades.jsonl"),
      "utf8",
    ))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.action)).toEqual([
      "SHADOW_TRADE_OPENED",
      "SHADOW_TRADE_CLOSED",
    ]);
    expect(lines[0].signal.triggerTimeframe).toBe("5M");
  });
});
