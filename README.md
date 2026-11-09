# Crypto Trading MCP для ChatGPT і Kraken

Версія 0.3.5 додає до Telegram-звітів блок **«Чому бот прийняв це рішення»**:
причину денного захисту, кількість просканованих пар, підсумок рішень,
фактичні причини відмови та умову для наступного входу. Режим Telegram-каналу
`all` надсилає кожну подію
торгового циклу, включно з `WAIT`, `NO_TRADE`, shadow-подіями та повторними
статусами. Режим `important` залишає лише важливі повідомлення.
За інтервалу 60 секунд режим `all` може створювати приблизно 1 440 повідомлень
на добу.

Версія 0.3.3 додає опційні Telegram-звіти для paper-торгівлі. Бот надсилає
повідомлення про відкриття та автоматичне закриття paper-позиції, денний
блокер, помилку і завершення цілі. `WAIT` та `NO_TRADE` не надсилаються, а
помилки Telegram не зупиняють торговий цикл. Функція не вмикає live-режим.

Версія 0.3.1 виправляє перехід із денного захисту до shadow-циклу: якщо хоча б
одна частина shadow runtime активна, бот більше не повертає мовчки
`DAILY_BLOCKED`. Він запускає окремий shadow-цикл або повертає точний `ERROR`,
якщо ізольований shadow-брокер недоступний.

Версія 0.3 додає **окремий shadow-портфель** для навчальних даних. Коли
основний paper-рахунок зупинений денним захистом, бот може й далі фіксувати
підтверджені сигнали, симулювати максимум одну shadow-позицію та закривати її
тільки за stop або target. Shadow-угоди не змінюють `paper-state.json`, баланс
основного paper-рахунку чи прогрес до 100 угод. Захист після двох stop та денний
ліміт збитку не послаблено.

Перед початком сканування бот перевіряє кожну налаштовану пару через
офіційний Kraken `AssetPairs`. Недоступний ринок отримує `PAIR_SKIPPED` і більше
не перевіряється до перезапуску; решта пар продовжує працювати. Одна неіснуюча
USD-пара більше не зупиняє весь paper-цикл.

Сервер для денної спотової торгівлі USD-парами Kraken: аналіз 1H/15M/5M/1M, paper-рахунок і **опційний захищений live-бот Kraken**. Paper-конфігурація приймає `BTC`, `ETH`, `SOL`, `XRP`, `ADA`, `DOGE`, `LINK`, `LTC`, `AVAX` і `DOT` проти USD, але сканує лише ті ринки, які Kraken зараз повертає як `online`. За замовчуванням усе залишається в режимі `paper`; реальні ордери потребують кількох незалежних локальних дозволів.

> Це експериментальне програмне забезпечення, а не гарантія прибутку. Криптовалюта має високий ризик. Спочатку перевіряйте стратегію в paper-режимі та починайте live лише з коштів, повну втрату яких можете дозволити.

## Що робить бот

1. Отримує закриті Kraken OHLC-свічки 1M, 5M, 15M і 1H; незакриту останню свічку відкидає.
2. Порівнює Kraken із незалежним публічним level-1 order book Coinbase Exchange. Якщо пряма CAD-пара Coinbase недоступна, використовує пряму свіжу USD-книгу Coinbase без FX-конвертації. Для свіжості криптоданих використовує час знімка книги заявок, а не час останньої угоди.
3. Спочатку шукає повністю підтверджений технічний кандидат. Лише після цього в paper-режимі може автоматично виконати свіжий OpenAI web search новин і макроподій. Ручний news gate залишається стандартним режимом і є єдиним варіантом для live-бота.
4. Сигналом вважає пробій рівня опору, якщо остання закрита 1M, 5M або 15M-свічка закрилася вище максимуму попередніх 20 закритих свічок свого таймфрейму. Достатньо одного таймфрейму; пріоритет має 15M, потім 5M, потім 1M. Прокол рівня лише тінню не зараховується; ретест, обсяг і RSI не є обов'язковими.
5. Результат `WAIT_*` або `NO_TRADE_*` означає **не торгувати**. Вхід можливий лише за `BUY_SETUP_CONFIRMED`.
6. У live-режимі надсилає один обмежений `FOK` limit-buy. Якщо весь обсяг негайно не виконався, позиція не відкривається.
7. До входу прив'язується біржовий `stop-loss`. Він залишається на Kraken, навіть якщо ноутбук або сервер вимкнеться.
8. Ціль контролює локальний бот: він скасовує stop, пробує обмежений `FOK` sell і, якщо вихід не виконався, відновлює stop. Тому для автоматичного take-profit сервер має працювати.

