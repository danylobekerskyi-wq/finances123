import type { TradePlan } from "./types.js";

export interface LongPlanInput {
  balanceCad: number;
  riskPct: number;
  entry: number;
  stop: number;
  feePctPerSide: number;
  slippagePctPerSide: number;
  maxExposurePct: number;
  rewardRisk: number;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function round(value: number, decimals = 8): number {
  const scale = 10 ** decimals;
  return Math.floor(value * scale) / scale;
}

export function calculateLongPlan(input: LongPlanInput): TradePlan {
  assertPositive("balanceCad", input.balanceCad);
  assertPositive("riskPct", input.riskPct);
  assertPositive("entry", input.entry);
  assertPositive("stop", input.stop);
  assertPositive("maxExposurePct", input.maxExposurePct);
  assertPositive("rewardRisk", input.rewardRisk);
  if (input.stop >= input.entry) throw new Error("Stop must be below entry");
  if (input.riskPct > 1) throw new Error("Risk per trade is capped at 1%");
  if (input.maxExposurePct > 100) throw new Error("Exposure cannot exceed 100%");
  if (input.rewardRisk < 2) throw new Error("Reward:risk must be at least 2");
  if (input.feePctPerSide < 0 || input.slippagePctPerSide < 0) {
    throw new Error("Fees and slippage cannot be negative");
  }

  const frictionRate =
    (input.feePctPerSide + input.slippagePctPerSide) / 100;
  if (frictionRate >= 1) throw new Error("Per-side trading friction is invalid");

  const riskBudget = (input.balanceCad * input.riskPct) / 100;
  const lossPerUnit =
    input.entry - input.stop + frictionRate * (input.entry + input.stop);
  const unitsByRisk = riskBudget / lossPerUnit;
  const exposureCap = (input.balanceCad * input.maxExposurePct) / 100;
  const unitsByExposure = exposureCap / input.entry;
  const units = Math.min(unitsByRisk, unitsByExposure);
  const notional = units * input.entry;

  const feeRate = input.feePctPerSide / 100;
  const slippageRate = input.slippagePctPerSide / 100;
  const entryFee = notional * feeRate;
  const stopFee = units * input.stop * feeRate;
  const entrySlippage = notional * slippageRate;
  const stopSlippage = units * input.stop * slippageRate;
  const worstCaseLoss =
    units * (input.entry - input.stop) +
    entryFee +
    stopFee +
    entrySlippage +
    stopSlippage;

  const minimumTarget =
    (input.entry * (1 + frictionRate) + input.rewardRisk * lossPerUnit) /
    (1 - frictionRate);
  const targetFee = units * minimumTarget * feeRate;
  const targetSlippage = units * minimumTarget * slippageRate;
  const netTargetProfit =
    units * (minimumTarget - input.entry) -
    entryFee -
    targetFee -
    entrySlippage -
    targetSlippage;

  return {
    entry: round(input.entry),
    stop: round(input.stop),
    minimumTarget: round(minimumTarget),
    riskBudgetCad: round(riskBudget, 2),
    positionNotionalCad: round(notional, 2),
    units: round(units),
    worstCaseLossCad: round(worstCaseLoss, 2),
    estimatedEntryFeeCad: round(entryFee, 2),
    estimatedStopFeeCad: round(stopFee, 2),
    estimatedEntrySlippageCad: round(entrySlippage, 2),
    estimatedStopSlippageCad: round(stopSlippage, 2),
    estimatedTargetFeeCad: round(targetFee, 2),
    estimatedTargetSlippageCad: round(targetSlippage, 2),
    netTargetProfitCad: round(netTargetProfit, 2),
    netRewardRisk: round(netTargetProfit / worstCaseLoss, 3),
    stopDistancePct: round(((input.entry - input.stop) / input.entry) * 100, 4),
    targetDistancePct: round(
      ((minimumTarget - input.entry) / input.entry) * 100,
      4,
    ),
    exposureCapped: unitsByExposure < unitsByRisk,
  };
}
