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
];
// The expanded list is enabled for market scans and paper trading. The live
// broker's account-reconciliation code remains deliberately limited to the two
// assets it can independently verify end to end.
export const LIVE_SUPPORTED_PAIRS = ["BTC/USD", "ETH/USD"];
