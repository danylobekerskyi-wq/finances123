import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SelfImprovement, selectFactor, replayTrial, adjustedHolding } from "../src/selfImprovement.js";
import type { LearningSample } from "../src/selfImprovement.js";
import type { MarketSnapshot, TradePlan } from "../src/types.js";
const rows=(train:number[],valid=train):LearningSample[]=>Array.from({length:50},(_,i)=>({at:i*1800,scores:i<30?train:valid}));
it("requires 50 observations",()=>expect(selectFactor(rows([2,1,0]).slice(1),1)).toBe(1));
it("promotes a winner confirmed on unseen validation",()=>expect(selectFactor(rows([2,1,0]),1)).toBe(.75));
it("rejects overfitting",()=>expect(selectFactor(rows([2,1,0],[0,1,0]),1)).toBe(1));
it("rejects negative returns even when relatively better",()=>expect(selectFactor(rows([-1,-2,-3]),1)).toBe(1));
it("requires a meaningful validation advantage",()=>expect(selectFactor(rows([2,1,0],[1.05,1,0]),1)).toBe(1));
it("rejects nonfinite results",()=>expect(selectFactor(rows([NaN,1,0]),1)).toBe(1));
it("can revert to baseline after new evidence",()=>expect(selectFactor(rows([0,2,1]),.75)).toBe(1));
it("enforces holding bounds",()=>{expect(adjustedHolding(3,.75)).toBe(3);expect(adjustedHolding(30,1.25)).toBe(30);});
const plan={entry:100,stop:98,minimumTarget:105,units:1,worstCaseLossCad:2,maxHoldingMinutes:4} as TradePlan;
const candles=Array.from({length:30},(_,i)=>({time:1800000000+i*60,open:100,low:99,high:102,close:101,volume:1,vwap:100,trades:1}));
it("includes fees and slippage in replay",()=>expect(replayTrial(plan,candles,1,.4,.05)).toBeLessThan(replayTrial(plan,candles,1,0,0)));
it("uses stop first on ambiguous OHLC",()=>expect(replayTrial(plan,[{...candles[0]!,low:97,high:106},...candles.slice(1)],1,0,0)).toBe(-1));
it("rejects incomplete replay",()=>expect(()=>replayTrial(plan,[],1,0,0)).toThrow());
it("persists observations across restart without duplicating a signal",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"learner-")),file=join(dir,"memory.json");
 const snapshot={ticker:{pair:"BTC/USD"},capturedAt:new Date(1800000000*1000).toISOString(),candles1m:[]} as unknown as MarketSnapshot;
 try {
  expect(await new SelfImprovement(file).observe(snapshot,plan,.4,.05)).toBe(1);
  await new SelfImprovement(file).observe(snapshot,plan,.4,.05);
  expect(JSON.parse(await readFile(file,"utf8")).pending).toHaveLength(1);
  const later={...snapshot,capturedAt:new Date((1800000000+1800)*1000).toISOString(),candles1m:candles};
  await new SelfImprovement(file).observe(later,null,.4,.05);
  await new SelfImprovement(file).observe(later,null,.4,.05);
  const memory=JSON.parse(await readFile(file,"utf8"));
  expect(memory.totalSamples).toBe(1);expect(memory.pending).toHaveLength(0);expect(memory.activeFactor).toBe(1);
 } finally {await rm(dir,{recursive:true,force:true});}
});
it("does not replace corrupt memory silently",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"learner-corrupt-")),file=join(dir,"memory.json");
 try {await writeFile(file,"broken");await expect(new SelfImprovement(file).observe({} as MarketSnapshot,null,0,0)).rejects.toThrow();expect(await readFile(file,"utf8")).toBe("broken");}
 finally {await rm(dir,{recursive:true,force:true});}
});
