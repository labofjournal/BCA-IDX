/* ================================================================
   main.js — BCA IDX LIVE MARKET CONSOLE
   ----------------------------------------------------------------
   DIJADIKAN ONLINE: seluruh angka pada dashboard kini dijemput
   LANGSUNG dari API pasar (sebelumnya: simulasi PRNG di browser).

   LINK API — DITERAPKAN LANGSUNG & OTOMATIS (blok CONFIG di bawah):
     · Endpoint internal : /api/market            (proxy server ini)
     · Sumber langsung   : https://query1.finance.yahoo.com/v8/finance/chart/BBCA.JK?range=1y&interval=1h
     · Fallback otomatis : https://query2.finance.yahoo.com/v8/finance/chart/BBCA.JK
     · Tanpa API key     — publik & otomatis. SLOT API.KEY di bawah
       tetap disediakan: bila Anda memakai provider berbayar,
       isi key-nya di situ dan otomatis dipakai setiap request.

   Aliran data:
     Yahoo Finance → /api/market (agregasi sesi I & II bursa IDX)
     → main.js (fetch) → chart, KPI, hero, saham teraktif,
       komposisi sesi, ticker, feed kutipan, ekspor CSV/XLSX.

   Jika API tidak terjangkau, dashboard jatuh ke MODE SIMULASI
   (lencana merah) agar tampilan tetap hidup — jujur dilabeli.
   ================================================================ */

/* ============ CONFIG — LINK API (langsung & otomatis) ============ */
const API = {
    URL: '/api/market',                    // ← endpoint data live (server ini)
    SOURCE_URL: 'https://query1.finance.yahoo.com/v8/finance/chart/BBCA.JK?range=1y&interval=1h',
    SYMBOL: 'BBCA.JK',                     // PT Bank Central Asia Tbk (IDX)
    KEY: '',                               // ← SLOT API KEY (opsional; kosong = otomatis tanpa key)
    REFRESH_MS: 60000,                     // penyegaran data penuh
    QUOTE_MS: 8000,                        // polling kutipan langsung
    TIMEOUT_MS: 15000
};

const $ = s => document.querySelector(s);
const NF = new Intl.NumberFormat('id-ID');
const state = {
    days: 7,
    show: { online: true, store: true },   // online → Sesi I, store → Sesi II
    paused: false,
    mode: 'loading',                       // 'live' | 'sim' | 'loading'
    loading: false,
    data: [],                              // [{date, dstr, s1, s2, total, close, vol}]
    prev: null,                            // ringkasan periode sebelumnya (riil)
    peers: [],                             // saham bank teraktif (riil)
    sessions: [],                          // komposisi sesi (riil)
    quote: null,                           // kutipan BBCA terakhir (riil)
    index: null,                           // IHSG (riil)
    source: null,
    asOf: null,
    marketOpen: false,
    todayValue: 0,
    todayVol: 0,
    sessionTx: 0,                          // penghitung update kutipan sesi
    txLog: [],                             // log kutipan sesi — ikut diekspor
    lastFeed: { price: null, vol: null }
};

