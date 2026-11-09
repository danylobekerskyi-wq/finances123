import { expect, it } from "vitest";
import { fibonacciSignal, learnedRiskMultiplier } from "../src/fibonacci.js";
import type { Candle } from "../src/types.js";
function fixture(scale: number): Candle[] {
 const rows = Array.from({length:20},(_,i) => ({time:i*60,open:100+i/2,close:100.2+i/2,low:100+i/2,high:100.5+i/2,volume:10,vwap:100,trades:10}));
 rows.push({time:1200,open:106,close:105.5,low:105,high:106,volume:10,vwap:105,trades:10});
 rows.push({time:1260,open:105.5,close:107,low:105,high:107.2,volume:10,vwap:106,trades:10});
 return rows.map(c=>({...c,open:c.open*scale,close:c.close*scale,low:c.low*scale,high:c.high*scale}));
}
for (let i=1;i<=20;i++) {
 const scale=i/10;
 it(`Fibonacci confirmed rejection at price scale ${scale}`,()=>{
  const signal=fibonacciSignal(fixture(scale));expect(signal).not.toBeNull();expect(signal!.stop).toBeCloseTo(102.14*scale);expect(signal!.obstacle).toBeCloseTo(110*scale);
 });
 it(`No entry without bullish confirmation at scale ${scale}`,()=>{
  const c=fixture(scale);c.at(-1)!.close=105.5*scale;expect(fibonacciSignal(c)).toBeNull();
 });
 it(`Reject broken 61.8% pullback at scale ${scale}`,()=>{
  const c=fixture(scale);c.at(-2)!.low=103*scale;expect(fibonacciSignal(c)).toBeNull();
 });
 it(`Reject nonfinite data at index ${i}`,()=>{
  const c=fixture(scale);c[i]!.close=NaN;expect(fibonacciSignal(c)).toBeNull();
 });
 it(`Learning uses only bounded recent outcomes case ${i}`,()=>{
  expect(learnedRiskMultiplier(Array(i+9).fill(-0.1))).toBe(0.5);
  expect(learnedRiskMultiplier(Array(i+9).fill(0.2))).toBe(1);
  expect(learnedRiskMultiplier([...Array(i).fill(-100),...Array(20).fill(1)])).toBe(1);
  expect(learnedRiskMultiplier([NaN])).toBe(0);
 });
}