## Незмінні обмеження

| Правило | Стандартне значення |
|---|---:|
| Максимальний капітал, який враховує live-бот | 500 USD |
| Ризик на одну угоду | 0,5% |
| Денний ліміт реалізованого збитку | 1% |
| Друга денна зупинка | 2 stop-loss виходи |
| Максимальний ордер | 250 USD |
| Максимальна експозиція | 50% |
| Мінімальний net reward:risk | 2:1 після витрат |
| Одночасні позиції | 1 |
| Paper-кандидати | BTC/USD, ETH/USD, SOL/USD, XRP/USD, ADA/USD, DOGE/USD, LINK/USD, LTC/USD, AVAX/USD, DOT/USD; недоступні Kraken-ринки автоматично пропускаються |
| Live-ринки | лише BTC/USD або ETH/USD spot long |
| Margin / leverage | ніколи |

Код не містить endpoint для виведення коштів. Він відмовляється запускати live-цикл, якщо Kraken-ключ має `Withdraw Funds` або будь-які зайві права.

## MCP-інструменти чату

| Інструмент | Дія |
|---|---|
| `scan_market` | Самостійно отримує Kraken і свіжий Coinbase best bid/ask та аналізує одну з 10 підтримуваних USD-пар |
| `calculate_trade_plan` | Розраховує units, stop, ціль, витрати та net R:R |
| `place_paper_trade` | Відкриває лише симульовану позицію |
| `get_paper_portfolio` | Показує paper cash, equity та P&L |
| `get_paper_test_progress` | Показує прогрес до 100 закритих paper-угод, W/L, P&L та середній R |
| `get_shadow_status` | Показує окремий shadow-портфель, W/L, P&L та закриття за stop/target |
| `close_paper_trade` | Закриває лише paper-позицію |
| `validate_kraken_order` | Викликає AddOrder лише з `validate=true` |
| `get_live_status` | Показує live-arm, kill switch, баланс, позицію та блокери |

Навмисно немає MCP-команди `place_live_trade`: повідомлення в чаті не може обійти локальне озброєння. Реальні входи виконує лише автономний локальний цикл.

## Встановлення на Windows

Потрібні Node.js 20+ і ноутбук/VPS, який працюватиме під час торгівлі.

**Для live-режиму не використовуйте папку OneDrive.** Перемістіть проєкт, наприклад, у `C:\crypto-trading-mcp`. Код блокує автономний live-запуск зі шляху, що містить `OneDrive`.

У PowerShell:

```powershell
cd C:\crypto-trading-mcp
npm ci
Copy-Item .env.example .env
npm test
npm run build
npm start
```

Перевірка:

```text
http://127.0.0.1:3000/health
```

У стандартному режимі відповідь містить `"mode":"paper"` і `"liveOrderSubmission":false`.

### Telegram-сповіщення

1. У Telegram відкрийте офіційного `@BotFather`, виконайте `/newbot` і
   скопіюйте токен у локальний `.env`. Токен не надсилайте в чат.
