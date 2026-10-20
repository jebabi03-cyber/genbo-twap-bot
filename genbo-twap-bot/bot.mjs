// bot/main.ts
import { existsSync, readFileSync } from "node:fs";

// src/lib/format.ts
function fmtNum(n, dec = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtCompact(n) {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

// src/lib/evm.ts
var isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
var TEN = BigInt(10);

// src/lib/tgalert.ts
function parseEnv(text) {
  const out = {};
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, "");
    out[key] = val.trim();
  }
  return out;
}
var ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "MIN_USD", "COINS", "KINDS", "WALLETS", "POLL_SECONDS", "MAX_AGE_MIN", "SEND_BACKLOG", "SHOW_DELAY"];
function collectEnv(fileText, procEnv) {
  const out = fileText ? parseEnv(fileText) : {};
  for (const k of ENV_KEYS) {
    const v = procEnv[k];
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  }
  return out;
}
var list = (s) => (s ?? "").split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean);
var KINDS = ["perp", "spot", "hip3"];
function loadConfig(env2) {
  const errors = [];
  const warnings = [];
  const token = (env2.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = (env2.TELEGRAM_CHAT_ID ?? "").trim();
  if (!token || /ISI_|TOKEN_DI|YOUR_/i.test(token)) errors.push("TELEGRAM_BOT_TOKEN belum diisi di file .env");
  else if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) errors.push("TELEGRAM_BOT_TOKEN formatnya salah (seharusnya seperti 123456789:AAH...). Salin utuh dari @BotFather.");
  if (!chatId || /ISI_|CHAT_ID_DI|YOUR_/i.test(chatId)) errors.push("TELEGRAM_CHAT_ID belum diisi di file .env");
  else if (!/^(-?\d+|@\w{4,})$/.test(chatId)) errors.push("TELEGRAM_CHAT_ID harus angka (mis. 123456789, atau -100\u2026 untuk grup) atau @namachannel");
  const num2 = (key, def, min, max) => {
    const raw = (env2[key] ?? "").trim();
    if (!raw) return def;
    const n = Number(raw.replace(/[_,]/g, ""));
    if (!Number.isFinite(n) || n < min || n > max) {
      warnings.push(`${key}="${raw}" tidak valid (harus ${min}\u2013${max}); memakai ${def}`);
      return def;
    }
    return n;
  };
  const kinds = /* @__PURE__ */ new Set();
  for (const k of list(env2.KINDS).map((x) => x.toLowerCase().replace("-", ""))) {
    if (KINDS.includes(k)) kinds.add(k);
    else warnings.push(`KINDS: "${k}" tidak dikenal (pilih perp, spot, hip3)`);
  }
  const wallets = /* @__PURE__ */ new Set();
  for (const w of list(env2.WALLETS)) {
    if (isAddress(w)) wallets.add(w.toLowerCase());
    else warnings.push(`WALLETS: "${w}" bukan alamat 0x yang valid, dilewati`);
  }
  if (errors.length) return { errors, warnings };
  return {
    errors,
    warnings,
    cfg: {
      token,
      chatId,
      minUsd: num2("MIN_USD", 1e5, 0, 1e12),
      pollMs: num2("POLL_SECONDS", 20, 5, 600) * 1e3,
      maxAgeMs: num2("MAX_AGE_MIN", 30, 1, 24 * 60) * 6e4,
      coins: new Set(list(env2.COINS).map((c) => c.toUpperCase())),
      kinds,
      wallets,
      backlog: /^(1|true|ya|yes)$/i.test((env2.SEND_BACKLOG ?? "").trim()),
      showDelay: /^(1|true|ya|yes)$/i.test((env2.SHOW_DELAY ?? "").trim())
    }
  };
}
var kindOf = (coin, m) => m?.kind ?? (coin.startsWith("@") ? "spot" : coin.includes(":") ? "hip3" : "perp");
var KIND_LABEL = { perp: "PERP", spot: "SPOT", hip3: "HIP-3" };
function decide(cfg2, row, m, usd) {
  if (cfg2.wallets.has(row.user.toLowerCase())) return { ok: true };
  const kind = kindOf(row.coin, m);
  if (cfg2.kinds.size && !cfg2.kinds.has(kind)) return { ok: false, reason: `bukan pasar yang dipilih (${KIND_LABEL[kind]})` };
  if (cfg2.coins.size) {
    const names = [row.coin, m?.base, m?.display, m?.display?.split("/")[0]].filter(Boolean).map((s) => String(s).toUpperCase());
    if (!names.some((n) => cfg2.coins.has(n))) return { ok: false, reason: "koin tidak ada di COINS" };
  }
  if (!(usd > 0)) return { ok: false, reason: "harga tidak diketahui" };
  if (usd < cfg2.minUsd) return { ok: false, reason: `di bawah MIN_USD ($${fmtCompact(usd)} < $${fmtCompact(cfg2.minUsd)})` };
  return { ok: true };
}
var escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function fmtDuration(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} menit`;
  const d = Math.floor(m / 1440);
  const h = Math.floor(m % 1440 / 60);
  const mm = m % 60;
  return [d ? `${d} hari` : "", h ? `${h} jam` : "", mm ? `${mm} menit` : ""].filter(Boolean).join(" ");
}
var shortWallet = (a) => `${a.slice(0, 6)}\u2026${a.slice(-4)}`;
function formatMessage(row, m, usd, watched = false, delaySec) {
  const buy = row.side === "B";
  const base = m?.base ?? row.coin;
  const kind = KIND_LABEL[kindOf(row.coin, m)];
  const px = row.sz > 0 && usd > 0 ? usd / row.sz : 0;
  const flags = [row.reduceOnly ? "reduce-only" : "", row.randomize ? "acak" : ""].filter(Boolean).join(" \xB7 ");
  return [
    `${buy ? "\u{1F7E2}" : "\u{1F534}"} <b>TWAP ${buy ? "BUY" : "SELL"} ${escapeHtml(base)}</b> \xB7 ${kind}${watched ? " \xB7 \u{1F441} wallet pantauan" : ""}`,
    `\u{1F4B0} Nilai: <b>${usd > 0 ? "$" + fmtCompact(usd) : "n/a"}</b> (${fmtNum(row.sz, row.sz >= 100 ? 0 : 4)} ${escapeHtml(base)}${px > 0 ? ` @ ~$${fmtNum(px, px >= 1 ? 2 : 6)}` : ""})`,
    `\u23F1 Durasi: ${fmtDuration(row.minutes)}${flags ? ` \xB7 ${flags}` : ""}`,
    `\u{1F45B} <a href="https://hypurrscan.io/address/${row.user}">${shortWallet(row.user)}</a>`,
    ...delaySec !== void 0 ? [`\u26A1 terdeteksi ${Math.max(0, Math.round(delaySec))} dtk setelah dibuat`] : []
  ].join("\n");
}
var hashOf = (key) => key.slice(key.indexOf(":") + 1);
var AlertEngine = class {
  constructor(cfg2, deps) {
    this.cfg = cfg2;
    this.deps = deps;
    this.seen = /* @__PURE__ */ new Set();
    this.stats = { seen: 0, sent: 0, filtered: 0, old: 0, noPrice: 0, ended: 0 };
  }
  /** Tandai baris sebagai sudah dilihat tanpa mengirim (pemindaian awal). */
  prime(rows) {
    for (const r of rows) this.mark(hashOf(r.key));
  }
  mark(h) {
    if (this.seen.has(h)) return false;
    this.seen.add(h);
    if (this.seen.size > 3e4) for (const x of this.seen) {
      this.seen.delete(x);
      if (this.seen.size <= 2e4) break;
    }
    return true;
  }
  handle(rows, source = "hypurrscan") {
    for (const row of rows) {
      if (!this.mark(hashOf(row.key))) continue;
      this.stats.seen++;
      const m = this.deps.market(row.coin);
      const px = this.deps.price(row.coin);
      const usd = px > 0 ? px * row.sz : 0;
      const delaySec = (this.deps.now() - row.startMs) / 1e3;
      const label = `${row.side === "B" ? "BUY" : "SELL"} ${m?.base ?? row.coin} ${kindOf(row.coin, m)} ${usd > 0 ? "$" + fmtCompact(usd) : "$?"} via ${source} (+${Math.max(0, Math.round(delaySec))} dtk)`;
      const skip = (why, stat) => {
        this.stats[stat]++;
        this.deps.log?.(`\u21B7 lewati ${label} \u2014 ${why}`);
      };
      if (row.status !== "active") {
        skip("TWAP sudah berakhir", "ended");
        continue;
      }
      if (this.deps.now() - row.startMs > this.cfg.maxAgeMs) {
        skip(`lebih lama dari MAX_AGE_MIN (${Math.round(delaySec / 60)} menit)`, "old");
        continue;
      }
      const watched = this.cfg.wallets.has(row.user.toLowerCase());
      if (!watched && usd <= 0) {
        skip(`harga ${row.coin} tidak diketahui`, "noPrice");
        continue;
      }
      const d = decide(this.cfg, row, m, usd);
      if (!d.ok) {
        skip(d.reason ?? "filter", "filtered");
        continue;
      }
      this.stats.sent++;
      this.deps.log?.(`\u2192 kirim ${label}`);
      this.deps.send(formatMessage(row, m, usd, watched, this.cfg.showDelay ? delaySec : void 0));
    }
  }
};
var TelegramError = class extends Error {
  constructor(msg, status, retryAfter) {
    super(msg);
    this.status = status;
    this.retryAfter = retryAfter;
  }
};
function explainTelegramError(e) {
  const d = e.message.toLowerCase();
  if (e.status === 401 || d.includes("unauthorized")) return "Token bot ditolak Telegram (salah/dicabut). Periksa TELEGRAM_BOT_TOKEN.";
  if (d.includes("chat not found")) return "Chat tidak ditemukan. Buka bot Anda di Telegram dan kirim /start dulu, lalu cek TELEGRAM_CHAT_ID.";
  if (d.includes("bot was blocked")) return "Bot diblokir oleh chat ini. Buka blokirnya di Telegram.";
  if (d.includes("kicked") || d.includes("not a member")) return "Bot dikeluarkan dari grup/channel. Tambahkan lagi sebagai anggota/admin.";
  return `Telegram: ${e.message}`;
}
var TelegramSender = class {
  constructor(token, chatId, fetchFn, opts = {}) {
    this.token = token;
    this.chatId = chatId;
    this.fetchFn = fetchFn;
    this.opts = opts;
    this.queue = [];
    this.running = null;
    this.dropped = 0;
    this.sent = 0;
    this.failed = 0;
    this.sleep = (ms) => (this.opts.sleep ?? ((n) => new Promise((r) => setTimeout(r, n))))(ms);
  }
  async post(text) {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
    });
    let j = null;
    try {
      j = await res.json();
    } catch {
    }
    if (res.ok && j?.ok !== false) return;
    throw new TelegramError(String(j?.description ?? `HTTP ${res.status}`), res.status, j?.parameters?.retry_after);
  }
  /** Kirim langsung (tanpa antrean); melempar bila gagal. Dipakai untuk pesan uji. */
  sendNow(text) {
    return this.post(text);
  }
  enqueue(text) {
    const max = this.opts.maxQueue ?? 40;
    this.queue.push(text);
    while (this.queue.length > max) {
      this.queue.shift();
      this.dropped++;
    }
    if (!this.running) this.running = this.drain().finally(() => this.running = null);
  }
  /** Selesai bila antrean kosong (untuk uji). */
  async idle() {
    while (this.running) await this.running;
  }
  async drain() {
    while (this.queue.length) {
      let text = this.queue.shift();
      if (this.dropped > 0) {
        text = `\u26A0 ${this.dropped} TWAP lain dilewati (terlalu banyak sekaligus). Naikkan MIN_USD untuk mengurangi.