/* ============ util dasar ============ */
function fmtIDR(v) {
    if (v >= 1e12) return 'Rp ' + (v / 1e12).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + ' T';
    if (v >= 1e9) return 'Rp ' + (v / 1e9).toLocaleString('id-ID', { maximumFractionDigits: v < 1e10 ? 1 : 0 }) + ' M';
    if (v >= 1e6) return 'Rp ' + (v / 1e6).toLocaleString('id-ID', { maximumFractionDigits: v < 1e7 ? 1 : 0 }) + ' jt';
    if (v >= 1e3) return 'Rp ' + Math.round(v / 1e3) + ' rb';
    return 'Rp ' + NF.format(Math.round(v));
}
const fmtPrice = v => 'Rp ' + NF.format(Math.round(v));
const fmtInt = v => NF.format(Math.round(v));
function fmtVol(v) {
    if (v >= 1e9) return (v / 1e9).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + ' M';
    if (v >= 1e6) return (v / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' jt';
    if (v >= 1e3) return (v / 1e3).toLocaleString('id-ID', { maximumFractionDigits: 0 }) + ' rb';
    return NF.format(Math.round(v));
}
const fmtPct = (v, dec = 1) => (v == null || !isFinite(v) ? '—' : v.toLocaleString('id-ID', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + '%');

/* angka yang "berjalan" naik/turun dengan easing */
function animateNumber(el, to, fmt, dur = 800) {
    if (!el) return;
    const from = Number(el.dataset.raw || 0);
    el.dataset.raw = to;
    const t0 = performance.now();
    (function frame(t) {
        const p = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(from + (to - from) * e);
        if (p < 1) requestAnimationFrame(frame);
    })(t0);
}

const arrow = up => `<svg width="9" height="9" viewBox="0 0 10 10"><path d="M5 1.5 9 8H1z" fill="currentColor" transform="${up ? '' : 'rotate(180 5 5)'}"/></svg>`;

function setChip(el, pct, label) {
    if (!el) return;
    if (pct == null || !isFinite(pct)) {
        el.innerHTML = `<span class="chip-note">${label || ''}</span>`;
        return;
    }
    const up = pct >= 0;
    el.innerHTML = `<span class="dchip ${up ? 'up' : 'down'}">${arrow(up)} ${Math.abs(pct).toLocaleString('id-ID', { maximumFractionDigits: 1 })}%</span><span class="chip-note">${label}</span>`;
}

function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.classList.add('out'), 2400);
    setTimeout(() => t.remove(), 2850);
}

function niceCeil(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / p;
    const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 3 ? 3 : f <= 4 ? 4 : f <= 5 ? 5 : f <= 6 ? 6 : f <= 8 ? 8 : 10;
    return m * p;
}

function sample(arr, m) {
    if (!arr.length) return arr;
    if (arr.length <= m) return arr;
    const step = arr.length / m, out = [];
    for (let i = 0; i < m; i++) out.push(arr[Math.floor(i * step)]);
    return out;
}

/* ============ lencana status sumber data ============ */
function setBadge(mode, asOf) {
    const b = $('#liveBadge');
    if (!b) return;
    if (mode === 'live') {
        b.className = 'live-badge live';
        b.innerHTML = `<i></i>LIVE · YAHOO FINANCE${asOf ? ' · ' + new Date(asOf).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' WIB' : ''}`;
    } else if (mode === 'sim') {
        b.className = 'live-badge sim';
        b.innerHTML = `<i></i>SIMULASI · API OFFLINE`;
    } else {
        b.className = 'live-badge loading';
        b.innerHTML = `<i></i>MEMUAT DATA PASAR…`;
    }
}

