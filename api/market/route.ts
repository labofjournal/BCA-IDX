/* ================================================================
   /api/market — LIVE IDX MARKET API (server-side proxy)
   ----------------------------------------------------------------
   LINK API DITERAPKAN LANGSUNG DI BAWAH INI (tanpa API key —
   otomatis jalan, tidak perlu registrasi). Sumber: Yahoo Finance
   v8 chart endpoint untuk saham BCA (BBCA.JK), saham bank besar
   lainnya, dan indeks IHSG.

   Browser TIDAK bisa memanggil Yahoo langsung (CORS), maka
   route ini menjemput data di server lalu menyajikannya ke
   main.js sebagai JSON ringkas:

     GET /api/market?days=7|30|90   → payload lengkap
     GET /api/market?quote=1        → kutipan ringan (poll cepat)

   Nilai transaksi harian = estimasi harga × volume (konvensi
   pasar yang umum), dipisah per sesi bursa IDX:
     Sesi I  = 09:00–12:00 WIB
     Sesi II = 13:30–16:00 WIB
   ================================================================ */

import { NextRequest, NextResponse } from "next/server";

/* ---------- LINK API (embedded, keyless & otomatis) ---------- */
const Y1 = "https://query1.finance.yahoo.com/v8/finance/chart";
const Y2 = "https://query2.finance.yahoo.com/v8/finance/chart"; // fallback otomatis
const SOURCE_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart/BBCA.JK?range=1y&interval=1h";

const SYMBOL = "BBCA.JK";
const GMTOFFSET = 25200; // WIB (UTC+7)

const PEERS = [
  { sym: "BBRI.JK", code: "BBRI", name: "Bank Rakyat Indonesia" },
  { sym: "BMRI.JK", code: "BMRI", name: "Bank Mandiri" },
  { sym: "BBNI.JK", code: "BBNI", name: "Bank Negara Indonesia" },
  { sym: "ARTO.JK", code: "ARTO", name: "Bank Jago" },
  { sym: "BRIS.JK", code: "BRIS", name: "Bank Syariah Indonesia" },
  { sym: "BBTN.JK", code: "BBTN", name: "Bank BTN" },
];

const INDEX_SYM = "^JKSE"; // IHSG
/* header browser lengkap — Yahoo menolak request tanpa ini (HTTP 429) */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
  "Sec-Ch-Ua": '"Chromium";v="126", "Not:A-Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  Referer: "https://finance.yahoo.com/",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- cache in-memory (dedupe + TTL) ---------- */
type CacheEntry = { ts: number; data: ChartResult };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ChartResult>>();

interface ChartMeta {
  symbol?: string;
  shortName?: string;
  longName?: string;
  currency?: string;
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  regularMarketChangePercent?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  currentTradingPeriod?: {
    regular?: { start?: number; end?: number };
  };
  [k: string]: unknown;
}

interface ChartResult {
  meta: ChartMeta;
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      close?: Array<number | null>;
      volume?: Array<number | null>;
    }>;
  };
}

