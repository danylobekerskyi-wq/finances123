import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export const HOLDING_FACTORS = [0.75, 1, 1.25];
export function adjustedHolding(base, factor) {
    return Math.max(3, Math.min(30, Math.round(base * factor)));
}
/** Conservative OHLC replay: stop wins if stop and target touch in the same bar. */
export function replayTrial(plan, candles, factor, fee, slip) {
    const minutes = adjustedHolding(plan.maxHoldingMinutes, factor);
    const bars = candles.slice(0, minutes);
    if (bars.length !== minutes)
        throw new Error("Incomplete replay");
    let exit = bars.at(-1).close;
    for (const bar of bars) {
        if (bar.low <= plan.stop) {
            exit = Math.min(bar.open, plan.stop);
            break;
        }
        if (bar.high >= plan.minimumTarget) {
            exit = plan.minimumTarget;
            break;
        }
    }
    const entryCost = plan.entry * (1 + slip / 100) * (1 + fee / 100);
    const proceeds = exit * (1 - slip / 100) * (1 - fee / 100);
    return (proceeds - entryCost) * plan.units / plan.worstCaseLossCad;
}
const mean = (rows, index) => rows.reduce((sum, r) => sum + r.scores[index], 0) / rows.length;
export function selectFactor(rows, active) {
    if (rows.length < 50 || rows.some(r => r.scores.length !== 3 || r.scores.some(x => !Number.isFinite(x))))
        return active;
    const ordered = [...rows].sort((a, b) => a.at - b.at).slice(-50);
    const train = ordered.slice(0, 30), validation = ordered.slice(30);
    const current = HOLDING_FACTORS.indexOf(active);
    if (current < 0)
        return 1;
    let best = current;
    for (let i = 0; i < 3; i++)
        if (mean(train, i) > mean(train, best))
            best = i;
    if (best === current || mean(train, best) <= 0 || mean(validation, best) <= 0 ||
        mean(validation, best) < mean(validation, current) + 0.1)
        return active;
    return HOLDING_FACTORS[best];
}
export class SelfImprovement {
    file;
    queue = Promise.resolve();
    constructor(file) {
        this.file = file;
    }
    async observe(snapshot, plan, fee, slip) {
        const operation = this.queue.then(() => this.update(snapshot, plan, fee, slip));
        this.queue = operation.catch(() => { });
        return operation;
    }
    async update(snapshot, plan, fee, slip) {
        let m;
        try {
            m = JSON.parse(await readFile(this.file, "utf8"));
            if (m.version !== 1 || !HOLDING_FACTORS.includes(m.activeFactor) ||
                !Array.isArray(m.pending) || !Array.isArray(m.samples) || !Array.isArray(m.history) ||
                !m.lastTrial || !Number.isInteger(m.totalSamples) || !Number.isInteger(m.evaluated))
                throw new Error("Invalid learning memory");
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw e;
            m = { version: 1, activeFactor: 1, pending: [], samples: [], lastTrial: {}, evaluated: 0, totalSamples: 0, history: [] };
        }
        const now = Date.parse(snapshot.capturedAt) / 1000;
        if (!Number.isFinite(now))
            throw new Error("Invalid learning timestamp");
        const remaining = [];
        for (const trial of m.pending) {
            if (trial.pair !== snapshot.ticker.pair || now < trial.at + 1800) {
                remaining.push(trial);
                continue;
            }
            const bars = snapshot.candles1m.filter(c => c.time >= trial.at && c.time + 60 <= now).slice(0, 30);
            const valid = bars.length === 30 && bars.every((c, i) => c.time === trial.at + i * 60 &&
                [c.open, c.high, c.low, c.close].every(x => Number.isFinite(x) && x > 0) && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close));
            if (valid) {
                const scores = HOLDING_FACTORS.map(f => replayTrial(trial.plan, bars, f, trial.fee, trial.slip));
                if (scores.every(Number.isFinite)) {
                    m.samples.push({ at: trial.at, scores });
                    m.totalSamples++;
                }
            } // Missing bars discard the trial rather than inventing prices.
        }
        m.pending = remaining;
        m.samples.sort((a, b) => a.at - b.at);
        m.samples = m.samples.slice(-200);
        if (m.totalSamples - m.evaluated >= 50) {
            const selected = selectFactor(m.samples, m.activeFactor);
            const validation = m.samples.slice(-20);
            m.history.push({ at: now, previous: m.activeFactor, selected, validationMean: mean(validation, HOLDING_FACTORS.indexOf(selected)) });
            m.history = m.history.slice(-100);
            m.activeFactor = selected;
            m.evaluated = m.totalSamples;
        }
        const pair = snapshot.ticker.pair;
        if (plan?.maxHoldingMinutes && now - (m.lastTrial[pair] ?? -Infinity) >= 1800 &&
            [plan.entry, plan.stop, plan.minimumTarget, plan.units, plan.worstCaseLossCad].every(x => Number.isFinite(x) && x > 0) &&
            Number.isFinite(fee) && fee >= 0 && Number.isFinite(slip) && slip >= 0) {
            // Start on the next complete minute to avoid using pre-signal OHLC data.
            m.pending.push({ at: Math.ceil(now / 60) * 60, pair, plan: structuredClone(plan), fee, slip });
            m.lastTrial[pair] = now;
        }
        await mkdir(dirname(this.file), { recursive: true });
        const temp = `${this.file}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(m, null, 2), { mode: 0o600 });
        await rename(temp, this.file);
        return m.activeFactor;
    }
}