${text}`;
        this.dropped = 0;
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await this.post(text);
          this.sent++;
          break;
        } catch (e) {
          const err = e instanceof TelegramError ? e : new TelegramError(e instanceof Error ? e.message : String(e), 0);
          if (err.status === 429 && attempt < 3) {
            await this.sleep(((err.retryAfter ?? 5) + 1) * 1e3);
            continue;
          }
          if (!(e instanceof TelegramError) && attempt < 3) {
            await this.sleep(2e3);
            continue;
          }
          this.failed++;
          this.opts.onError?.(e instanceof TelegramError ? explainTelegramError(err) : `Gagal mengirim: ${err.message}`);
          break;
        }
      }
      await this.sleep(this.opts.gapMs ?? 1100);
    }
  }
};

// src/lib/hl.ts
var WS_URL = "wss://api.hyperliquid.xyz/ws";
var REST_URL = "https://api.hyperliquid.xyz/info";
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
async function info(body, signal) {
  const res = await fetch(REST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) throw new HttpError(res.status, `Hyperliquid /info ${res.status}`);
  return await res.json();
}

// src/lib/socket.ts
var HLSocket = class {
  constructor(url = WS_URL) {
    this.url = url;
    this.ws = null;
    this.handlers = /* @__PURE__ */ new Map();
    this.subs = /* @__PURE__ */ new Map();
    this.statusCbs = /* @__PURE__ */ new Set();
    this.retry = 0;
    this.stopped = false;
    this.status = "closed";
  }
  onStatus(cb) {
    this.statusCbs.add(cb);
    cb(this.status);
    return () => this.statusCbs.delete(cb);
  }
  setStatus(s) {
    this.status = s;
    this.statusCbs.forEach((cb) => cb(s));
  }
  connect() {
    this.stopped = false;
    if (this.ws) return;
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("open");
      this.subs.forEach((e) => this.send({ method: "subscribe", subscription: e.sub }));
      this.pingTimer = setInterval(() => this.send({ method: "ping" }), 25e3);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg.channel) return;
      this.handlers.get(msg.channel)?.forEach((h) => h(msg.data));
    };
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.ws = null;
      this.setStatus("closed");
      if (!this.stopped) {
        const delay = Math.min(1e3 * 2 ** this.retry++, 15e3);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    };
    ws.onerror = () => ws.close();
  }
  disconnect() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
  /** Subscribe; mengembalikan fungsi unsubscribe. */
  subscribe(sub, handler) {
    const channel = String(sub.type);
    const key = JSON.stringify(sub);
    let set = this.handlers.get(channel);
    if (!set) this.handlers.set(channel, set = /* @__PURE__ */ new Set());
    set.add(handler);
    const existing = this.subs.get(key);
    if (existing) existing.count++;
    else {
      this.subs.set(key, { sub, count: 1 });
      this.send({ method: "subscribe", subscription: sub });
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set.delete(handler);
      const e = this.subs.get(key);
      if (!e) return;
      if (--e.count <= 0) {
        this.subs.delete(key);
        this.send({ method: "unsubscribe", subscription: sub });
      }
    };
  }
};

// src/lib/markets.ts
var num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
function perpMarkets(meta, ctxs, dex = "", dexPos = 0) {
  const out = [];
  meta.universe.forEach((u, i) => {
    if (u.isDelisted) return;
    const c = ctxs[i] ?? {};
    const base = u.name.includes(":") ? u.name.split(":")[1] : u.name;
    out.push({
      coin: u.name,
      display: dex ? u.name : `${base}/USDC`,
      base,
      quote: "USDC",
      kind: dex ? "hip3" : "perp",
      dex: dex || void 0,
      assetId: dexPos === 0 ? i : 1e5 + dexPos * 1e4 + i,
      prevDayPx: num(c.prevDayPx),
      markPx: num(c.markPx ?? c.midPx),
      dayNtlVlm: num(c.dayNtlVlm),
      funding: num(c.funding),
      openInterest: num(c.openInterest),
      oraclePx: num(c.oraclePx)
    });
  });
  return out;
}
function spotMarkets(meta, ctxs) {
  const tok = new Map(meta.tokens.map((t) => [t.index, t.name]));
  return meta.universe.map((u, i) => {
    const base = tok.get(u.tokens[0]) ?? u.name;
    const quote = tok.get(u.tokens[1]) ?? "USDC";
    const c = ctxs[i] ?? {};
    return {
      coin: u.name.includes("/") ? u.name : `@${u.index}`,
      display: `${base}/${quote}`,
      base,
      quote,
      kind: "spot",
      assetId: 1e4 + u.index,
      prevDayPx: num(c.prevDayPx),
      markPx: num(c.markPx ?? c.midPx),
      dayNtlVlm: num(c.dayNtlVlm)
    };
  });
}
function assetIdMap(markets) {
  const m = /* @__PURE__ */ new Map();
  for (const x of markets) if (x.assetId !== void 0) m.set(x.assetId, x.coin);
  return m;
}
function priceOf(m, mids) {
  return mids[m.coin] || m.markPx;
}

// src/lib/twapscan.ts
function parseExplorerTx(tx, resolveCoin) {
  const type = tx?.action?.type;
  if (type === "twapCancel") return tx.error ? null : { kind: "cancel", user: String(tx.user).toLowerCase() };
  if (type !== "twapOrder" || tx.error) return null;
  const t = tx.action.twap;
  if (!t) return null;
  const a = Number(t.a);
  const sz = Number(t.s);
  const minutes = Number(t.m);
  if (!Number.isFinite(a) || !(sz > 0) || !(minutes > 0)) return null;
  const time = tx.time < 1e12 ? tx.time * 1e3 : tx.time;
  const user = String(tx.user).toLowerCase();
  return {
    kind: "create",
    row: {
      key: `tx:${tx.hash}`,
      user,
      coin: resolveCoin(a) ?? `#${a}`,
      side: t.b ? "B" : "A",
      sz,
      executedSz: 0,
      executedNtl: 0,
      minutes,
      startMs: time,
      status: "active",
      live: false,
      provisional: true,
      randomize: Boolean(t.t),
      reduceOnly: Boolean(t.r)
    }
  };
}