/* ============ chart SVG ============ */
function renderChart() {
    const wrap = $('#chartWrap'), svg = $('#chartSvg');
    if (!wrap || !svg || !state.data.length) return;
    const W = wrap.clientWidth, H = 330;
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const padL = 56, padR = 14, padT = 16, padB = 28;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const d = state.data, n = d.length;

    const vis = d.map(x => ({
        online: state.show.online ? x.s1 : 0,
        store: state.show.store ? x.s2 : 0
    }));
    vis.forEach(v => v.total = v.online + v.store);

    const yMax = niceCeil(Math.max(...vis.map(v => v.total), 1));
    const slot = innerW / n, barW = Math.min(slot * 0.6, 36);
    const y = v => padT + innerH * (1 - v / yMax);
    state.geo = { padL, slot, padT, innerH, yMax, W };

    let s = '';
    for (let k = 0; k <= 4; k++) {
        const vy = padT + innerH * (1 - k / 4);
        s += `<line class="gridline" x1="${padL}" y1="${vy}" x2="${W - padR}" y2="${vy}"/>`;
        s += `<text class="ax" x="${padL - 10}" y="${vy + 3.5}" text-anchor="end">${k ? fmtIDR(yMax * k / 4) : '0'}</text>`;
    }
    const step = Math.max(1, Math.ceil(n / 7));
    for (let i = 0; i < n; i++) {
        if (i % step === 0 || i === n - 1) {
            const lbl = d[i].date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
            s += `<text class="ax" x="${padL + i * slot + slot / 2}" y="${H - 8}" text-anchor="middle">${lbl}</text>`;
        }
    }
    for (let i = 0; i < n; i++) {
        const x = padL + i * slot + (slot - barW) / 2, v = vis[i];
        let g = '';
        if (v.online > 0) {
            const h = v.online / yMax * innerH;
            g += `<rect class="b-on" x="${x.toFixed(1)}" y="${(padT + innerH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, h / 2).toFixed(1)}"/>`;
        }
        if (v.store > 0) {
            const h = v.store / yMax * innerH;
            const yTop = padT + innerH - (state.show.online ? v.online / yMax * innerH : 0) - h;
            g += `<rect class="b-st" x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, h / 2).toFixed(1)}"/>`;
        }
        s += `<g class="bar-g" style="animation-delay:${Math.round(i * 480 / n)}ms">${g}</g>`;
    }
    if (n >= 4) {
        const win = Math.min(7, Math.max(3, Math.round(n / 5)));
        const pts = vis.map((_, i) => {
            const a = vis.slice(Math.max(0, i - win + 1), i + 1);
            const m = a.reduce((s2, v) => s2 + v.total, 0) / a.length;
            return (padL + i * slot + slot / 2).toFixed(1) + ' ' + y(m).toFixed(1);
        });
        s += `<path class="ma-line" d="M${pts.join(' L ')}"/>`;
    }
    s += `<line class="xhair" x1="0" y1="${padT}" x2="0" y2="${padT + innerH}"/>`;
    for (let i = 0; i < n; i++) {
        s += `<rect class="hit" data-i="${i}" x="${(padL + i * slot).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${innerH}" fill="transparent"/>`;
    }
    svg.innerHTML = s;

    svg.querySelectorAll('.hit').forEach(r => {
        r.addEventListener('mouseenter', () => showTip(+r.dataset.i));
        r.addEventListener('mouseleave', hideTip);
    });
}

function showTip(i) {
    const { padL, slot, padT, innerH, yMax, W } = state.geo;
    const d = state.data[i], tip = $('#chartTip'), svg = $('#chartSvg');
    tip.innerHTML =
        `<div class="tt-date">${d.date.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' })}</div>` +
        `<div class="tt-row"><i class="sw on"></i>Sesi I<b>${fmtIDR(d.s1)}</b></div>` +
        `<div class="tt-row"><i class="sw st"></i>Sesi II<b>${fmtIDR(d.s2)}</b></div>` +
        `<div class="tt-row"><i class="sw px" style="background:#a56d25"></i>Penutupan<b>${fmtPrice(d.close)}</b></div>` +
        `<div class="tt-total">Total · ${fmtIDR(d.total)}</div>`;
    const cx = padL + i * slot + slot / 2;
    const top = padT + innerH * (1 - d.total / yMax);
    tip.style.left = Math.max(95, Math.min(W - 95, cx)) + 'px';
    if (top < 120) {
        tip.style.top = (top + 14) + 'px';
        tip.classList.add('below');
    } else {
        tip.style.top = (top - 8) + 'px';
        tip.classList.remove('below');
    }
    tip.classList.add('show');
    const xh = svg.querySelector('.xhair');
    xh.setAttribute('x1', cx);
    xh.setAttribute('x2', cx);
    xh.style.opacity = 1;
    svg.querySelectorAll('.bar-g').forEach((g, j) => g.style.opacity = j === i ? 1 : 0.35);
}

