import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
const REQUIRED_KEY_PERMISSIONS = [
    "query-funds",
    "query-open-trades",
    "query-closed-trades",
    "modify-trades",
    "close-trades",
];
const UNKNOWN_HOLDING_DUST_CAD = 1;
function round(value, decimals = 8) {
    const scale = 10 ** decimals;
    return Math.round(value * scale) / scale;
}
function finiteNumber(label, value) {
    const number = Number(value);
    if (!Number.isFinite(number))
        throw new Error(`Invalid ${label}`);
    return number;
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
function balanceOf(balances, aliases) {
    return aliases.reduce((sum, alias) => sum + (balances[alias] || 0), 0);
}
function floorToIncrement(value, increment) {
    return Math.floor((value + Number.EPSILON) / increment) * increment;
}
function ceilToIncrement(value, increment) {
    return Math.ceil((value - Number.EPSILON) / increment) * increment;
}
function formatVolume(value, rules) {
    return floorToIncrement(value, 1 / 10 ** rules.lotDecimals).toFixed(rules.lotDecimals);
}
function formatPrice(value, rules, direction) {
    const rounded = direction === "up"
        ? ceilToIncrement(value, rules.tickSize)
        : floorToIncrement(value, rules.tickSize);
    return rounded.toFixed(rules.priceDecimals);
}
function parseState(value) {
    if (!value || typeof value !== "object") {
        throw new Error("Live state file is not a JSON object");
    }
    const state = value;
    if (state.version !== 1 ||
        !Array.isArray(state.closedTrades) ||
        !state.dayStartingEquityCad ||
        typeof state.dayStartingEquityCad !== "object" ||
        typeof state.updatedAt !== "string") {
        throw new Error("Live state file has an invalid structure");
    }
    return state;
}
function orderNumbers(order) {
    const units = finiteNumber("Kraken executed volume", order.vol_exec);
    const cost = finiteNumber("Kraken order cost", order.cost);
    const fee = finiteNumber("Kraken order fee", order.fee);
    const reportedPrice = finiteNumber("Kraken order price", order.price);
    return {
        units,
        cost,
        fee,
        price: reportedPrice > 0 ? reportedPrice : units > 0 ? cost / units : 0,
    };
}
function isProtectiveStop(order) {
    return (order.descr?.type === "sell" &&
        ["stop-loss", "stop-loss-limit"].includes(order.descr.ordertype));
}
export class KrakenLiveBroker {
    client;
    stateFile;
    capitalCapCad;
    maxOrderCad;
    dailyLossLimitPct;
    entrySlippageRate;
    exitSlippageRate;
    clock;
    timeZone;
    sleep;
    mutationChain = Promise.resolve();
    constructor(options) {
        this.client = options.client;
        this.stateFile = path.resolve(options.stateFile);
        this.capitalCapCad = options.capitalCapCad;
        this.maxOrderCad = options.maxOrderCad;
        this.dailyLossLimitPct = options.dailyLossLimitPct;
        this.entrySlippageRate = options.entrySlippagePct / 100;
        this.exitSlippageRate = options.exitSlippagePct / 100;
        this.clock = options.clock || Date.now;
        this.timeZone = options.timeZone || "America/Winnipeg";
        this.sleep =
            options.sleep ||
                ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    }
    nowIso() {
        return new Date(this.clock()).toISOString();
    }
    initialState() {
        return {
            version: 1,
            position: null,
            pendingEntry: null,
            pendingExit: null,
            closedTrades: [],
            dayStartingEquityCad: {},
            updatedAt: this.nowIso(),
        };
    }
    async readState() {
        try {
            return parseState(JSON.parse(await readFile(this.stateFile, "utf8")));
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
        state.updatedAt = this.nowIso();
        await mkdir(path.dirname(this.stateFile), { recursive: true });
        const temp = `${this.stateFile}.${randomUUID()}.tmp`;
        await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        await rename(temp, this.stateFile);
    }
    runExclusive(operation) {
        const result = this.mutationChain.then(operation, operation);
        this.mutationChain = result.then(() => undefined, () => undefined);
        return result;
    }
    async assertSafeKey() {
        const info = await this.client.getApiKeyInfo();
        const permissions = new Set(info.permissions);
        const missing = REQUIRED_KEY_PERMISSIONS.filter((permission) => !permissions.has(permission));
        const extra = info.permissions.filter((permission) => !REQUIRED_KEY_PERMISSIONS.includes(permission));
        if (missing.length > 0) {
            throw new Error(`Kraken API key is missing permissions: ${missing.join(", ")}`);
        }
        if (extra.length > 0) {
            throw new Error(`Kraken API key has forbidden or unnecessary permissions: ${extra.join(", ")}`);
        }
        const validUntil = Number(info.validUntil);
        if (validUntil > 0 && this.clock() >= validUntil * 1000) {
            throw new Error("Kraken API key has expired");
        }
    }
    dailyStatus(state, effectiveEquityCad, persistStartingEquity) {
        const now = this.nowIso();
        const date = dateKey(now, this.timeZone);
        let startingEquity = state.dayStartingEquityCad[date];
        if (!(startingEquity && startingEquity > 0)) {
            startingEquity = Math.min(effectiveEquityCad, this.capitalCapCad);
            if (persistStartingEquity && startingEquity > 0) {
                state.dayStartingEquityCad[date] = round(startingEquity, 2);
            }
        }
        const trades = state.closedTrades.filter((trade) => dateKey(trade.closedAt, this.timeZone) === date);
        const realizedPnlCad = trades.reduce((sum, trade) => sum + trade.realizedPnlCad, 0);
        const stopCount = trades.filter((trade) => trade.reason === "STOP").length;
        const lossLimitCad = (startingEquity * this.dailyLossLimitPct) / 100;
        let reason = null;
        if (startingEquity > 0 && realizedPnlCad <= -lossLimitCad) {
            reason = `Daily realized loss reached ${lossLimitCad.toFixed(2)} USD`;
        }
        else if (stopCount >= 2) {
            reason = "Two stop-loss exits occurred during the Winnipeg trading day";
        }
        return {
            date,
            startingEquityCad: round(startingEquity, 2),
            realizedPnlCad: round(realizedPnlCad, 2),
            stopCount,
            blocked: reason !== null,
            reason,
        };
    }
    async accountSnapshot(state) {
        const [balances, openOrders] = await Promise.all([
            this.client.getAccountBalances(),
            this.client.getOpenOrders(),
        ]);
        const cadBalance = balanceOf(balances, ["ZUSD", "USD"]);
        const btcBalance = balanceOf(balances, ["XXBT", "XBT", "BTC"]);
        const ethBalance = balanceOf(balances, ["XETH", "ETH"]);
        const tickerRequests = [
            btcBalance > 0
                ? this.client.getTicker("BTC/USD").then((ticker) => ticker.bid)
                : Promise.resolve(0),
            ethBalance > 0
                ? this.client.getTicker("ETH/USD").then((ticker) => ticker.bid)
                : Promise.resolve(0),
        ];
        const [btcBid, ethBid] = await Promise.all(tickerRequests);
        const btcValueCad = btcBalance * (btcBid || 0);
        const ethValueCad = ethBalance * (ethBid || 0);
        const trackedValue = state.position?.pair === "BTC/USD"
            ? btcValueCad
            : state.position?.pair === "ETH/USD"
                ? ethValueCad
                : 0;
        return {
            balances,
            openOrders,
            btcValueCad,
            ethValueCad,
            account: {
                cadBalance: round(cadBalance, 2),
                btcBalance: round(btcBalance),
                ethBalance: round(ethBalance),
                effectiveTradingEquityCad: round(Math.min(cadBalance + trackedValue, this.capitalCapCad), 2),
                openOrderCount: Object.keys(openOrders).length,
            },
        };
    }
    accountBlockers(state, snapshot) {
        const blockers = [];
        const openEntries = Object.entries(snapshot.openOrders);
        if (!state.position) {
            if (openEntries.length > 0)
                blockers.push("Kraken account has open orders");
            if (snapshot.btcValueCad > UNKNOWN_HOLDING_DUST_CAD) {
                blockers.push("Kraken account has an untracked BTC balance");
            }
            if (snapshot.ethValueCad > UNKNOWN_HOLDING_DUST_CAD) {
                blockers.push("Kraken account has an untracked ETH balance");
            }
        }
        else {
            const unrelated = openEntries.filter(([txid]) => txid !== state.position?.protectiveOrderTxid);
            if (unrelated.length > 0) {
                blockers.push("Kraken account has an order not tracked by this bot");
            }
            const trackedBalance = state.position.pair === "BTC/USD"
                ? snapshot.account.btcBalance
                : snapshot.account.ethBalance;
            if (trackedBalance < state.position.units * 0.995) {
                blockers.push("Kraken asset balance is below the locally tracked position");
            }
            const trackedValue = state.position.pair === "BTC/USD"
                ? snapshot.btcValueCad
                : snapshot.ethValueCad;
            const excessUnits = Math.max(0, trackedBalance - state.position.units);
            const excessValue = trackedBalance > 0 ? (trackedValue * excessUnits) / trackedBalance : 0;
            if (excessValue > UNKNOWN_HOLDING_DUST_CAD) {
                blockers.push("Kraken asset balance exceeds the locally tracked position");
            }
            if (state.position.pair === "BTC/USD" &&
                snapshot.ethValueCad > UNKNOWN_HOLDING_DUST_CAD) {
                blockers.push("Kraken account has an untracked ETH balance");
            }
            if (state.position.pair === "ETH/USD" &&
                snapshot.btcValueCad > UNKNOWN_HOLDING_DUST_CAD) {
                blockers.push("Kraken account has an untracked BTC balance");
            }
        }
        if (snapshot.account.effectiveTradingEquityCad < 10 && !state.position) {
            blockers.push("Available USD trading equity is below 10 USD");
        }
        if (state.pendingEntry)
            blockers.push("A live entry is pending reconciliation");
        if (state.pendingExit)
            blockers.push("A live exit is pending reconciliation");
        return blockers;
    }
    protectiveCandidates(orders, pending, rules) {
        const base = pending.pair === "BTC/USD" ? "XBT" : "ETH";
        const volumeTolerance = 2 / 10 ** rules.lotDecimals;
        return Object.entries(orders).filter(([, order]) => {
            const rawSymbol = String(order.descr?.pair || "")
                .toUpperCase()
                .replaceAll("/", "");
            const symbol = rawSymbol.includes("XBT")
                ? rawSymbol
                : rawSymbol.replaceAll("BTC", "XBT");
            const volume = Number(order.vol);
            return (isProtectiveStop(order) &&
                symbol.includes(base) &&
                symbol.includes("USD") &&
                Number.isFinite(volume) &&
                Math.abs(volume - pending.units) <= volumeTolerance);
        });
    }
    async ensureSingleProtectiveStop(pending, entryTxid, rules) {
        let openOrders = {};
        for (let attempt = 0; attempt < 4; attempt += 1) {
            openOrders = await this.client.getOpenOrders();
            if (this.protectiveCandidates(openOrders, pending, rules).length > 0)
                break;
            if (attempt < 3)
                await this.sleep(350);
        }
        let candidates = this.protectiveCandidates(openOrders, pending, rules);
        if (candidates.length === 0) {
            const added = await this.client.placeProtectiveStop({
                pair: pending.pair,
                volume: formatVolume(pending.units, rules),
                stopPriceCad: formatPrice(pending.stopCad, rules, "down"),
                clientOrderId: `ct-s-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
            });
            const txid = added.txid[0];
            if (!txid)
                throw new Error("Kraken did not return a protective stop id");
            for (let attempt = 0; attempt < 4; attempt += 1) {
                openOrders = await this.client.getOpenOrders();
                candidates = this.protectiveCandidates(openOrders, pending, rules);
                if (candidates.some(([id]) => id === txid))
                    break;
                if (attempt < 3)
                    await this.sleep(350);
            }
            if (!candidates.some(([id]) => id === txid)) {
                throw new Error("Kraken protective stop could not be confirmed as open");
            }
        }
        const preferred = candidates.find(([, order]) => order.refid === entryTxid) || candidates[0];
        if (!preferred)
            throw new Error("No exchange-side protective stop is open");
        for (const [txid] of candidates) {
            if (txid !== preferred[0])
                await this.client.cancelOrder(txid);
        }
        return preferred[0];
    }
    async finalizeEntry(state, pending, txid, order) {
        const numbers = orderNumbers(order);
        if (numbers.units <= 0) {
            if (["canceled", "expired"].includes(order.status)) {
                state.pendingEntry = null;
                await this.writeState(state);
                return null;
            }
            throw new Error(`Kraken entry has unresolved status: ${order.status}`);
        }
        const rules = await this.client.getPairRules(pending.pair);
        const protectiveOrderTxid = await this.ensureSingleProtectiveStop({ ...pending, units: numbers.units }, txid, rules);
        const position = {
            id: randomUUID(),
            pair: pending.pair,
            units: round(numbers.units),
            entryPriceCad: round(numbers.price),
            entryCostCad: round(numbers.cost, 2),
            entryFeeCad: round(numbers.fee, 2),
            stopCad: pending.stopCad,
            targetCad: pending.targetCad,
            openedAt: this.nowIso(),
            plannedRiskCad: pending.plannedRiskCad,
            entryOrderTxid: txid,
            entryClientOrderId: pending.clientOrderId,
            protectiveOrderTxid,
        };
        state.position = position;
        state.pendingEntry = null;
        await this.writeState(state);
        return structuredClone(position);
    }
    closeInState(state, order, txid, reason) {
        const position = state.position;
        if (!position)
            throw new Error("No local live position is open");
        const numbers = orderNumbers(order);
        if (numbers.units < position.units * 0.995) {
            throw new Error("Kraken exit did not close the full tracked position");
        }
        const realizedPnl = numbers.cost - numbers.fee - position.entryCostCad - position.entryFeeCad;
        const trade = {
            ...position,
            exitPriceCad: round(numbers.price),
            exitProceedsCad: round(numbers.cost, 2),
            exitFeeCad: round(numbers.fee, 2),
            closedAt: this.nowIso(),
            exitOrderTxid: txid,
            reason,
            realizedPnlCad: round(realizedPnl, 2),
            resultR: position.plannedRiskCad > 0
                ? round(realizedPnl / position.plannedRiskCad, 3)
                : 0,
        };
        state.closedTrades.push(trade);
        state.position = null;
        state.pendingExit = null;
        return trade;
    }
    recordPartialStopInState(state, order, txid, remainingUnits) {
        const position = state.position;
        if (!position)
            throw new Error("No local live position is open");
        const numbers = orderNumbers(order);
        if (numbers.units <= 0 || numbers.units >= position.units * 0.995) {
            throw new Error("Order is not a partial stop execution");
        }
        const fraction = numbers.units / position.units;
        const allocatedEntryCost = position.entryCostCad * fraction;
        const allocatedEntryFee = position.entryFeeCad * fraction;
        const allocatedRisk = position.plannedRiskCad * fraction;
        const realizedPnl = numbers.cost - numbers.fee - allocatedEntryCost - allocatedEntryFee;
        const trade = {
            ...position,
            id: randomUUID(),
            units: round(numbers.units),
            entryCostCad: round(allocatedEntryCost, 2),
            entryFeeCad: round(allocatedEntryFee, 2),
            plannedRiskCad: round(allocatedRisk, 2),
            exitPriceCad: round(numbers.price),
            exitProceedsCad: round(numbers.cost, 2),
            exitFeeCad: round(numbers.fee, 2),
            closedAt: this.nowIso(),
            exitOrderTxid: txid,
            reason: "STOP",
            realizedPnlCad: round(realizedPnl, 2),
            resultR: allocatedRisk > 0 ? round(realizedPnl / allocatedRisk, 3) : 0,
        };
        state.closedTrades.push(trade);
        position.units = round(remainingUnits);
        position.entryCostCad = round(position.entryCostCad - allocatedEntryCost, 2);
        position.entryFeeCad = round(position.entryFeeCad - allocatedEntryFee, 2);
        position.plannedRiskCad = round(position.plannedRiskCad - allocatedRisk, 2);
        return trade;
    }
    async queryOne(txid) {
        const result = await this.client.queryOrders([txid]);
        return result[txid] || Object.values(result)[0] || null;
    }
    async reconcilePendingEntry(state) {
        const pending = state.pendingEntry;
        if (!pending)
            return;
        let txid = pending.txid;
        let order = null;
        if (txid) {
            order = await this.queryOne(txid);
        }
        else {
            const closed = await this.client.getClosedOrders({
                clientOrderId: pending.clientOrderId,
                startUnix: Date.parse(pending.createdAt) / 1000 - 60,
            });
            const found = Object.entries(closed)[0];
            if (found) {
                [txid, order] = found;
                pending.txid = txid;
                await this.writeState(state);
            }
        }
        if (txid && order)
            await this.finalizeEntry(state, pending, txid, order);
    }
    async reconcilePendingExit(state) {
        const pending = state.pendingExit;
        const position = state.position;
        if (!pending || !position)
            return null;
        let txid = pending.txid;
        let order = null;
        if (txid) {
            order = await this.queryOne(txid);
        }
        else {
            const closed = await this.client.getClosedOrders({
                clientOrderId: pending.clientOrderId,
                startUnix: Date.parse(pending.createdAt) / 1000 - 60,
            });
            const found = Object.entries(closed)[0];
            if (found) {
                [txid, order] = found;
                pending.txid = txid;
            }
        }
        if (txid && order && orderNumbers(order).units >= position.units * 0.995) {
            const trade = this.closeInState(state, order, txid, "TARGET");
            await this.writeState(state);
            return trade;
        }
        const rules = await this.client.getPairRules(position.pair);
        const stopTxid = await this.ensureSingleProtectiveStop({
            clientOrderId: position.entryClientOrderId,
            pair: position.pair,
            units: position.units,
            entryLimitCad: position.entryPriceCad,
            stopCad: position.stopCad,
            targetCad: position.targetCad,
            plannedRiskCad: position.plannedRiskCad,
            createdAt: position.openedAt,
            txid: position.entryOrderTxid,
        }, position.entryOrderTxid, rules);
        position.protectiveOrderTxid = stopTxid;
        state.pendingExit = null;
        await this.writeState(state);
        return null;
    }
    async inspect() {
        return this.runExclusive(async () => {
            await this.assertSafeKey();
            const state = await this.readState();
            const snapshot = await this.accountSnapshot(state);
            return {
                state: structuredClone(state),
                account: snapshot.account,
                daily: this.dailyStatus(state, snapshot.account.effectiveTradingEquityCad, false),
                blockers: this.accountBlockers(state, snapshot),
                closedTrade: null,
            };
        });
    }
    async reconcile() {
        return this.runExclusive(async () => {
            await this.assertSafeKey();
            const state = await this.readState();
            await this.reconcilePendingEntry(state);
            let closedTrade = await this.reconcilePendingExit(state);
            let snapshot = await this.accountSnapshot(state);
            if (state.position) {
                const protective = snapshot.openOrders[state.position.protectiveOrderTxid];
                const trackedBalance = state.position.pair === "BTC/USD"
                    ? snapshot.account.btcBalance
                    : snapshot.account.ethBalance;
                if (!protective) {
                    const queried = await this.queryOne(state.position.protectiveOrderTxid);
                    const queriedNumbers = queried ? orderNumbers(queried) : null;
                    if (queried &&
                        queriedNumbers &&
                        queriedNumbers.units >= state.position.units * 0.995) {
                        closedTrade = this.closeInState(state, queried, state.position.protectiveOrderTxid, "STOP");
                        await this.writeState(state);
                        snapshot = await this.accountSnapshot(state);
                    }
                    else if (queried &&
                        queriedNumbers &&
                        queriedNumbers.units > 0 &&
                        trackedBalance > 0) {
                        this.recordPartialStopInState(state, queried, state.position.protectiveOrderTxid, trackedBalance);
                        const rules = await this.client.getPairRules(state.position.pair);
                        const replacement = await this.ensureSingleProtectiveStop({
                            clientOrderId: state.position.entryClientOrderId,
                            pair: state.position.pair,
                            units: state.position.units,
                            entryLimitCad: state.position.entryPriceCad,
                            stopCad: state.position.stopCad,
                            targetCad: state.position.targetCad,
                            plannedRiskCad: state.position.plannedRiskCad,
                            createdAt: state.position.openedAt,
                            txid: state.position.entryOrderTxid,
                        }, state.position.entryOrderTxid, rules);
                        state.position.protectiveOrderTxid = replacement;
                        await this.writeState(state);
                        snapshot = await this.accountSnapshot(state);
                    }
                    else if (trackedBalance >= state.position.units * 0.995) {
                        const rules = await this.client.getPairRules(state.position.pair);
                        const replacement = await this.ensureSingleProtectiveStop({
                            clientOrderId: state.position.entryClientOrderId,
                            pair: state.position.pair,
                            units: state.position.units,
                            entryLimitCad: state.position.entryPriceCad,
                            stopCad: state.position.stopCad,
                            targetCad: state.position.targetCad,
                            plannedRiskCad: state.position.plannedRiskCad,
                            createdAt: state.position.openedAt,
                            txid: state.position.entryOrderTxid,
                        }, state.position.entryOrderTxid, rules);
                        state.position.protectiveOrderTxid = replacement;
                        await this.writeState(state);
                        snapshot = await this.accountSnapshot(state);
                    }
                }
            }
            const daily = this.dailyStatus(state, snapshot.account.effectiveTradingEquityCad, true);
            await this.writeState(state);
            const blockers = this.accountBlockers(state, snapshot);
            if (daily.blocked && daily.reason)
                blockers.push(daily.reason);
            return {
                state: structuredClone(state),
                account: snapshot.account,
                daily,
                blockers: [...new Set(blockers)],
                closedTrade,
            };
        });
    }
    async openLong(pair, plan) {
        return this.runExclusive(async () => {
            await this.assertSafeKey();
            const state = await this.readState();
            if (state.position || state.pendingEntry || state.pendingExit) {
                throw new Error("A live position or unresolved live action already exists");
            }
            const snapshot = await this.accountSnapshot(state);
            const blockers = this.accountBlockers(state, snapshot);
            const daily = this.dailyStatus(state, snapshot.account.effectiveTradingEquityCad, true);
            if (daily.blocked && daily.reason)
                blockers.push(daily.reason);
            if (blockers.length > 0)
                throw new Error(blockers.join("; "));
            if (plan.positionNotionalCad > this.maxOrderCad + 0.01) {
                throw new Error("Planned live order exceeds LIVE_MAX_ORDER_CAD");
            }
            if (plan.positionNotionalCad > snapshot.account.cadBalance + 0.01) {
                throw new Error("Kraken USD balance is insufficient for the live order");
            }
            const [rules, ticker] = await Promise.all([
                this.client.getPairRules(pair),
                this.client.getTicker(pair),
            ]);
            if (rules.status !== "online")
                throw new Error("Kraken pair is not online");
            if (ticker.ask > plan.entry) {
                throw new Error("Kraken ask moved above the risk-approved FOK limit");
            }
            const volume = formatVolume(plan.units, rules);
            const roundedUnits = Number(volume);
            const entryLimit = formatPrice(plan.entry, rules, "up");
            const stop = formatPrice(plan.stop, rules, "down");
            if (roundedUnits < rules.orderMinimum) {
                throw new Error("Rounded position is below Kraken's order minimum");
            }
            if (roundedUnits * Number(entryLimit) < rules.costMinimum) {
                throw new Error("Rounded position is below Kraken's cost minimum");
            }
            if (roundedUnits * Number(entryLimit) > this.maxOrderCad + 0.01) {
                throw new Error("Rounded FOK entry exceeds the live order cap");
            }
            const pending = {
                clientOrderId: `ct-e-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
                pair,
                units: roundedUnits,
                entryLimitCad: Number(entryLimit),
                stopCad: Number(stop),
                targetCad: plan.minimumTarget,
                plannedRiskCad: plan.worstCaseLossCad,
                createdAt: this.nowIso(),
                txid: null,
            };
            state.pendingEntry = pending;
            await this.writeState(state);
            const added = await this.client.placeFokLongWithStop({
                pair,
                volume,
                limitPriceCad: entryLimit,
                stopPriceCad: stop,
                clientOrderId: pending.clientOrderId,
            });
            const txid = added.txid[0];
            if (!txid)
                throw new Error("Kraken did not return an entry order id");
            pending.txid = txid;
            await this.writeState(state);
            const order = await this.queryOne(txid);
            if (!order)
                throw new Error("Kraken entry order cannot be reconciled");
            return this.finalizeEntry(state, pending, txid, order);
        });
    }
    async closeAtTarget() {
        return this.runExclusive(async () => {
            await this.assertSafeKey();
            const state = await this.readState();
            const position = state.position;
            if (!position)
                return null;
            if (state.pendingEntry || state.pendingExit) {
                throw new Error("A live action is pending reconciliation");
            }
            const [ticker, rules] = await Promise.all([
                this.client.getTicker(position.pair),
                this.client.getPairRules(position.pair),
            ]);
            if (ticker.bid < position.targetCad)
                return null;
            const pending = {
                clientOrderId: `ct-x-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
                positionId: position.id,
                reason: "TARGET",
                createdAt: this.nowIso(),
                txid: null,
            };
            state.pendingExit = pending;
            await this.writeState(state);
            try {
                await this.client.cancelOrder(position.protectiveOrderTxid);
                for (let attempt = 0; attempt < 4; attempt += 1) {
                    const open = await this.client.getOpenOrders();
                    if (!open[position.protectiveOrderTxid])
                        break;
                    if (attempt === 3) {
                        throw new Error("Protective stop cancellation could not be confirmed");
                    }
                    await this.sleep(250);
                }
                const limitPrice = formatPrice(ticker.bid * (1 - this.exitSlippageRate), rules, "down");
                const added = await this.client.placeFokSell({
                    pair: position.pair,
                    volume: formatVolume(position.units, rules),
                    limitPriceCad: limitPrice,
                    clientOrderId: pending.clientOrderId,
                });
                const txid = added.txid[0];
                if (!txid)
                    throw new Error("Kraken did not return a target exit order id");
                pending.txid = txid;
                await this.writeState(state);
                const order = await this.queryOne(txid);
                if (order && orderNumbers(order).units >= position.units * 0.995) {
                    const trade = this.closeInState(state, order, txid, "TARGET");
                    await this.writeState(state);
                    return structuredClone(trade);
                }
                await this.reconcilePendingExit(state);
                return null;
            }
            catch (error) {
                try {
                    await this.reconcilePendingExit(state);
                }
                catch (safetyError) {
                    const primary = error instanceof Error ? error.message : "Target exit failed";
                    const safety = safetyError instanceof Error
                        ? safetyError.message
                        : "protective stop recovery failed";
                    throw new Error(`${primary}; SAFETY RECOVERY FAILED: ${safety}`);
                }
                throw error;
            }
        });
    }
    maximumEntryPrice(currentAskCad) {
        return currentAskCad * (1 + this.entrySlippageRate);
    }
}
