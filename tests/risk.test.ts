import { describe, expect, it } from "vitest";
import { calculateLongPlan } from "../src/risk.js";

describe("calculateLongPlan", () => {
  it("caps a 500 USD account at 0.5% risk and 50% exposure", () => {
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

    expect(plan.positionNotionalCad).toBeLessThanOrEqual(250);
    expect(plan.worstCaseLossCad).toBeLessThanOrEqual(2.5);
    expect(plan.netRewardRisk).toBeGreaterThanOrEqual(1.99);
    expect(plan.minimumTarget).toBeGreaterThan(104);
  });

  it("rejects risk over the hard 1% cap", () => {
    expect(() =>
      calculateLongPlan({
        balanceCad: 500,
        riskPct: 1.01,
        entry: 100,
        stop: 98,
        feePctPerSide: 0.4,
        slippagePctPerSide: 0.05,
        maxExposurePct: 50,
        rewardRisk: 2,
      }),
    ).toThrow("capped at 1%");
  });

  it("rejects a stop that is not below a long entry", () => {
    expect(() =>
      calculateLongPlan({
        balanceCad: 500,
        riskPct: 0.5,
        entry: 100,
        stop: 100,
        feePctPerSide: 0.4,
        slippagePctPerSide: 0.05,
        maxExposurePct: 50,
        rewardRisk: 2,
      }),
    ).toThrow("Stop must be below entry");
  });
});