// src/lib/hypurrscan.ts
var HS_TWAP_PATHS = ["/hs/twap/*", "https://api.hypurrscan.io/twap/*"];
var GRACE_MS = 18e4;
function parseHypurrscan(list2, resolveCoin, now) {
  if (!Array.isArray(list2)) return [];
  const rows = [];
  for (const tx of list2) {
    const ev = parseExplorerTx(tx, resolveCoin);
    if (!ev || ev.kind !== "create") continue;
    const r = ev.row;
    let status = "active";
    let note;
    const ended = typeof tx.ended === "string" ? tx.ended : void 0;
    if (ended) {
      status = ended === "terminated" || ended === "stopped" || ended === "finished" ? ended : "error";
      note = `berakhir: ${ended}`;
    } else if (now > r.startMs + r.minutes * 6e4 + GRACE_MS) {
      status = "finished";
      note = "durasi habis";
    }
    rows.push({ ...r, key: `hs:${tx.hash}`, status, provisional: false, note });
  }
  return rows;
}
async function fetchHypurrscan(fetchFn, preferred = 0, paths = HS_TWAP_PATHS) {
  const order = [preferred, ...paths.map((_, i) => i).filter((i) => i !== preferred)];
  let lastErr;
  for (const i of order) {
    try {
      const res = await fetchFn(paths[i]);
      if (!res.ok) continue;
      if ((res.headers?.get("content-type") ?? "").includes("html")) continue;
      const data = await res.json();
      if (Array.isArray(data)) return { data, via: i };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Hypurrscan tidak terjangkau");
}

// bot/run.ts
var HS_DIRECT = ["https://api.hypurrscan.io/twap/*"];
var clock = () => (/* @__PURE__ */ new Date()).toLocaleTimeString("id-ID", { hour12: false });
async function loadMarkets() {
  const [perp, dexs, spot] = await Promise.allSettled([
    info({ type: "metaAndAssetCtxs" }),
    info({ type: "perpDexs" }),
    info({ type: "spotMetaAndAssetCtxs" })
  ]);
  const markets = [];
  if (perp.status === "fulfilled") markets.push(...perpMarkets(perp.value[0], perp.value[1]));
  if (dexs.status === "fulfilled" && Array.isArray(dexs.value)) {
    const dl = dexs.value.map((d, pos) => ({ name: d?.name, pos })).filter((d) => Boolean(d.name));
    const res = await Promise.allSettled(dl.map((d) => info({ type: "metaAndAssetCtxs", dex: d.name })));
    res.forEach((r, i) => {
      if (r.status === "fulfilled") markets.push(...perpMarkets(r.value[0], r.value[1], dl[i].name, dl[i].pos));
    });
  }
  if (spot.status === "fulfilled") markets.push(...spotMarkets(spot.value[0], spot.value[1]));
  return markets;
}
async function run(o) {
  const { cfg: cfg2 } = o;
  const log = (m) => (o.log ?? console.log)(`[${clock()}] ${m}`);
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const alive = () => !o.signal?.aborted;
  const sender = new TelegramSender(cfg2.token, cfg2.chatId, ((u, i) => fetch(u, i)), {
    gapMs: o.gapMs,
    sleep: o.sleep,
    onError: (m) => log(`\u274C ${m}`)
  });
  try {
    await sender.sendNow(
      o.testOnly ? "\u2705 <b>Tes berhasil</b> \u2014 bot TWAP terhubung ke chat ini." : `\u2705 <b>Bot TWAP aktif</b>
Minimum: <b>$${cfg2.minUsd.toLocaleString("en-US")}</b>${cfg2.coins.size ? `
Koin: ${escapeHtml([...cfg2.coins].join(", "))}` : ""}${cfg2.kinds.size ? `
Pasar: ${[...cfg2.kinds].join(", ")}` : ""}${cfg2.wallets.size ? `
Wallet pantauan: ${cfg2.wallets.size}` : ""}`
    );
  } catch (e) {
    throw new Error(e instanceof TelegramError ? explainTelegramError(e) : `Tidak bisa menghubungi Telegram: ${e instanceof Error ? e.message : e}`);
  }
  log("\u2705 Terhubung ke Telegram");
  if (o.testOnly) return { engine: void 0, sender };
  let markets = await loadMarkets();
  if (!markets.length) throw new Error("Gagal memuat daftar pasar Hyperliquid (cek koneksi internet)");
  let byCoin = new Map(markets.map((m) => [m.coin, m]));
  let idMap = assetIdMap(markets);
  let mids = {};
  const loadMids = async () => {
    try {
      const raw = await info({ type: "allMids" });
      mids = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
    } catch (e) {
      log(`peringatan: gagal memuat harga (${e instanceof Error ? e.message : e})`);
    }
  };
  await loadMids();
  log(`Pasar dimuat: ${markets.length}`);
  const engine = new AlertEngine(cfg2, {
    market: (c) => byCoin.get(c),
    price: (c) => {
      const m = byCoin.get(c);
      return m ? priceOf(m, mids) : mids[c] || 0;
    },
    send: (t) => sender.enqueue(t),
    now: () => Date.now(),
    log
  });
  const resolve = (a) => idMap.get(a);
  let socket;
  if (typeof globalThis.WebSocket !== "undefined") {
    socket = new HLSocket("wss://rpc.hyperliquid.xyz/ws");
    socket.connect();
    socket.subscribe({ type: "explorerTxs" }, (list2) => {
      if (!Array.isArray(list2)) return;
      for (const tx of list2) {
        const ev = parseExplorerTx(tx, resolve);
        if (ev && ev.kind === "create") engine.handle([ev.row], "explorer");
      }
    });
    log("Feed explorer real-time aktif");
  } else {
    log("Catatan: Node Anda belum punya WebSocket bawaan (butuh Node 22+). Memakai polling Hypurrscan saja \u2014 deteksi bisa tertunda \xB1" + Math.round(cfg2.pollMs / 1e3) + " dtk.");
  }
  let primed = false;
  let lastMids = Date.now();
  let lastMarkets = Date.now();
  let lastBeat = Date.now();
  let failures = 0;
  while (alive()) {
    try {
      const res = await fetchHypurrscan((u) => fetch(u), 0, HS_DIRECT);
      const rows = parseHypurrscan(res.data, resolve, Date.now());
      if (!primed) {
        if (!cfg2.backlog) engine.prime(rows);
        else engine.handle(rows, "hypurrscan");
        primed = true;
        log(`Pemindaian awal: ${rows.filter((r) => r.status === "active").length} TWAP aktif ${cfg2.backlog ? "diproses" : "dilewati (hanya TWAP baru yang dikirim)"}`);
      } else engine.handle(rows, "hypurrscan");
      failures = 0;
    } catch (e) {
      if (++failures === 1 || failures % 10 === 0) log(`peringatan: Hypurrscan gagal (${e instanceof Error ? e.message : e}) \u2014 mencoba lagi`);
    }
    if (o.once) break;
    await sleep(cfg2.pollMs);
    const now = Date.now();
    if (now - lastMids > 1e4) {
      lastMids = now;
      await loadMids();
    }
    if (now - lastMarkets > 10 * 6e4) {
      lastMarkets = now;
      try {
        const fresh = await loadMarkets();
        if (fresh.length) {
          markets = fresh;
          byCoin = new Map(markets.map((m) => [m.coin, m]));
          idMap = assetIdMap(markets);
        }
      } catch {
      }
    }
    if (now - lastBeat > 5 * 6e4) {
      lastBeat = now;
      const s = engine.stats;
      log(`Berjalan \xB7 baru terpantau ${s.seen} \xB7 terkirim ${s.sent} \xB7 disaring ${s.filtered} \xB7 terlalu lama ${s.old} \xB7 sudah berakhir ${s.ended} \xB7 tanpa harga ${s.noPrice}`);
    }
  }
  socket?.disconnect();
  return { engine, sender };
}

// bot/main.ts
function fail(msg) {
  console.error(msg);
  process.exit(1);
  throw new Error(msg);
}
var file = ".env";
var env = collectEnv(existsSync(file) ? readFileSync(file, "utf8") : void 0, process.env);
if (!existsSync(file) && !env.TELEGRAM_BOT_TOKEN) {
  fail("\nPengaturan tidak ditemukan.\n- Di komputer: jalankan  copy bot.env.example .env  lalu isi token & chat id dengan Notepad.\n- Di Railway: isi Variables TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID.\n");
}
var loaded = loadConfig(env);
loaded.warnings.forEach((w) => console.warn("\u26A0 " + w));
var cfg = loaded.cfg ?? fail("\nPengaturan belum benar:\n" + loaded.errors.map((e) => " - " + e).join("\n") + "\n");
var testOnly = process.argv.includes("--test");
console.log(testOnly ? "Mengirim pesan uji ke Telegram\u2026" : `Bot TWAP \u2192 Telegram dimulai (minimum $${cfg.minUsd.toLocaleString("en-US")}, cek tiap ${cfg.pollMs / 1e3} dtk). Tekan Ctrl+C untuk berhenti.`);
run({ cfg, testOnly }).then(() => testOnly && process.exit(0)).catch((e) => {
  console.error("\n\u274C " + (e instanceof Error ? e.message : e) + "\n");
  process.exit(1);
});
process.on("SIGINT", () => {
  console.log("\nBot dihentikan.");
  process.exit(0);
});