function hideTip() {
    $('#chartTip').classList.remove('show');
    const svg = $('#chartSvg');
    svg.querySelector('.xhair').style.opacity = 0;
    svg.querySelectorAll('.bar-g').forEach(g => g.style.opacity = '');
}

/* ============ KPI & sparkline ============ */
function sparkline(el, arr, color) {
    if (!el || !arr.length) return;
    const w = 90, h = 30, min = Math.min(...arr), max = Math.max(...arr), r = (max - min) || 1;
    const pts = arr.map((v, i) =>
        `${(arr.length > 1 ? i / (arr.length - 1) : 1) * w},${(h - 3 - (v - min) / r * (h - 6)).toFixed(1)}`).join(' ');
    el.innerHTML = `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`;
}

state.kpi = {};

function updateKPIs() {
    const d = state.data;
    if (!d.length) return;
    const rev = d.reduce((a, x) => a + x.total, 0);
    const vol = d.reduce((a, x) => a + x.vol, 0);
    const closeLast = d[d.length - 1].close;
    const s1 = d.reduce((a, x) => a + x.s1, 0);
    const s1Share = rev > 0 ? s1 / rev * 100 : 0;
    const p = state.prev;
    const dRev = p && p.total > 0 ? (rev - p.total) / p.total * 100 : null;
    const dOrd = p && p.vol > 0 ? (vol - p.vol) / p.vol * 100 : null;
    const dAov = p && p.closeLast > 0 ? (closeLast - p.closeLast) / p.closeLast * 100 : null;
    const pShare = p && p.total > 0 ? p.s1 / p.total * 100 : null;
    const dCnv = pShare != null ? s1Share - pShare : null;

    state.kpi = { rev: Math.round(rev), orders: Math.round(vol), aov: Math.round(closeLast), conv: +s1Share.toFixed(1), dRev, dOrd, dAov, dCnv };

    animateNumber($('#kRev'), rev, fmtIDR, 1000);
    animateNumber($('#kOrd'), vol, fmtInt, 1000);
    animateNumber($('#kAov'), closeLast, fmtPrice, 1000);
    animateNumber($('#kCnv'), s1Share, v => fmtPct(v), 1000);

    setChip($('#dRev'), dRev, 'vs periode lalu');
    setChip($('#dOrd'), dOrd, 'vs periode lalu');
    setChip($('#dAov'), dAov, 'vs periode lalu');
    setChip($('#dCnv'), dCnv, 'poin vs periode lalu');

    sparkline($('#spRev'), sample(d.map(x => x.total), 24), '#D14A1E');
    sparkline($('#spOrd'), sample(d.map(x => x.vol), 24), '#1C1712');
    sparkline($('#spAov'), sample(d.map(x => x.close), 24), '#1C1712');
    sparkline($('#spCnv'), sample(d.map(x => x.total > 0 ? x.s1 / x.total * 100 : 0), 24), '#1C1712');
}

/* ============ hero (kutipan BBCA langsung) ============ */
function updateHero() {
    const d = state.data;
    if (!d.length || !state.quote) return;
    const q = state.quote;
    const last = d[d.length - 1];

    state.todayValue = q.dayValue || last.total;
    state.todayVol = q.dayVolume || last.vol;

    animateNumber($('#revToday'), q.price, fmtPrice, 900);
    setChip($('#heroDelta'), q.changePct, 'vs kemarin');
    $('#ordToday').textContent = fmtInt(state.todayVol);
    $('#sessTx').textContent = state.sessionTx;

    const peak = d.reduce((a, x) => x.total > a.total ? x : a, d[0]);
    $('#peakDay').innerHTML = `${fmtIDR(peak.total)}<span class="peak-date">${peak.date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}</span>`;
}