2. Відкрийте створеного бота та натисніть **Start** або надішліть `/start`.
3. Тимчасово залиште `TELEGRAM_NOTIFICATIONS_ENABLED=false`, додайте токен у
   `.env` та виконайте `npm.cmd run telegram:chat-id`. Скопіюйте показаний ID у
   `TELEGRAM_CHAT_ID`, а тоді ввімкніть сповіщення.

```dotenv
TELEGRAM_NOTIFICATIONS_ENABLED=true
TELEGRAM_BOT_TOKEN=ваш_локальний_токен
TELEGRAM_CHAT_ID=ваш_chat_id
TELEGRAM_NOTIFY_STARTUP=true
TELEGRAM_NOTIFICATION_MODE=all
```

Перевірка без відкриття угоди:

```powershell
npm.cmd run telegram:test
```

Команда надсилає лише тестове Telegram-повідомлення. Реальні ордери та
paper-позиції вона не створює.

### Оновлення з v0.2.9 без втрати двох закритих угод

Зупиніть старий сервер `Ctrl+C`. Розпакуйте v0.3.1 в нову папку, скопіюйте зі
старої папки **весь каталог `data`** та локальний `.env`, а тоді додайте до
`.env` чотири змінні `SHADOW_*` з розділу нижче. Не замінюйте нові `src`,
`package.json` або `package-lock.json` файлами v0.2.9.

