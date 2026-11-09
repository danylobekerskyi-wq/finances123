import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PaperBroker } from "./paperBroker.js";
function statistics(portfolio) {
    const trades = portfolio.state.closedTrades;
    const wins = trades.filter((trade) => trade.realizedPnlCad > 0).length;
    const losses = trades.filter((trade) => trade.realizedPnlCad < 0).length;
    const breakeven = trades.length - wins - losses;
    const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.realizedPnlCad), 0);
    const grossLoss = Math.abs(trades.reduce((sum, trade) => sum + Math.min(0, trade.realizedPnlCad), 0));
    return {
        mode: "shadow",
        portfolio,
        closedTrades: trades.length,
        wins,
        losses,
        breakeven,
        winRatePct: trades.length > 0 ? (wins / trades.length) * 100 : 0,
        realizedPnlCad: portfolio.realizedPnlCad,
        averageResultR: trades.length > 0
            ? trades.reduce((sum, trade) => sum + trade.resultR, 0) /
                trades.length
            : 0,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    };
}
export class ShadowBroker {
    broker;
    journalFile;
    getTicker;
    clock;
    constructor(options) {
        this.broker = new PaperBroker({
            dataFile: options.dataFile,
            startingBalanceCad: options.startingBalanceCad,
            dailyLossLimitPct: options.dailyLossLimitPct,
            feePctPerSide: options.feePctPerSide,
            slippagePctPerSide: options.slippagePctPerSide,
            clock: options.clock,
            enforceDailyRiskLimits: false,
        });
        this.journalFile = path.resolve(options.journalFile);
        this.getTicker = options.getTicker;
        this.clock = options.clock || Date.now;
    }
    async record(event) {
        await mkdir(path.dirname(this.journalFile), { recursive: true });
        await appendFile(this.journalFile, `${JSON.stringify(event)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
    }
    async openPosition(pair, plan, signal, blockedReason) {
        const position = await this.broker.openPosition(pair, plan);
        await this.record({
            at: new Date(this.clock()).toISOString(),
            action: "SHADOW_TRADE_OPENED",
            blockedReason,
            pair,
            position,
            signal,
        });
        return position;
    }
    async getShadowStatus() {
        const state = await this.broker.getState();
        if (!state.position) {
            return {
                status: statistics(await this.broker.getPortfolio(null)),
                autoClosedTrade: null,
            };
        }
        const ticker = await this.getTicker(state.position.pair);
        const autoClosedTrade = await this.broker.settleTriggeredPosition(ticker.bid);
        if (autoClosedTrade) {
            await this.record({
                at: new Date(this.clock()).toISOString(),
                action: "SHADOW_TRADE_CLOSED",
                blockedReason: "Main paper daily risk protection was active at entry",
                pair: autoClosedTrade.pair,
                trade: autoClosedTrade,
            });
        }
        return {
            status: statistics(await this.broker.getPortfolio(autoClosedTrade ? null : ticker.bid)),
            autoClosedTrade,
        };
    }
}
