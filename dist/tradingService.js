import { learnedRiskMultiplier } from "./fibonacci.js";
import { randomUUID } from "node:crypto";
import { calculateLongPlan } from "./risk.js";
import { evaluateSnapshot } from "./strategy.js";
export class TradingService {
    config;
    kraken;
    broker;
    referencePrices;
    clock;
    signals = new Map();
    constructor(config, kraken, broker, referencePrices, clock = Date.now) {
        this.config = config;
        this.kraken = kraken;
        this.broker = broker;
        this.referencePrices = referencePrices;
        this.clock = clock;
    }
    strategyOptions(input) {
        return {
            strategy: "fibonacci",
            balanceCad: input.balanceCad ?? this.config.paperStartingCad,
            riskPct: this.config.riskPerTradePct,
            maxExposurePct: this.config.maxExposurePct,
            rewardRisk: this.config.rewardRisk,
            feePctPerSide: this.config.takerFeePct,
            slippagePctPerSide: this.config.slippagePct,
            maxSpreadPct: this.config.maxSpreadPct,
            referencePriceCad: input.referencePriceCad,
            referencePriceCapturedAt: input.referencePriceCapturedAt,
            newsStatus: input.newsStatus,
            newsCheckedAt: input.newsCheckedAt,
        };
    }
    purgeExpiredSignals() {
        const now = this.clock();
        for (const [id, signal] of this.signals) {
            const expiry = signal.result.signalExpiresAt
                ? Date.parse(signal.result.signalExpiresAt)
                : 0;
            if (!expiry || expiry < now)
                this.signals.delete(id);
        }
    }
    async scan(input) {
        if (input.balanceCad !== undefined &&
            (!Number.isFinite(input.balanceCad) ||
                input.balanceCad < 10 ||
                input.balanceCad > 500)) {
            throw new Error("Scan balance must be between 10 and 500 USD");
        }
        this.purgeExpiredSignals();
        const shouldFetchReference = input.referencePriceCad === undefined &&
            input.referencePriceCapturedAt === undefined &&
            this.referencePrices !== undefined;
        const [snapshot, fetchedReference] = await Promise.all([
            this.kraken.getSnapshot(input.pair),
            shouldFetchReference
                ? this.referencePrices.getReferencePrice(input.pair)
                : Promise.resolve(null),
        ]);
        const effectiveInput = fetchedReference
            ? {
                ...input,
                referencePriceCad: fetchedReference.priceCad,
                referencePriceCapturedAt: fetchedReference.capturedAt,
            }
            : input;
        const memory = await this.broker.getPortfolio(null);
        const riskMultiplier = learnedRiskMultiplier(memory.state.closedTrades.map(t => t.resultR));
        const result = evaluateSnapshot(snapshot, { ...this.strategyOptions(effectiveInput), riskPct: this.config.riskPerTradePct * riskMultiplier });
        if (result.decision !== "BUY_SETUP_CONFIRMED") {
            return { signalId: null, result, reference: fetchedReference };
        }
        const id = randomUUID();
        this.signals.set(id, {
            id,
            result,
            createdAt: new Date(this.clock()).toISOString(),
        });
        return { signalId: id, result, reference: fetchedReference };
    }
    calculatePlan(input) {
        return calculateLongPlan({
            ...input,
            riskPct: input.riskPct ?? this.config.riskPerTradePct,
            maxExposurePct: input.maxExposurePct ?? this.config.maxExposurePct,
            rewardRisk: input.rewardRisk ?? this.config.rewardRisk,
            feePctPerSide: this.config.takerFeePct,
            slippagePctPerSide: this.config.slippagePct,
        });
    }
    async placePaperTrade(signalId) {
        const portfolio = await this.broker.getPortfolio(null);
        const prepared = await this.prepareSimulatedTrade(signalId, portfolio.equityCad);
        const position = await this.broker.openPosition(prepared.pair, prepared.plan);
        return {
            position,
            plan: prepared.plan,
            currentAskCad: prepared.currentAskCad,
        };
    }
    async prepareSimulatedTrade(signalId, balanceCad) {
        this.purgeExpiredSignals();
        const signal = this.signals.get(signalId);
        if (!signal || signal.result.decision !== "BUY_SETUP_CONFIRMED" || !signal.result.plan) {
            throw new Error("Signal is missing, expired, or not executable");
        }
        if (!Number.isFinite(balanceCad) || balanceCad < 10 || balanceCad > 500) {
            throw new Error("Simulated trading balance must be between 10 and 500 USD");
        }
        const ticker = await this.kraken.getTicker(signal.result.pair);
        const maximumEntry = signal.result.plan.entry * 1.0025;
        if (ticker.ask > maximumEntry) {
            this.signals.delete(signalId);
            throw new Error("Current ask moved more than 0.25% above the approved entry");
        }
        if (ticker.ask <= signal.result.plan.stop) {
            this.signals.delete(signalId);
            throw new Error("The signal was invalidated before paper execution");
        }
        const plan = calculateLongPlan({
            balanceCad,
            riskPct: this.config.riskPerTradePct * learnedRiskMultiplier((await this.broker.getPortfolio(null)).state.closedTrades.map(t => t.resultR)),
            entry: ticker.ask,
            stop: signal.result.plan.stop,
            feePctPerSide: this.config.takerFeePct,
            slippagePctPerSide: this.config.slippagePct,
            maxExposurePct: this.config.maxExposurePct,
            rewardRisk: this.config.rewardRisk,
        });
        plan.maxHoldingMinutes = signal.result.plan.maxHoldingMinutes;
        if (plan.positionNotionalCad < 10 || plan.targetDistancePct > 4) {
            this.signals.delete(signalId);
            throw new Error("Repriced simulated trade no longer satisfies minimum size and cost rules");
        }
        this.signals.delete(signalId);
        return {
            pair: signal.result.pair,
            plan,
            currentAskCad: ticker.ask,
            signal: structuredClone(signal.result),
        };
    }
    async getMarketTicker(pair) {
        return this.kraken.getTicker(pair);
    }
    async prepareLiveTrade(signalId, balanceCad, maximumEntrySlippagePct) {
        this.purgeExpiredSignals();
        const signal = this.signals.get(signalId);
        if (!signal || signal.result.decision !== "BUY_SETUP_CONFIRMED" || !signal.result.plan) {
            throw new Error("Signal is missing, expired, or not executable");
        }
        if (!Number.isFinite(balanceCad) || balanceCad < 10 || balanceCad > 500) {
            throw new Error("Live trading balance must be between 10 and 500 USD");
        }
        if (!Number.isFinite(maximumEntrySlippagePct) ||
            maximumEntrySlippagePct <= 0 ||
            maximumEntrySlippagePct > 0.25) {
            throw new Error("Live entry slippage guard must be between 0 and 0.25%");
        }
        const ticker = await this.kraken.getTicker(signal.result.pair);
        const approvedMaximum = signal.result.plan.entry * 1.0025;
        const entryLimit = ticker.ask * (1 + maximumEntrySlippagePct / 100);
        if (entryLimit > approvedMaximum) {
            this.signals.delete(signalId);
            throw new Error("Risk-bounded FOK limit moved above the approved signal range");
        }
        if (ticker.ask <= signal.result.plan.stop) {
            this.signals.delete(signalId);
            throw new Error("The signal was invalidated before live execution");
        }
        const plan = calculateLongPlan({
            balanceCad,
            riskPct: this.config.riskPerTradePct,
            entry: entryLimit,
            stop: signal.result.plan.stop,
            feePctPerSide: this.config.takerFeePct,
            slippagePctPerSide: Math.max(this.config.slippagePct, maximumEntrySlippagePct),
            maxExposurePct: this.config.maxExposurePct,
            rewardRisk: this.config.rewardRisk,
        });
        this.signals.delete(signalId);
        if (plan.positionNotionalCad < 10 || plan.targetDistancePct > 4) {
            throw new Error("Repriced live trade no longer satisfies size and cost rules");
        }
        return {
            pair: signal.result.pair,
            plan,
            currentAskCad: ticker.ask,
        };
    }
    async synchronizeOpenPosition() {
        const state = await this.broker.getState();
        if (!state.position)
            return { marketPriceCad: null, autoClosed: null };
        const ticker = await this.kraken.getTicker(state.position.pair);
        const autoClosed = await this.broker.settleTriggeredPosition(ticker.bid);
        return {
            marketPriceCad: autoClosed ? null : ticker.bid,
            autoClosed,
        };
    }
    async getPaperPortfolio() {
        const synchronized = await this.synchronizeOpenPosition();
        return {
            portfolio: await this.broker.getPortfolio(synchronized.marketPriceCad),
            autoClosedTrade: synchronized.autoClosed,
        };
    }
    async getPaperTestProgress() {
        const status = await this.getPaperPortfolio();
        return { ...status, progress: this.paperProgress(status.portfolio) };
    }
    async getPaperReportSnapshot() {
        const state = await this.broker.getState();
        const marketPriceCad = state.position
            ? (await this.kraken.getTicker(state.position.pair)).bid
            : null;
        const portfolio = await this.broker.getPortfolio(marketPriceCad);
        return { portfolio, progress: this.paperProgress(portfolio) };
    }
    paperProgress(portfolio) {
        const trades = portfolio.state.closedTrades;
        const wins = trades.filter((trade) => trade.realizedPnlCad > 0).length;
        const losses = trades.filter((trade) => trade.realizedPnlCad < 0).length;
        const breakeven = trades.length - wins - losses;
        const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.realizedPnlCad), 0);
        const grossLoss = Math.abs(trades.reduce((sum, trade) => sum + Math.min(0, trade.realizedPnlCad), 0));
        const closedTrades = trades.length;
        const progress = {
            targetTrades: this.config.paperTradeTarget,
            closedTrades,
            remainingTrades: Math.max(0, this.config.paperTradeTarget - closedTrades),
            targetReached: closedTrades >= this.config.paperTradeTarget,
            wins,
            losses,
            breakeven,
            winRatePct: closedTrades > 0 ? (wins / closedTrades) * 100 : 0,
            realizedPnlCad: portfolio.realizedPnlCad,
            averageResultR: closedTrades > 0
                ? trades.reduce((sum, trade) => sum + trade.resultR, 0) /
                    closedTrades
                : 0,
            profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
        };
        return progress;
    }
    async closePaperTrade() {
        const state = await this.broker.getState();
        if (!state.position)
            throw new Error("No paper position is open");
        const ticker = await this.kraken.getTicker(state.position.pair);
        return this.broker.closePosition(ticker.bid, "MANUAL");
    }
    async validateKrakenOrder(input) {
        return this.kraken.validateLimitOrder(input);
    }
}
