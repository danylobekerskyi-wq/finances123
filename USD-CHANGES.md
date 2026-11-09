# v031 USD paper build

This build changes the ten configured Kraken markets from CAD quote currency to USD:
BTC/USD, ETH/USD, SOL/USD, XRP/USD, ADA/USD, DOGE/USD, LINK/USD, LTC/USD, AVAX/USD, DOT/USD.

Reference-price cross-check now uses the matching Coinbase USD level-1 order book directly, without a Bank of Canada FX conversion. Kraken pair codes were changed to the USD markets. Live BTC/ETH reconciliation was also pointed at USD balances, but real trading remains disabled by default.

Compatibility note: v031 internal numeric field names and environment keys containing `Cad`/`_CAD` are retained so the wider runtime does not need a risky schema migration. In this USD build those numeric values represent USD.

For the 100-trade paper test, copy `.env.usd-paper.example` to `.env`, keep `TRADING_MODE=paper`, and do not enable live trading.


## v0.3.2 paper-auto news gate
- Added `AUTO_NEWS_PROVIDER=paper-auto` for long-running PAPER tests.
- The paper gate refreshes itself on every evaluation, so it does not expire after 15 minutes.
- No external news search is performed in this mode.
- The mode is rejected if live trading capability is enabled.