Після цього виконайте в новій папці:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd start
```

## Paper-режим — обов'язковий перший етап

У `.env`:

```dotenv
TRADING_MODE=paper
AUTO_PAPER_TRADING=true
AUTO_LIVE_TRADING=false
ENABLE_LIVE_TRADING=false
PAPER_TRADE_TARGET=100
AUTO_TRADER_PAIRS=BTC/USD,ETH/USD,SOL/USD,XRP/USD,ADA/USD,DOGE/USD,LINK/USD,LTC/USD,AVAX/USD,DOT/USD
```

Розширені пари призначені для paper-тестування. Якщо `TRADING_MODE=live`, конфігурація навмисно приймає тільки `BTC/USD` та `ETH/USD`, оскільки для інших активів live-звірка балансів ще не реалізована.

### Автоматичні свіжі новини після сигналу

Щоб paper-бот сам перевіряв новини, додайте у локальний `.env`:

```dotenv
AUTO_NEWS_PROVIDER=openai
OPENAI_NEWS_MODEL=gpt-5.4-mini
OPENAI_API_KEY=ваш_новий_OpenAI_API_key
```

Ключ зберігайте тільки локально у `.env` і ніколи не вставляйте в чат, скриншот або Git. Використання OpenAI API оплачується окремо від ChatGPT Plus.

Алгоритм не запускає web search щохвилини. Спочатку він перевіряє Kraken, Coinbase, 1H/15M/5M/1M, spread, витрати і risk plan. Тільки якщо все технічно готове, бот:

1. примусово виконує live web search;
2. перевіряє події за останні 90 хвилин і високоризикові події на наступні 30 хвилин;
3. приймає `clear` лише зі щонайменше двома HTTPS-джерелами;
4. повторно отримує ціну й технічний сигнал після новин;
5. відкриває **тільки paper-позицію**.

`blocked`, `unknown`, timeout, помилка API, неправильний JSON або недостатня кількість джерел означають `NEWS_GATE_BLOCKED` і жодного входу.

Щоб залишити ручну перевірку, використовуйте:

```dotenv
AUTO_NEWS_PROVIDER=manual
```

Після фактичної перевірки календаря і новин дозвольте нові входи максимум на 15 хвилин:

```powershell
npm run news:clear -- "No material crypto headline or scheduled macro release"
```

Заблокувати входи:

```powershell
npm run news:block -- "Major event risk"
```

Paper-журнал: `data/paper-state.json` і `data/auto-trader.jsonl`.

### Shadow-журнал після денного блокування

Щоб збирати навчальні спостереження після спрацювання денного захисту, додайте
до локального `.env`:

```dotenv
SHADOW_LOGGING_ENABLED=true
SHADOW_WHEN_DAILY_BLOCKED=true
SHADOW_STATE_FILE=./data/shadow-state.json
SHADOW_JOURNAL_FILE=./data/shadow-trades.jsonl
```

Shadow-режим запускається лише тоді, коли основний paper-портфель уже має
`dailyTradingBlocked=true`. Він застосовує ту саму стратегію пробою закритої
1M/5M/15M-свічки, перевірку reference-ціни, spread, витрат, news gate, stop,
target, комісій і прослизання. Одночасно допускається максимум одна
shadow-позиція. Його власний денний ліміт не зупиняє збір даних, але ліміти
основного paper-портфеля залишаються чинними.

Файли не змішуються:

- `data/paper-state.json` — офіційні paper-угоди до цілі 100;
- `data/shadow-state.json` — окремий shadow-портфель;
- `data/shadow-trades.jsonl` — повний сигнал при вході та результат при виході;
- `data/auto-trader.jsonl` — події циклу, включно з `SHADOW_*`.

Подивитися shadow-звіт локально:

```powershell
npm.cmd run shadow:status
```

Автоматичний paper-бот відкриває лише підтверджені угоди, контролює одну позицію за раз і зупиняє нові входи після `PAPER_TRADE_TARGET` закритих угод. `WAIT`, `NO_TRADE`, `PAIR_SKIPPED` та звичайні перевірки не збільшують лічильник. Поточний прогрес доступний через `get_paper_test_progress`. Автоматичний OpenAI news gate навмисно не підключений до реальних ордерів: live-цикл і далі вимагає ручний свіжий `news:clear`.

У чаті не потрібно вручну шукати або передавати Coinbase price/timestamp: `scan_market` отримує пряму USD level-1 best bid/ask із Coinbase Exchange і повертає цю reference-котировку без FX-конвертації. Час свіжості reference-котировки береться з криптокниги Coinbase.

## Підготовка Kraken до live

Для live-режиму потрібен особистий верифікований Kraken-акаунт із USD. Рекомендовано окремий API-ключ лише для цього бота. У Kraken Pro створіть Spot API key і ввімкніть **тільки**:

- Funds: `Query Funds`;
- Orders & Trades: `Query Open Orders & Trades`;
- Orders & Trades: `Query Closed Orders & Trades`;
- Orders & Trades: `Modify Orders`;
- Orders & Trades: `Cancel/Close Orders`.

Не вмикайте `Withdraw Funds`, `Deposit Funds`, Earn, ledger/export або інші права. Якщо можливо, додайте IP allowlist. Ніколи не надсилайте API Key або Private Key у ChatGPT, месенджер чи скриншот.

Перед першим запуском на цьому Kraken-акаунті не повинно бути сторонніх відкритих ордерів або наявного BTC/ETH дорожче приблизно 1 USD: бот блокує невідомі активи й ордери, щоб не продати чужу позицію.

## Увімкнення live-коду

Спочатку зупиніть сервер `Ctrl+C`, відкрийте локальний `.env` і встановіть:

```dotenv
TRADING_MODE=live
AUTO_PAPER_TRADING=false
AUTO_LIVE_TRADING=true
ENABLE_LIVE_TRADING=true
LIVE_TRADING_ACK=I_UNDERSTAND_REAL_MONEY_CAN_BE_LOST

KRAKEN_API_KEY=ваш_public_API_key
KRAKEN_API_SECRET=ваш_private_API_key