async function yahooChart(sym: string, interval: string, range: string): Promise<ChartResult> {
  const qs = new URLSearchParams({ range, interval, includePrePost: "false" });
  let lastErr: unknown = null;
  /* 429 → tunggu sebentar lalu berganti host (query1 ⇄ query2) */
  const attempts = [Y1, Y2, Y1, Y2];
  for (let i = 0; i < attempts.length; i++) {
    const base = attempts[i];
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 9000);
      const res = await fetch(`${base}/${encodeURIComponent(sym)}?${qs}`, {
        headers: BROWSER_HEADERS,
        signal: ctl.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      if (res.status === 429) {
        lastErr = new Error(`HTTP 429 (rate-limit) dari ${base}`);
        await sleep(1200 + Math.random() * 800);
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} dari ${base}`);
        continue;
      }
      const j = (await res.json()) as { chart?: { result?: ChartResult[] } };
      const r = j?.chart?.result?.[0];
      if (r?.meta) return r;
      lastErr = new Error("respons Yahoo tidak berisi meta");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("upstream gagal");
}

async function getFresh(key: string, ttlMs: number, loader: () => Promise<ChartResult>): Promise<ChartResult> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const data = await loader();
      cache.set(key, { ts: Date.now(), data });
      return data;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/* ---------- agregasi data intrahari per hari bursa (WIB) ---------- */
interface DayAgg {
  d: string;
  s1: number;
  s2: number;
  total: number;
  vol: number;
  close: number;
  closeTs: number;
}

function wibDateStr(ts: number): string {
  return new Date((ts + GMTOFFSET) * 1000).toISOString().slice(0, 10);
}
function wibHour(ts: number): number {
  return new Date((ts + GMTOFFSET) * 1000).getUTCHours();
}

function aggregateHourly(r: ChartResult): DayAgg[] {
  const map = new Map<string, DayAgg>();
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0];
  const closes = q?.close || [];
  const vols = q?.volume || [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    const v = vols[i];
    if (c == null || v == null || v <= 0) continue;
    const key = wibDateStr(ts[i]);
    const bucket = wibHour(ts[i]) <= 12 ? "s1" : "s2"; // <13:00 WIB → Sesi I
    let day = map.get(key);
    if (!day) {
      day = { d: key, s1: 0, s2: 0, total: 0, vol: 0, close: c, closeTs: ts[i] };
      map.set(key, day);
    }
    const value = c * v;
    day[bucket] += value;
    day.total += value;
    day.vol += v;
    if (ts[i] >= day.closeTs) {
      day.closeTs = ts[i];
      day.close = c;
    }
  }
  return [...map.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
}

interface DailyRow {
  d: string;
  close: number;
  vol: number;
}

/* bar intrahari hari bursa terakhir (untuk seed feed kutipan) */
function lastDayBars(r: ChartResult, lastDay: string): Array<{ t: string; c: number; v: number }> {
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0];
  const closes = q?.close || [];
  const vols = q?.volume || [];
  const out: Array<{ t: string; c: number; v: number }> = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    const v = vols[i];
    if (c == null || v == null || wibDateStr(ts[i]) !== lastDay) continue;
    const t = new Date((ts[i] + GMTOFFSET) * 1000).toISOString().slice(11, 16);
    out.push({ t, c, v });
  }
  return out;
}

function dailySeries(r: ChartResult): DailyRow[] {
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0];
  const closes = q?.close || [];
  const vols = q?.volume || [];
  const out: DailyRow[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    const v = vols[i];
    if (c == null || v == null) continue;
    out.push({ d: wibDateStr(ts[i]), close: c, vol: v });
  }
  return out;
}

/* ---------- metrik jendela periode ---------- */
interface WindowMetrics {
  total: number;
  vol: number;
  avgClose: number;
  closeFirst: number;
  closeLast: number;
  changePct: number;
  s1: number;
  s2: number;
}

function windowMetrics(days: DayAgg[]): WindowMetrics {
  const total = days.reduce((a, x) => a + x.total, 0);
  const vol = days.reduce((a, x) => a + x.vol, 0);
  const s1 = days.reduce((a, x) => a + x.s1, 0);
  const s2 = days.reduce((a, x) => a + x.s2, 0);
  const closeFirst = days[0]?.close || 0;
  const closeLast = days[days.length - 1]?.close || 0;
  const avgClose = days.length ? days.reduce((a, x) => a + x.close, 0) / days.length : 0;
  return {
    total,
    vol,
    avgClose,
    closeFirst,
    closeLast,
    changePct: closeFirst > 0 ? ((closeLast - closeFirst) / closeFirst) * 100 : 0,
    s1,
    s2,
  };
}

/* ---------- handler ---------- */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const light = sp.get("quote") === "1";
  const days = Math.min(250, Math.max(1, parseInt(sp.get("days") || "7", 10) || 7));

  try {
    /* data intrahari BBCA (di-refresh lebih sering untuk kutipan) */
    const bbc = await getFresh("hourly", light ? 20_000 : 60_000, () =>
      yahooChart(SYMBOL, "1h", "1y")
    );
    const allDays = aggregateHourly(bbc);
    if (!allDays.length) throw new Error("tidak ada data intrahari");

    const meta = bbc.meta;
    const window = allDays.slice(-days);
    const prev = allDays.slice(Math.max(0, allDays.length - days * 2), allDays.length - days);
    const cur = windowMetrics(window);
    const pre = prev.length >= 3 ? windowMetrics(prev) : null;

    const nowSec = Date.now() / 1000;
    const regPeriod = meta.currentTradingPeriod?.regular;
    const marketOpen =
      !!regPeriod?.start && !!regPeriod?.end && nowSec >= regPeriod.start && nowSec <= regPeriod.end;

    /* kutipan ringan: meta saja */
    if (light) {
      const todayAgg = allDays[allDays.length - 1];
      return NextResponse.json(
        {
          ok: true,
          light: true,
          asOf: new Date((meta.regularMarketTime || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
          quote: {
            price: meta.regularMarketPrice ?? todayAgg.close,
            previousClose: meta.previousClose ?? null,
            changePct: meta.regularMarketChangePercent ?? null,
            dayHigh: meta.regularMarketDayHigh ?? null,
            dayLow: meta.regularMarketDayLow ?? null,
            dayVolume: meta.regularMarketVolume ?? todayAgg.vol,
            dayValue: Math.round(todayAgg.total),
            marketOpen,
          },
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    /* saham-saham pembanding (bank besar) — berurutan + jeda kecil
       agar tidak memicu rate-limit, hasil di-cache 10 menit */
    const peerResults: Array<PromiseSettledResult<ChartResult>> = [];
    for (const p of PEERS) {
      try {
        const data = await getFresh(`d:${p.sym}`, 600_000, () => yahooChart(p.sym, "1d", "1y"));
        peerResults.push({ status: "fulfilled", value: data } as PromiseSettledResult<ChartResult>);
      } catch (e) {
        peerResults.push({ status: "rejected", reason: e } as PromiseSettledResult<ChartResult>);
      }
      await sleep(150);
    }

    const peerRows = peerResults.map((res, i) => {
      const p = PEERS[i];
      if (res.status !== "fulfilled") return null;
      const series = dailySeries(res.value);
      const w = series.slice(-days);
      if (w.length < 2) return null;
      const value = w.reduce((a, x) => a + x.close * x.vol, 0);
      const vol = w.reduce((a, x) => a + x.vol, 0);
      const closeLast = w[w.length - 1].close;
      const closeFirst = w[0].close;
      const prevClose = w.length >= 2 ? w[w.length - 2].close : closeFirst;
      return {
        code: p.code,
        name: p.name,
        value: Math.round(value),
        vol: Math.round(vol),
        closeLast,
        changePct: closeFirst > 0 ? ((closeLast - closeFirst) / closeFirst) * 100 : 0,
        dayChangePct: prevClose > 0 ? ((closeLast - prevClose) / prevClose) * 100 : 0,
      };
    });

    /* BBCA sendiri dihitung dari data intrahari (lebih presisi) */
    const bbcRow = {
      code: "BBCA",
      name: "Bank Central Asia",
      value: Math.round(cur.total),
      vol: Math.round(cur.vol),
      closeLast: cur.closeLast,
      changePct: cur.changePct,
      dayChangePct: meta.regularMarketChangePercent ?? 0,
    };

    const peers = [bbcRow, ...peerRows.filter((r): r is NonNullable<typeof r> => r !== null)]
      .sort((a, b) => b.value - a.value);
    const peersTotal = peers.reduce((a, p) => a + p.value, 0) || 1;
    const peersWithShare = peers.map((p) => ({ ...p, share: (p.value / peersTotal) * 100 }));

    let index: {
      price: number;
      dayChangePct: number;
      windowChangePct: number;
      name: string;
    } | null = null;
    try {
      const idx = await getFresh("idx", 300_000, () => yahooChart(INDEX_SYM, "1d", "1y"));
      const s = dailySeries(idx);
      if (s.length >= 2) {
        const last = s[s.length - 1];
        const prevR = s[s.length - 2];
        const w = s.slice(-days);
        index = {
          price: last.close,
          dayChangePct: prevR.close > 0 ? ((last.close - prevR.close) / prevR.close) * 100 : 0,
          windowChangePct:
            w.length >= 2 && w[0].close > 0
              ? ((w[w.length - 1].close - w[0].close) / w[0].close) * 100
              : 0,
          name: idx.meta.shortName || "IHSG",
        };
      }
    } catch {
      index = null; // IHSG opsional — jangan gagalkan payload utama
    }

    return NextResponse.json(
      {
        ok: true,
        source: {
          name: "Yahoo Finance — v8 chart API (publik, tanpa API key)",
          url: SOURCE_URL,
          fallback: `${Y2}/${SYMBOL}`,
        },
        symbol: SYMBOL,
        longName: meta.longName || meta.shortName || "Bank Central Asia",
        currency: meta.currency || "IDR",
        asOf: new Date((meta.regularMarketTime || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        marketOpen,
        quote: {
          price: meta.regularMarketPrice ?? cur.closeLast,
          previousClose: meta.previousClose ?? null,
          changePct: meta.regularMarketChangePercent ?? null,
          dayHigh: meta.regularMarketDayHigh ?? null,
          dayLow: meta.regularMarketDayLow ?? null,
          dayVolume: meta.regularMarketVolume ?? null,
          dayValue: Math.round(allDays[allDays.length - 1].total),
          dayDate: allDays[allDays.length - 1].d,
        },
        days: window.map((x) => ({
          d: x.d,
          s1: Math.round(x.s1),
          s2: Math.round(x.s2),
          total: Math.round(x.total),
          vol: Math.round(x.vol),
          close: x.close,
        })),
        prev: pre
          ? {
              total: Math.round(pre.total),
              vol: Math.round(pre.vol),
              avgClose: Math.round(pre.avgClose),
              closeLast: pre.closeLast,
              s1: Math.round(pre.s1),
              s2: Math.round(pre.s2),
            }
          : null,
        todayBars: lastDayBars(bbc, allDays[allDays.length - 1].d).slice(-12),
        peers: peersWithShare,
        index,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "upstream-unreachable",
        detail: e instanceof Error ? e.message : String(e),
        source: { name: "Yahoo Finance — v8 chart API", url: SOURCE_URL },
      },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
