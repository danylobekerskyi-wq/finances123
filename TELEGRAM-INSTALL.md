# Підключення Telegram на Windows

Ця версія надсилає Telegram-звіти лише про важливі події paper-торгівлі:
відкриття, закриття, блокер/помилку та завершення 100 угод. `WAIT` і
`NO_TRADE` не надсилаються. Telegram не вмикає live-торгівлю.

## 1. Перенесення поточного стану

Зупиніть старий бот через `Ctrl+C`. Розпакуйте архів у
`D:\бот\CryptoBot-v034-USD-paper-telegram-all-events`, відкрийте PowerShell і виконайте:

```powershell
cd "D:\бот\CryptoBot-v034-USD-paper-telegram-all-events\CryptoBot-v034-USD-paper-telegram-all-events"
Copy-Item "D:\бот\CryptoBot-v032-USD-paper-auto-news\CryptoBot-v031-USD\data" ".\data" -Recurse -Force
Copy-Item "D:\бот\CryptoBot-v032-USD-paper-auto-news\CryptoBot-v031-USD\.env" ".\.env" -Force
npm.cmd ci
```

Це переносить paper-портфель і прогрес тесту. Не копіюйте старі `src`, `dist`,
`package.json` або `package-lock.json`.

## 2. Створення Telegram-бота

У Telegram відкрийте офіційного `@BotFather`, виконайте `/newbot` і збережіть
отриманий токен лише локально. Відкрийте свого нового бота та надішліть йому
`/start`.

Відкрийте локальний `.env`:

```powershell
notepad .env
```

Додайте в кінець:

```dotenv
TELEGRAM_NOTIFICATIONS_ENABLED=false
TELEGRAM_BOT_TOKEN=вставте_токен_тут
TELEGRAM_CHAT_ID=
TELEGRAM_NOTIFY_STARTUP=true
TELEGRAM_NOTIFICATION_MODE=all
```

Не надсилайте токен у ChatGPT, Telegram-групи або скриншоти.

Для Telegram-каналу додайте створеного бота як адміністратора з дозволом
публікувати повідомлення. Для публічного каналу можна вказати
`TELEGRAM_CHAT_ID=@назва_каналу`. Для приватного каналу опублікуйте один допис
після додавання бота й запустіть команду отримання ID нижче; числовий ID каналу
зазвичай починається з `-100`.

У режимі `all` канал отримує одну подію кожного торгового циклу. За інтервалу
60 секунд це може бути приблизно 1 440 повідомлень на добу. Щоб залишити лише
відкриття, закриття, блокери й помилки, змініть режим на `important`.

## 3. Отримання chat ID та тест

Збережіть `.env` і виконайте:

```powershell
npm.cmd run telegram:chat-id
```

Скопіюйте показане число у `TELEGRAM_CHAT_ID`, змініть
`TELEGRAM_NOTIFICATIONS_ENABLED=true`, збережіть `.env`, а потім виконайте:

```powershell
npm.cmd run telegram:test
```

У Telegram має з'явитися тестове повідомлення. Команда не відкриває угод.

## 4. Перевірка і запуск

```powershell
npm.cmd test
npm.cmd run build
npm.cmd start
```

У `.env` залиште ці захисти без змін:

```dotenv
TRADING_MODE=paper
AUTO_LIVE_TRADING=false
ENABLE_LIVE_TRADING=false
ENABLE_KRAKEN_ORDER_VALIDATION=false
```

Тунель використовує той самий локальний URL `http://127.0.0.1:3000/mcp`, тому
його профіль змінювати не потрібно.
