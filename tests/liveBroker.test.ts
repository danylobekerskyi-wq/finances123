import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  KrakenClient,
  KrakenOrderInfo,
  KrakenPairRules,
} from "../src/kraken.js";
import { KrakenLiveBroker } from "../src/liveBroker.js";
import { calculateLongPlan } from "../src/risk.js";

const directories: string[] = [];
const REQUIRED_PERMISSIONS = [
  "query-funds",
  "query-open-trades",
  "query-closed-trades",
  "modify-trades",
  "close-trades",
];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function order(input: Partial<KrakenOrderInfo> & {
  type: "buy" | "sell";
  ordertype: string;
  volume: number;
  price: number;
  cost: number;
  fee: number;
}): KrakenOrderInfo {
  return {
    refid: input.refid ?? null,
    status: input.status || "closed",
    opentm: 1,
    descr: {
      pair: "XBTUSD",
      type: input.type,
      ordertype: input.ordertype,
      price: String(input.price),
      price2: "0",
      leverage: "none",
      order: "",
      close: "",
    },
    vol: String(input.volume),
    vol_exec: String(input.volume),
    cost: String(input.cost),
    fee: String(input.fee),
    price: String(input.price),
  };
}

async function fakeRuntime(extraPermission?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "live-broker-"));
  directories.push(directory);
  let cad = 500;
  let btc = 0;
  let marketBid = 100;
  const openOrders: Record<string, KrakenOrderInfo> = {};
  const queried: Record<string, KrakenOrderInfo> = {};
  const rules: KrakenPairRules = {
    pair: "BTC/USD",
    altname: "XBTUSD",
    priceDecimals: 2,
    lotDecimals: 8,
    orderMinimum: 0.0001,
    costMinimum: 0.5,
    tickSize: 0.01,
    status: "online",
  };
  const client = {
    getApiKeyInfo: vi.fn(async () => ({
      apiKeyName: "live-bot",
      permissions: extraPermission
        ? [...REQUIRED_PERMISSIONS, extraPermission]
        : REQUIRED_PERMISSIONS,
      ipAllowlist: [],
      validUntil: "0",
    })),
    getAccountBalances: vi.fn(async () => ({ ZUSD: cad, XXBT: btc })),
    getOpenOrders: vi.fn(async () => structuredClone(openOrders)),
    getClosedOrders: vi.fn(async () => ({})),
    queryOrders: vi.fn(async (ids: string[]) =>
      Object.fromEntries(
        ids.filter((id) => queried[id]).map((id) => [id, queried[id]]),
      ),
    ),
    getTicker: vi.fn(async () => ({
      pair: "BTC/USD" as const,
      ask: marketBid + 0.05,
      bid: marketBid,
      last: marketBid,
      openUtc: marketBid,
      high24h: marketBid,
      low24h: marketBid,
      volume24h: 1,
    })),
    getPairRules: vi.fn(async () => rules),
    placeFokLongWithStop: vi.fn(async (input: { volume: string }) => {
      const units = Number(input.volume);
      const cost = units * 100.05;
      const fee = cost * 0.004;
      cad -= cost + fee;
      btc += units;
      queried["ENTRY-1"] = order({
        type: "buy",
        ordertype: "limit",
        volume: units,
        price: 100.05,
        cost,
        fee,
      });
      openOrders["STOP-1"] = order({
        refid: "ENTRY-1",
        status: "open",
        type: "sell",
        ordertype: "stop-loss",
        volume: units,
        price: 98,
        cost: 0,
        fee: 0,
      });
      openOrders["STOP-1"].vol_exec = "0";
      return { txid: ["ENTRY-1"] };
    }),
    placeProtectiveStop: vi.fn(async () => ({ txid: ["STOP-2"] })),
    cancelOrder: vi.fn(async (txid: string) => {
      delete openOrders[txid];
      return { count: 1 };
    }),
    placeFokSell: vi.fn(async (input: { volume: string }) => {
      const units = Number(input.volume);
      const cost = units * marketBid;
      const fee = cost * 0.004;
      btc -= units;
      cad += cost - fee;
      queried["EXIT-1"] = order({
        type: "sell",
        ordertype: "limit",
        volume: units,
        price: marketBid,
        cost,
        fee,
      });
      return { txid: ["EXIT-1"] };
    }),
  };
  const broker = new KrakenLiveBroker({
    client: client as unknown as KrakenClient,
    stateFile: path.join(directory, "live-state.json"),
    capitalCapCad: 500,
    maxOrderCad: 250,
    dailyLossLimitPct: 1,
    entrySlippagePct: 0.25,
    exitSlippagePct: 0.25,
    clock: () => Date.parse("2026-08-13T20:00:00Z"),
    sleep: async () => undefined,
  });
  return {
    broker,
    client,
    setMarketBid: (value: number) => {
      marketBid = value;
    },
  };
}

describe("KrakenLiveBroker", () => {
  it("opens one FOK long with an exchange stop and closes it at target", async () => {
    const runtime = await fakeRuntime();
    const plan = calculateLongPlan({
      balanceCad: 500,
      riskPct: 0.5,
      entry: 100.25,
      stop: 98,
      feePctPerSide: 0.4,
      slippagePctPerSide: 0.25,
      maxExposurePct: 50,
      rewardRisk: 2,
    });

    const opened = await runtime.broker.openLong("BTC/USD", plan);
    expect(opened).toMatchObject({
      entryOrderTxid: "ENTRY-1",
      protectiveOrderTxid: "STOP-1",
    });
    expect(runtime.client.placeFokLongWithStop).toHaveBeenCalledTimes(1);

    runtime.setMarketBid((opened?.targetCad || 0) + 1);
    const closed = await runtime.broker.closeAtTarget();
    expect(closed).toMatchObject({ reason: "TARGET", exitOrderTxid: "EXIT-1" });
    expect(closed?.realizedPnlCad).toBeGreaterThan(0);
    expect(runtime.client.cancelOrder).toHaveBeenCalledWith("STOP-1");
  });

  it("rejects any unnecessary permission, including withdrawals", async () => {
    const runtime = await fakeRuntime("withdraw-funds");
    await expect(runtime.broker.inspect()).rejects.toThrow(
      "forbidden or unnecessary permissions: withdraw-funds",
    );
    expect(runtime.client.placeFokLongWithStop).not.toHaveBeenCalled();
  });
});