/* ============ saham bank teraktif (ex-produk) ============ */
function renderPeers() {
    if (!state.peers.length) return;
    const max = state.peers[0].value || 1;
    $('#prodList').innerHTML = state.peers.map((p, i) => `
<div class="prod-row">
  <div class="prod-top">
    <span class="prod-name"><b class="rank">${String(i + 1).padStart(2, '0')}</b>${p.code} <span class="peer-name">${p.name}</span></span>
    <span class="mono prod-val">${fmtIDR(p.value)}</span>
  </div>
  <div class="prod-meta">
    <span>${fmtVol(p.vol)} lembar · Porsi ${p.share.toLocaleString('id-ID', { maximumFractionDigits: 1 })}%</span>
    <span class="dchip ${p.changePct >= 0 ? 'up' : 'down'}">${arrow(p.changePct >= 0)} ${Math.abs(p.changePct).toLocaleString('id-ID', { maximumFractionDigits: 1 })}%</span>
  </div>
  <div class="track"><i style="width:${(p.value / max * 100).toFixed(1)}%"></i></div>
</div>`).join('');
}

/* ============ komposisi sesi (ex-wilayah) ============ */
function renderSessions() {
    const s1 = state.data.reduce((a, x) => a + x.s1, 0);
    const s2 = state.data.reduce((a, x) => a + x.s2, 0);
    const tot = s1 + s2;
    if (!tot) return;
    const p = state.prev;
    const pTot = p ? p.s1 + p.s2 : 0;
    const rows = [
        { name: 'Sesi I · 09.00–12.00', pct: s1 / tot * 100, rev: s1, delta: p && pTot > 0 ? s1 / tot * 100 - p.s1 / pTot * 100 : null },
        { name: 'Sesi II · 13.30–16.00', pct: s2 / tot * 100, rev: s2, delta: p && pTot > 0 ? s2 / tot * 100 - p.s2 / pTot * 100 : null }
    ];
    state.sessions = rows.map(r => ({ name: r.name, pct: r.pct, rev: Math.round(r.rev), delta: r.delta || 0 }));
    $('#regionList').innerHTML = rows.map(r => `
<div class="reg-row">
  <div class="reg-top">
    <span class="reg-name">${r.name}</span><i class="lead"></i>
    <span class="mono reg-pct">${r.pct.toLocaleString('id-ID', { maximumFractionDigits: 1 })}%</span>
  </div>
  <div class="reg-sub">
    <span>${fmtIDR(r.rev)}</span>
    ${r.delta == null ? `<span class="chip-note">periode awal</span>` : `<span class="dchip ${r.delta >= 0 ? 'up' : 'down'}">${arrow(r.delta >= 0)} ${Math.abs(r.delta).toLocaleString('id-ID', { maximumFractionDigits: 1 })} pp</span>`}
  </div>
</div>`).join('');
}

/* ============ ticker (pergerakan riil) ============ */
function buildTicker() {
    let items = [];
    if (state.quote) {
        const q = state.quote, up = (q.changePct ?? 0) >= 0;
        items.push(`<span class="tk ${up ? 'up' : 'down'}">${arrow(up)} BBCA ${up ? '+' : '−'}${Math.abs(q.changePct ?? 0).toLocaleString('id-ID', { maximumFractionDigits: 2 })}% · ${fmtPrice(q.price)}</span>`);
        if (state.index) {
            const iUp = (state.index.dayChangePct ?? 0) >= 0;
            items.push(`<span class="tk ${iUp ? 'up' : 'down'}">${arrow(iUp)} IHSG ${iUp ? '+' : '−'}${Math.abs(state.index.dayChangePct ?? 0).toLocaleString('id-ID', { maximumFractionDigits: 2 })}%</span>`);
        }
        (state.peers || []).forEach(p => {
            if (p.code === 'BBCA') return;
            const u = (p.dayChangePct ?? 0) >= 0;
            items.push(`<span class="tk ${u ? 'up' : 'down'}">${arrow(u)} ${p.code} ${u ? '+' : '−'}${Math.abs(p.dayChangePct ?? 0).toLocaleString('id-ID', { maximumFractionDigits: 2 })}%</span>`);
        });
        items.push(`<span class="tk ${state.marketOpen ? 'up' : ''}">${state.marketOpen ? 'PASAR BUKA' : 'PASAR TUTUP'}</span>`);
        items.push(`<span class="tk">SUMBER: YAHOO FINANCE · SEGAR ${API.REFRESH_MS / 1000} D</span>`);
    } else {
        items = ['MENUNGGU DATA PASAR…', 'SUMBER: YAHOO FINANCE'];
    }
    const half = `<div class="tk-half">${items.join('')}</div>`;
    $('#tickerTrack').innerHTML = half + half;
}

