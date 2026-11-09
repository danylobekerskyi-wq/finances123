import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createTradingMcpServer } from "../src/mcp.js";
import { calculateLongPlan } from "../src/risk.js";
import type { TradingService } from "../src/tradingService.js";

describe("MCP interface", () => {
  it("publishes guarded paper/live tools and returns structured risk output", async () => {
    const service = {
      calculatePlan: ({
        balanceCad,
        entry,
        stop,
      }: {
        balanceCad: number;
        entry: number;
        stop: number;
      }) =>
        calculateLongPlan({
          balanceCad,
          entry,
          stop,
          riskPct: 0.5,
          feePctPerSide: 0.4,
          slippagePctPerSide: 0.05,
          maxExposurePct: 50,
          rewardRisk: 2,
        }),
    } as unknown as TradingService;
    const server = createTradingMcpServer(service);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "calculate_trade_plan",
        "close_paper_trade",
        "get_live_status",
        "get_paper_portfolio",
        "get_paper_test_progress",
        "get_shadow_status",
        "place_paper_trade",
        "scan_market",
        "validate_kraken_order",
      ]);
      const result = await client.callTool({
        name: "calculate_trade_plan",
        arguments: { balance_cad: 500, entry_cad: 100, stop_cad: 98 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        plan: {
          riskBudgetCad: 2.5,
          positionNotionalCad: expect.any(Number),
          netRewardRisk: expect.any(Number),
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lets scan_market obtain the independent reference inside the server", async () => {
    const scan = vi.fn(async () => ({
      signalId: null,
      result: {
        decision: "WAIT_SETUP_NOT_CONFIRMED",
        pair: "SOL/USD",
      },
      reference: {
        priceCad: 100,
        bidCad: 99.9,
        askCad: 100.1,
        capturedAt: "2026-08-14T20:00:00.000Z",
        source: "Coinbase Exchange",
      },
    }));
    const service = { scan } as unknown as TradingService;
    const server = createTradingMcpServer(service);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const result = await client.callTool({
        name: "scan_market",
        arguments: {
          pair: "SOL/USD",
          news_status: "clear",
          news_checked_at: "2026-08-14T20:00:00.000Z",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(scan).toHaveBeenCalledWith({
        pair: "SOL/USD",
        newsStatus: "clear",
        newsCheckedAt: "2026-08-14T20:00:00.000Z",
      });
      expect(result.structuredContent).toMatchObject({
        signalId: null,
        reference: {
          bidCad: 99.9,
          askCad: 100.1,
          source: "Coinbase Exchange",
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
