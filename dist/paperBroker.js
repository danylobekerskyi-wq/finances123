import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
function round(value, decimals = 8) {
    const scale = 10 ** decimals;
    return Math.round(value * scale) / scale;
}
function assertFinitePositive(name, value) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive finite number`);
    }
}
function dateKey(iso, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date(iso));
    const get = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")}`;
}
function validateState(value) {
    if (!value || typeof value !== "object") {
        throw new Error("Paper state file is not a JSON object");
    }
    const state = value;
    if (!Number.isFinite(state.startingBalanceCad) ||
        !Number.isFinite(state.cashCad) ||
        !Array.isArray(state.closedTrades) ||
        typeof state.updatedAt !== "string") {
        throw new Error("Paper state file has an invalid structure");
    }
    return state;
}
export class PaperBroker {
    dataFile;
    startingBalanceCad;
    dailyLossLimitPct;
    feeRate;
    slippageRate;
    clock;
    timeZone;
    enforceDailyRiskLimits;
    mutationChain = Promise.resolve();
    constructor(options) {
        assertFinitePositive("startingBalanceCad", options.startingBalanceCad);
        assertFinitePositive("dailyLossLimitPct", options.dailyLossLimitPct);
        this.dataFile = path.resolve(options.dataFile);
        this.startingBalanceCad = options.startingBalanceCad;
        this.dailyLossLimitPct = options.dailyLossLimitPct;
        this.feeRate = options.feePctPerSide / 100;
        this.slippageRate = options.slippagePctPerSide / 100;
        this.clock = options.clock || Date.now;
        this.timeZone = options.timeZone || "America/Winnipeg";
        this.enforceDailyRiskLimits = options.enforceDailyRiskLimits ?? true;
    }
    nowIso() {
        return new Date(this.clock()).toISOString();
    }
    initialState() {
        const now = this.nowIso();
        return {
            startingBalanceCad: this.startingBalanceCad,
            cashCad: this.startingBalanceCad,
            position: null,
            closedTrades: [],
            updatedAt: now,
        };
    }
    async readState() {
        try {
            return validateState(JSON.parse(await readFile(this.dataFile, "utf8")));
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            const state = this.initialState();
            await this.writeState(state);
            return state;
        }
    }
    async writeState(state) {
        await mkdir(path.dirname(this.dataFile), { recursive: true });
        const tempFile = `${this.dataFile}.${randomUUID()}.tmp`;
        await writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        await rename(tempFile, this.dataFile);
    }
    runExclusive(operation) {
        const result = this.mutationChain.then(operation, operation);
        this.mutationChain = result.then(() => undefined, () => undefined);
        return result;
    }
    dailyStats(state, now) {
        const key = dateKey(now, this.timeZone);
        const todaysTrades = state.closedTrades.filter((trade) => dateKey(trade.closedAt, this.timeZone) === key);
        const realizedPnlCad = todaysTrades.reduce((sum, trade) => sum + trade.realizedPnlCad, 0);
        const stopCount = todaysTrades.filter((trade) => trade.reason === "STOP").length;
        const limitCad = (state.startingBalanceCad * this.dailyLossLimitPct) / 100;
        if (this.enforceDailyRiskLimits && realizedPnlCad <= -limitCad) {
            return {
                realizedPnlCad,
                stopCount,
                blocked: true,
                reason: `Daily realized loss reached ${limitCad.toFixed(2)} USD`,
            };
        }
        if (this.enforceDailyRiskLimits && stopCount >= 2) {
            return {
                realizedPnlCad,
                stopCount,
                blocked: true,
                reason: "Two stop-loss exits occurred during the Winnipeg trading day",
            };
        }
        return { realizedPnlCad, stopCount, blocked: false, reason: null };
    }
    async getState() {
        return this.runExclusive(async () => structuredClone(await this.readState()));
    }
    async getPortfolio(marketPriceCad) {
        return this.runExclusive(async () => {
            const state = await this.readState();
            const now = this.nowIso();
            const daily = this.dailyStats(state, now);
            const totalRealized = state.closedTrades.reduce((sum, trade) => sum + trade.realizedPnlCad, 0);
            let equityCad = state.cashCad;
            let unrealizedPnlCad = 0;
            if (state.position && marketPriceCad !== null) {
                assertFinitePositive("marketPriceCad", marketPriceCad);
                const liquidationPrice = marketPriceCad * (1 - this.slippageRate);
                const proceeds = state.position.units * liquidationPrice;
                const exitFee = proceeds * this.feeRate;
                const liquidationValue = proceeds - exitFee;
                equityCad += liquidationValue;
                unrealizedPnlCad =
                    liquidationValue -
                        state.position.entryNotionalCad -
                        state.position.entryFeeCad;
            }
            return {
                state: structuredClone(state),
                marketPriceCad,
                equityCad: round(equityCad, 2),
                unrealizedPnlCad: round(unrealizedPnlCad, 2),
                realizedPnlCad: round(totalRealized, 2),
                dailyRealizedPnlCad: round(daily.realizedPnlCad, 2),
                dailyStopCount: daily.stopCount,
                dailyTradingBlocked: daily.blocked,
                dailyTradingBlockReason: daily.reason,
            };
        });
    }
    async openPosition(pair, plan) {
        return this.runExclusive(async () => {
            const state = await this.readState();
            if (state.position)
                throw new Error("Only one paper position may be open");
            const now = this.nowIso();
            const daily = this.dailyStats(state, now);
            if (daily.blocked)
                throw new Error(daily.reason || "Daily trading is blocked");
            const executionPrice = plan.entry * (1 + this.slippageRate);
            const entryNotional = plan.units * executionPrice;
            const entryFee = entryNotional * this.feeRate;
            const cashRequired = entryNotional + entryFee;
            if (cashRequired > state.cashCad + 0.005) {
                throw new Error("Paper account has insufficient USD cash for this position");
            }
            const position = {
                id: randomUUID(),
                pair,
                units: plan.units,
                entryPriceCad: round(executionPrice),
                entryNotionalCad: round(entryNotional, 2),
                entryFeeCad: round(entryFee, 2),
                stopCad: plan.stop,
                targetCad: plan.minimumTarget,
                openedAt: now,
                plannedRiskCad: plan.worstCaseLossCad,
            };
            state.cashCad = round(state.cashCad - cashRequired, 2);
            state.position = position;
            state.updatedAt = now;
            await this.writeState(state);
            return structuredClone(position);
        });
    }
    closePositionInState(state, referencePriceCad, reason) {
        assertFinitePositive("referencePriceCad", referencePriceCad);
        const position = state.position;
        if (!position)
            throw new Error("No paper position is open");
        const executionPrice = referencePriceCad * (1 - this.slippageRate);
        const grossProceeds = position.units * executionPrice;
        const exitFee = grossProceeds * this.feeRate;
        const netProceeds = grossProceeds - exitFee;
        const realizedPnl = netProceeds - position.entryNotionalCad - position.entryFeeCad;
        const closedAt = this.nowIso();
        const trade = {
            ...position,
            exitPriceCad: round(executionPrice),
            exitFeeCad: round(exitFee, 2),
            closedAt,
            reason,
            realizedPnlCad: round(realizedPnl, 2),
            resultR: position.plannedRiskCad > 0
                ? round(realizedPnl / position.plannedRiskCad, 3)
                : 0,
        };
        state.cashCad = round(state.cashCad + netProceeds, 2);
        state.position = null;
        state.closedTrades.push(trade);
        state.updatedAt = closedAt;
        return trade;
    }
    async closePosition(referencePriceCad, reason = "MANUAL") {
        return this.runExclusive(async () => {
            const state = await this.readState();
            const trade = this.closePositionInState(state, referencePriceCad, reason);
            await this.writeState(state);
            return structuredClone(trade);
        });
    }
    async settleTriggeredPosition(executableBidCad) {
        return this.runExclusive(async () => {
            const state = await this.readState();
            const position = state.position;
            if (!position)
                return null;
            let reason = null;
            let referencePrice = executableBidCad;
            if (executableBidCad <= position.stopCad) {
                reason = "STOP";
            }
            else if (executableBidCad >= position.targetCad) {
                reason = "TARGET";
                referencePrice = position.targetCad;
            }
            if (!reason)
                return null;
            const trade = this.closePositionInState(state, referencePrice, reason);
            await this.writeState(state);
            return structuredClone(trade);
        });
    }
}