/* ============ feed kutipan langsung ============ */
const icoPause = '<svg width="11" height="11" viewBox="0 0 12 12"><rect x="2" y="1.5" width="3" height="9" rx="1" fill="currentColor"/><rect x="7" y="1.5" width="3" height="9" rx="1" fill="currentColor"/></svg>';
const icoPlay = '<svg width="11" height="11" viewBox="0 0 12 12"><path d="M3 1.8v8.4c0 .8.9 1.3 1.6.9l6.6-4.2c.6-.4.6-1.4 0-1.8L4.6.9C3.9.5 3 1 3 1.8z" fill="currentColor"/></svg>';

function feedRow(timeText, titleText, metaText, valText) {
    const li = document.createElement('div');
    li.className = 'feed-row new';
    li.innerHTML =
        `<span class="f-time mono">${timeText}</span>` +
        `<span class="f-main"><span class="f-name">${titleText}</span>` +
        `<span class="f-meta mono">${metaText}</span></span>` +
        `<span class="f-val mono">${valText}</span>`;
    const list = $('#feedList');
    list.prepend(li);
    while (list.children.length > 9) list.lastElementChild.remove();
}

/* seed awal: bar intrahari riil dari API */
function seedFeed(bars) {
    const list = $('#feedList');
    if (list) list.innerHTML = '';
    (bars || []).slice(-9).reverse().forEach(b => {
        const t = new Date();
        state.txLog.push({ time: new Date().toISOString(), product: API.SYMBOL, city: 'IDX RG', channel: 'Bar intrahari', qty: Math.round(b.v), value: b.c });
        feedRow(b.t + ' WIB', `BBCA ${fmtPrice(b.c)}`, `vol ${fmtVol(b.v)} lembar`, fmtPrice(b.c));
    });
}

/* satu kutipan dari polling API */
function pushQuoteRow(q) {
    const now = new Date();
    const time = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const up = (q.changePct ?? 0) >= 0;
    const sesi = state.marketOpen ? (now.getHours() < 13 ? 'Sesi I' : 'Sesi II') : 'Pasar tutup';
    state.txLog.push({
        time: now.toISOString(),
        product: API.SYMBOL,
        city: 'IDX RG',
        channel: state.marketOpen ? 'Live' : 'Tutup',
        qty: Math.round(q.dayVolume || 0),
        value: q.price
    });
    feedRow(time, `BBCA <span class="dchip ${up ? 'up' : 'down'}">${arrow(up)} ${fmtPct(q.changePct, 2)}</span>`,
        `${sesi} · vol ${fmtVol(q.dayVolume || 0)} lembar · nilai ${fmtIDR(q.dayValue || 0)}`, fmtPrice(q.price));
}

function pollQuote() {
    if (state.paused || state.mode === 'loading') return;
    fetchWithTimeout(`${API.URL}?quote=1${API.KEY ? '&apiKey=' + encodeURIComponent(API.KEY) : ''}`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
        .then(p => {
            if (!p.ok || !p.quote) return;
            state.quote = { ...state.quote, ...p.quote };
            state.marketOpen = !!p.quote.marketOpen;
            state.asOf = p.asOf;
            if (state.lastFeed.price !== p.quote.price || state.lastFeed.vol !== p.quote.dayVolume) {
                state.lastFeed = { price: p.quote.price, vol: p.quote.dayVolume };
                pushQuoteRow(p.quote);
                state.sessionTx++;
            }
            updateHero();
            setBadge(state.mode, state.asOf);
        })
        .catch(() => { /* poll gagal → tunggu siklus berikutnya */ });
}

function fetchWithTimeout(url, opts = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), API.TIMEOUT_MS);
    return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}

