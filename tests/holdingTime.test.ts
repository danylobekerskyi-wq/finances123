import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseHoldingMinutes } from "../src/holdingTime.js";
import { PaperBroker } from "../src/paperBroker.js";
import { calculateLongPlan } from "../src/risk.js";
it("chooses shorter time for higher volatility", () => {
 expect(chooseHoldingMinutes(100,102,0.5)).toBe(8);
 expect(chooseHoldingMinutes(100,102,1)).toBe(4);
});
it("bounds the scalp horizon", () => {
 expect(chooseHoldingMinutes(100,101,10)).toBe(3);
 expect(chooseHoldingMinutes(100,110,0.01)).toBe(30);
});
for (const value of [NaN,Infinity,0,-1]) it(`rejects invalid volatility ${value}`,()=>{
 expect(()=>chooseHoldingMinutes(100,102,value)).toThrow();
});
for (const [bid,reason] of [[100,"TIME_EXIT"],[97,"STOP"],[120,"TARGET"]] as const) {
 it(`persists deadline across restart and closes with ${reason}`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),"holding-test-"));
  let now=Date.parse("2026-11-09T12:00:00Z");
  const options={dataFile:join(dir,"state.json"),startingBalanceCad:500,dailyLossLimitPct:2,feePctPerSide:0.4,slippagePctPerSide:0.05,clock:()=>now};
  try {
   const broker=new PaperBroker(options);
   const plan=calculateLongPlan({balanceCad:500,riskPct:0.5,entry:100,stop:98,feePctPerSide:0.4,slippagePctPerSide:0.05,maxExposurePct:50,rewardRisk:2});
   await broker.openPosition("BTC/USD",{...plan,maxHoldingMinutes:8});
   const restarted=new PaperBroker(options);
   now+=8*60000-1;
   expect(await restarted.settleTriggeredPosition(100)).toBeNull();
   now+=1;
   const closed=await restarted.settleTriggeredPosition(bid);
   expect(closed?.reason).toBe(reason);
   expect(closed?.maxHoldingMinutes).toBe(8);
   if(reason==="TIME_EXIT")expect(closed?.exitPriceCad).toBeCloseTo(99.95);
   expect(await restarted.settleTriggeredPosition(bid)).toBeNull();
   expect((await restarted.getState()).closedTrades).toHaveLength(1);
  } finally {await rm(dir,{recursive:true,force:true});}
 });
}
