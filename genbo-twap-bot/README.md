# Genbo TWAP Bot

Bot yang mengirim notifikasi TWAP baru (Hyperliquid) ke Telegram. Dijalankan di Railway dari repositori GitHub ini.

**Repositori ini harus PRIVATE dan tidak boleh berisi token.** Token & pengaturan hanya diisi di tab *Variables* Railway.

## Variabel (isi di Railway → Variables)
| Nama | Isi |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token dari @BotFather |
| `TELEGRAM_CHAT_ID` | angka dari @userinfobot |
| `MIN_USD` | nilai minimum TWAP (USD), mis. `1000` |
| `KINDS` | `spot` (hanya spot), boleh juga `perp`, `hip3` (pisah koma) |
| `COINS` | opsional, mis. `HYPE,PURR` |
| `WALLETS` | opsional, wallet pantauan (selalu dikirim) |
| `POLL_SECONDS` | `5` (minimal 5) |
| `SHOW_DELAY` | `true` = pesan memuat selisih waktu deteksi |
| `TZ` | `Asia/Jakarta` agar jam di log sesuai WIB |

Perintah start: `npm start` (menjalankan `node bot.mjs`). Perlu Node 22+ (diatur oleh `package.json` dan `.node-version`).