/* ============ pemuat data live (LINK API diterapkan di sini) ============ */
async function loadLive(days, opts = {}) {
    if (state.loading) return;
    state.loading = true;
    setBadge(state.mode === 'sim' ? 'sim' : 'loading');
    try {
        const url = `${API.URL}?days=${days}${API.KEY ? '&apiKey=' + encodeURIComponent(API.KEY) : ''}`;
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const p = await res.json();
        if (!p.ok || !p.days || !p.days.length) throw new Error(p.detail || 'payload tidak valid');

        state.mode = 'live';
        state.source = p.source;
        state.asOf = p.asOf;
        state.marketOpen = !!p.marketOpen;
        state.quote = { ...p.quote, longName: p.longName };
        state.index = p.index || null;
        state.prev = p.prev || null;
        state.data = p.days.map(x => ({
            date: new Date(x.d + 'T00:00:00+07:00'),
            dstr: x.d,
            s1: x.s1,
            s2: x.s2,
            total: x.total,
            close: x.close,
            vol: x.vol
        }));
        state.peers = p.peers || [];

        buildTicker();
        updateKPIs();
        renderChart();
        updateHero();
        renderPeers();
        renderSessions();
        if (opts.seedFeed !== false) seedFeed(p.todayBars);

        setBadge('live', state.asOf);
        if (opts.toast) toast(opts.toast);
        if (opts.first) toast('Data LIVE dari Yahoo Finance — ' + (p.longName || 'BBCA') + ' & saham bank');
    } catch (e) {
        if (!state.data.length) {
            startFallback();
        } else {
            toast('API gagal (' + (e.message || 'jaringan') + ') — memakai data terakhir');
            setBadge(state.mode, state.asOf);
        }
    } finally {
        state.loading = false;
    }
}