LIVE_CAPITAL_CAP_CAD=500
LIVE_MAX_ORDER_CAD=250
RISK_PER_TRADE_PCT=0.5
DAILY_LOSS_LIMIT_PCT=1
MAX_EXPOSURE_PCT=50
```

Захистіть `.env` локальними правами Windows і не синхронізуйте його:

```powershell
icacls .env /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
```

Потім:

```powershell
npm test
npm run build
npm run live:status
npm start
```

Самих налаштувань недостатньо. Нові реальні входи ще заблоковані, доки ви локально не озброїте бота:

```powershell
npm run news:clear -- "Checked current headlines and macro calendar"
npm run live:arm -- I_UNDERSTAND_REAL_MONEY_CAN_BE_LOST
```

Arm стандартно діє 60 хвилин, після чого нові входи знову блокуються. Відкрита позиція продовжує контролюватися, а її біржовий stop не знімається.

## Аварійна зупинка

У другому PowerShell-вікні в папці проєкту:

```powershell
npm run live:stop
```

Це створює локальний `data/LIVE_STOP`, забороняє нові входи та видаляє arm. Команда **не скасовує stop відкритої позиції**. Далі перевірте Kraken Pro вручну. Щоб знову дозволити входи, спочатку усуньте причину, перевірте `npm run live:status`, а потім повторіть `live:arm`.

Ніколи не видаляйте `data/live-state.json` при відкритій позиції. Якщо статус показує невідомий ордер, невідомий баланс або `SAFETY RECOVERY FAILED`, натисніть `live:stop`, відкрийте Kraken Pro і звірте позицію та stop вручну.

Live-журнал зберігається у `data/live-trader.jsonl`. `.env`, `data/`, `dist/` та `node_modules/` виключені з Git і ZIP-передачі.

## Підключення до ChatGPT

Ваш існуючий Secure MCP Tunnel може й далі вести на `http://127.0.0.1:3000/mcp`. Після заміни коду перезапустіть `npm start`, оновіть plugin/connector і перевірте, що видно дев'ять інструментів, включно з `get_paper_test_progress`, `get_shadow_status` і `get_live_status`.

У чаті можна написати:

```text
Покажи get_live_status і поясни всі блокери. Не називай WAIT або NO_TRADE торговим сигналом.
```

## Що перевіряють тести

- індикатори, 1H/15M/5M/1M стратегія та свіжість даних;
- незалежна ціна й news gate;
- порядок `technical candidate → live web search → повторна перевірка → paper-вхід`;
- fail-closed обробку помилок OpenAI, структурованої відповіді та джерел;
- risk sizing з fee/slippage та net 2R;
- paper-ліміти;
- офіційний Kraken HMAC-приклад;
- `validate=true` для validation-only інструмента;
- live-конфігураційні запобіжники та короткочасний arm;
- відмову ключам із withdrawal/зайвими правами;
- FOK live-вхід, прикріплений stop і цільовий вихід у mock-тестах;
- MCP discovery та structured output.

Офіційні джерела: [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search), [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Kraken Add Order](https://docs.kraken.com/api-reference/trading/add-order), [Query Orders](https://docs.kraken.com/api-reference/account-data/query-orders-info), [Spot REST authentication](https://docs.kraken.com/exchange/guides/rest/authentication), [API key permissions](https://support.kraken.com/articles/360000919966-How-to-generate-an-API-key-pair-), [API key security](https://support.kraken.com/articles/api-key-security), [Kraken Pro TP/SL](https://support.kraken.com/articles/bracket-orders-on-kraken-pro).


## USD build note
Ця збірка працює з 10 Kraken USD spot-парами. Для сумісності з v031 внутрішні назви деяких полів і змінних середовища (`PAPER_STARTING_CAD`, `LIVE_CAPITAL_CAP_CAD`, `LIVE_MAX_ORDER_CAD`) залишені без перейменування, але в цій збірці їх числові значення трактуються як USD.


## Paper-only automatic news-gate refresh (v0.3.2)

For long-running PAPER tests without an OpenAI API key, set:

```dotenv
AUTO_NEWS_PROVIDER=paper-auto
```

This mode refreshes the gate timestamp automatically on every paper evaluation, so `NEWS_GATE_BLOCKED` does not recur after 15 minutes. It does **not** perform real external news verification. The configuration is rejected if live trading capability is enabled, and live automation continues to use the manual news gate.
