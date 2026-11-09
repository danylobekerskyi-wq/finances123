export const SUPPORTED_PAIRS = [
  "BTC/USD",
  "ETH/USD",
  "SOL/USD",
  "XRP/USD",
  "ADA/USD",
  "DOGE/USD",
  "LINK/USD",
  "LTC/USD",
  "AVAX/USD",
  "DOT/USD",
] as const;

// The expanded list is enabled for market scans and paper trading. The live
// broker's account-reconciliation code remains deliberately limited to the two
// assets it can independently verify end to end.
export const LIVE_SUPPORTED_PAIRS = ["BTC/USD", "ETH/USD"] as const;

export type SupportedPair = (typeof SUPPORTED_PAIRS)[number];

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vwap: number;
  volume: number;
  trades: number;
}

export interface Ticker {
  pair: SupportedPair;
  ask: number;
  bid: number;
  last: number;
  openUtc: number;
  high24h: number;
  low24h: number;
  volume24h: number;
}

export interface MarketSnapshot {
  ticker: Ticker;
  candles1m: Candle[];
  candles5m: Candle[];
  candles15m: Candle[];
  candles1h: Candle[];
  capturedAt: string;
  source: "Kraken";
}

export interface MarketDataProvider {
  getSnapshot(pair: SupportedPair): Promise<MarketSnapshot>;
  getTicker(pair: SupportedPair): Promise<Ticker>;
}

export type Regime = "BULLISH" | "BEARISH" | "RANGE";

export type TradingDecision =
  | "BUY_SETUP_CONFIRMED"
  | "WAIT_SETUP_NOT_CONFIRMED"
  | "NO_TRADE_DATA_NOT_RELIABLE"
  | "NO_TRADE_COSTS_TOO_HIGH"
  | "NO_TRADE_NEWS_CHECK_REQUIRED"
  | "NO_TRADE_CROSSCHECK_REQUIRED";

export type SetupName =
  | "FIBONACCI_SCALP"
  | "BREAKOUT_CLOSE"
  | "BREAKOUT_RETEST"
  | "TREND_PULLBACK"
  | "RANGE_REVERSAL"
  | "NONE";

export interface TradePlan {
  entry: number;
  stop: number;
  minimumTarget: number;
  riskBudgetCad: number;
  positionNotionalCad: number;
  units: number;
  worstCaseLossCad: number;
  estimatedEntryFeeCad: number;
  estimatedStopFeeCad: number;
  estimatedEntrySlippageCad: number;
  estimatedStopSlippageCad: number;
  estimatedTargetFeeCad: number;
  estimatedTargetSlippageCad: number;
  netTargetProfitCad: number;
  netRewardRisk: number;
  stopDistancePct: number;
  targetDistancePct: number;
  exposureCapped: boolean;
}

export interface ScanResult {
  decision: TradingDecision;
  pair: SupportedPair;
  exchange: "Kraken";
  capturedAt: string;
  currentPriceCad: number;
  bidCad: number;
  askCad: number;
  spreadPct: number;
  dataAgeSeconds: number;
  regime1h: Regime;
  setup15m: SetupName;
  trigger5m: boolean;
  triggerTimeframe?: "1M" | "5M" | "15M" | null;
  reasons: string[];
  reEvaluateWhen: string;
  referencePriceDifferencePct: number | null;
  newsStatus: "clear" | "unknown" | "blocked";
  plan: TradePlan | null;
  signalExpiresAt: string | null;
}

export interface PaperPosition {
  id: string;
  pair: SupportedPair;
  units: number;
  entryPriceCad: number;
  entryNotionalCad: number;
  entryFeeCad: number;
  stopCad: number;
  targetCad: number;
  openedAt: string;
  plannedRiskCad: number;
}

export interface ClosedPaperTrade extends PaperPosition {
  exitPriceCad: number;
  exitFeeCad: number;
  closedAt: string;
  reason: "STOP" | "TARGET" | "MANUAL";
  realizedPnlCad: number;
  resultR: number;
}

export interface PaperState {
  startingBalanceCad: number;
  cashCad: number;
  position: PaperPosition | null;
  closedTrades: ClosedPaperTrade[];
  updatedAt: string;
}

export interface PaperPortfolio {
  state: PaperState;
  marketPriceCad: number | null;
  equityCad: number;
  unrealizedPnlCad: number;
  realizedPnlCad: number;
  dailyRealizedPnlCad: number;
  dailyStopCount: number;
  dailyTradingBlocked: boolean;
  dailyTradingBlockReason: string | null;
}

export interface PaperTestProgress {
  targetTrades: number;
  closedTrades: number;
  remainingTrades: number;
  targetReached: boolean;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number;
  realizedPnlCad: number;
  averageResultR: number;
  profitFactor: number | null;
}

export interface ShadowJournalEvent {
  at: string;
  action: "SHADOW_TRADE_OPENED" | "SHADOW_TRADE_CLOSED";
  blockedReason: string;
  pair: SupportedPair;
  position?: PaperPosition;
  trade?: ClosedPaperTrade;
  signal?: ScanResult;
}

export interface ShadowStatus {
  mode: "shadow";
  portfolio: PaperPortfolio;
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number;
  realizedPnlCad: number;
  averageResultR: number;
  profitFactor: number | null;
}

export interface StoredSignal {
  id: string;
  result: ScanResult;
  createdAt: string;
}

export interface LivePosition {
  id: string;
  pair: SupportedPair;
  units: number;
  entryPriceCad: number;
  entryCostCad: number;
  entryFeeCad: number;
  stopCad: number;
  targetCad: number;
  openedAt: string;
  plannedRiskCad: number;
  entryOrderTxid: string;
  entryClientOrderId: string;
  protectiveOrderTxid: string;
}

export interface ClosedLiveTrade extends LivePosition {
  exitPriceCad: number;
  exitProceedsCad: number;
  exitFeeCad: number;
  closedAt: string;
  exitOrderTxid: string;
  reason: "STOP" | "TARGET";
  realizedPnlCad: number;
  resultR: number;
}

export interface PendingLiveEntry {
  clientOrderId: string;
  pair: SupportedPair;
  units: number;
  entryLimitCad: number;
  stopCad: number;
  targetCad: number;
  plannedRiskCad: number;
  createdAt: string;
  txid: string | null;
}

export interface PendingLiveExit {
  clientOrderId: string;
  positionId: string;
  reason: "TARGET";
  createdAt: string;
  txid: string | null;
}

export interface LiveState {
  version: 1;
  position: LivePosition | null;
  pendingEntry: PendingLiveEntry | null;
  pendingExit: PendingLiveExit | null;
  closedTrades: ClosedLiveTrade[];
  dayStartingEquityCad: Record<string, number>;
  updatedAt: string;
}

export interface LiveDailyStatus {
  date: string;
  startingEquityCad: number;
  realizedPnlCad: number;
  stopCount: number;
  blocked: boolean;
  reason: string | null;
}

export interface LiveAccountStatus {
  cadBalance: number;
  btcBalance: number;
  ethBalance: number;
  effectiveTradingEquityCad: number;
  openOrderCount: number;
}

export interface LiveStatus {
  mode: "live";
  configured: boolean;
  submissionEnabled: boolean;
  autoTrading: boolean;
  armed: boolean;
  armReason: string;
  armExpiresAt: string | null;
  killSwitchActive: boolean;
  state: LiveState | null;
  account: LiveAccountStatus | null;
  daily: LiveDailyStatus | null;
  blockers: string[];
}