/* ============ MODE SIMULASI (fallback bila API offline) ============ */
function mulberry32(a) {
    return function() {
        a |= 0;
        a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
}

function startFallback() {
    state.mode = 'sim';
    const rng = mulberry32(Math.floor(Math.random() * 1e9));
    const n = state.days, now = Date.now(), out = [];
    for (let i = 0; i < n; i++) {
        const trend = 1 + 0.3 * i / Math.max(n - 1, 1);
        const s1 = 300e9 * trend * (0.8 + rng() * 0.4);
        const s2 = 180e9 * trend * (0.8 + rng() * 0.4);
        const close = 5200 + (rng() - 0.5) * 260;
        out.push({
            date: new Date(now - (n - 1 - i) * 864e5),
            dstr: new Date(now - (n - 1 - i) * 864e5).toISOString().slice(0, 10),
            s1, s2, total: s1 + s2, close, vol: Math.round((s1 + s2) / close)
        });
    }
    state.data = out;
    state.quote = { price: out[out.length - 1].close, changePct: 0, dayValue: out[out.length - 1].total, dayVolume: out[out.length - 1].vol, previousClose: out[out.length - 2]?.close || out[out.length - 1].close };
    state.prev = null;
    state.index = null;
    state.peers = [
        ['BBCA', 'Bank Central Asia'], ['BBRI', 'Bank Rakyat Indonesia'], ['BMRI', 'Bank Mandiri'],
        ['BBNI', 'Bank Negara Indonesia'], ['BRIS', 'Bank Syariah Indonesia'], ['ARTO', 'Bank Jago']
    ].map(([code, name]) => {
        const value = 200e9 + rng() * 300e9;
        return { code, name, value: Math.round(value), vol: Math.round(value / 5000), closeLast: 4000 + rng() * 2000, changePct: rng() * 10 - 3, dayChangePct: rng() * 3 - 1, share: 0 };
    }).sort((a, b) => b.value - a.value);
    const t = state.peers.reduce((a, p) => a + p.value, 0);
    state.peers.forEach(p => p.share = p.value / t * 100);

    buildTicker();
    updateKPIs();
    renderChart();
    updateHero();
    renderPeers();
    renderSessions();
    seedFeed([]);
    setBadge('sim');
    toast('API tidak terjangkau — beralih ke MODE SIMULASI');
}

/* ============ ekspor ============ */
function exportFileName(ext) {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const dd = p(d.getDate()), mm = p(d.getMonth() + 1), yy = String(d.getFullYear()).slice(2);
    const hh = p(d.getHours()), mi = p(d.getMinutes()), ss = p(d.getSeconds());
    return `BCA_IDX_${dd}-${mm}-${yy}_${hh}-${mi}-${ss}.${ext}`;
}

function triggerDownload(blob, fname) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const exportWrap = $('#exportWrap'), exportMenu = $('#exportMenu');

function setMenu(open) {
    exportMenu.hidden = !open;
    exportWrap.classList.toggle('open', open);
    $('#exportBtn').setAttribute('aria-expanded', String(open));
}
$('#exportBtn').addEventListener('click', e => {
    e.stopPropagation();
    setMenu(exportMenu.hidden);
});
document.addEventListener('click', e => {
    if (!exportMenu.hidden && !exportWrap.contains(e.target)) setMenu(false);
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !exportMenu.hidden) setMenu(false);
});
$('#optCsv').addEventListener('click', () => {
    setMenu(false);
    exportCSV();
});
$('#optXlsx').addEventListener('click', () => {
    setMenu(false);
    exportXLSX();
});

/* ============ kontrol periode, legend, pause, jam ============ */
document.querySelectorAll('.seg button').forEach(b => {
    b.addEventListener('click', () => {
        if (state.days === +b.dataset.d) return;
        document.querySelectorAll('.seg button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.days = +b.dataset.d;
        loadLive(state.days, { toast: `Periode ${state.days} hari bursa dimuat`, seedFeed: false });
    });
});

document.querySelectorAll('.lg[data-s]').forEach(b => {
    b.addEventListener('click', () => {
        const k = b.dataset.s;
        if (state.show[k] && (!state.show.online || !state.show.store) &&
            ((k === 'online' && !state.show.store) || (k === 'store' && !state.show.online))) return;
        state.show[k] = !state.show[k];
        b.classList.toggle('active', state.show[k]);
        renderChart();
    });
});

$('#pauseBtn').addEventListener('click', () => {
    state.paused = !state.paused;
    $('#pauseBtn').innerHTML = (state.paused ? icoPlay + '<span>Lanjut</span>' : icoPause + '<span>Jeda</span>');
    toast(state.paused ? 'Kutipan langsung dijeda' : 'Kutipan langsung dilanjutkan');
});

function tickClock() {
    const n = new Date();
    $('#clockDate').textContent = n.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    $('#clockTime').textContent = n.toLocaleTimeString('id-ID', { hour12: false });
}

/* ============ boot ============ */
let rz;
window.addEventListener('resize', () => {
    clearTimeout(rz);
    rz = setTimeout(renderChart, 150);
});

tickClock();
setInterval(tickClock, 1000);
$('#pauseBtn').innerHTML = icoPause + '<span>Jeda</span>';
setBadge('loading');
buildTicker();

/* jemput data live — link API diterapkan otomatis di loadLive() */
loadLive(state.days, { first: true, toast: '' });
setInterval(pollQuote, API.QUOTE_MS);
setInterval(() => {
    if (!document.hidden) loadLive(state.days, { seedFeed: false });
}, API.REFRESH_MS);
