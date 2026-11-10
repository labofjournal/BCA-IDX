# BCA IDX — Live Market Console

Dashboard **BCA IDX** versi **ONLINE**: seluruh angka kini dijemput **langsung
dari API pasar** (Yahoo Finance — publik, **tanpa API key**) melalui endpoint
server `/api/market`. Tidak ada lagi simulasi sebagai sumber utama — simulasi
hanya menjadi *fallback* bila API tidak terjangkau (lencana merah
"SIMULASI · API OFFLINE").

> **Data yang ditampilkan (semuanya riil):**
> - **BBCA.JK** (PT Bank Central Asia Tbk) — harga terkini, volume, nilai transaksi
> - Pemisahan per **Sesi I (09.00–12.00 WIB)** dan **Sesi II (13.30–16.00 WIB)**
> - **Saham bank teraktif**: BBCA, BBRI, BMRI, BBNI, BRIS, BBTN, ARTO
> - **IHSG** (IDX Composite) pada ticker

Nilai transaksi harian = **estimasi harga × volume** (konvensi pasar yang umum).

---

## LINK API — diterapkan langsung & otomatis

Sudah **tertanam langsung di dalam kode**, tanpa registrasi dan tanpa key:

| Lokasi | Isi |
| --- | --- |
| `src/app/main.js` → blok `API` di baris atas | `URL: '/api/market'`, `SOURCE_URL: https://query1.finance.yahoo.com/v8/finance/chart/BBCA.JK?range=1y&interval=1h` |
| `api/market/route.ts` → konstanta `Y1`, `Y2` | Host Yahoo Finance utama + fallback otomatis (query1 ⇄ query2, retry 429) |

Slot **`API.KEY`** di `main.js` disediakan untuk provider berbayar (opsional) —
bila diisi, otomatis dilekatkan pada setiap request.

## Endpoint

```
GET /api/market?days=7|30|90    → payload lengkap (chart, KPI, peers, sesi, IHSG)
GET /api/market?quote=1         → kutipan ringan untuk polling tiap 8 detik
```

- Cache in-memory di server: data utama 60 d, peers/IHSG 10 mnt → hemat kuota.
- Periode = **hari bursa** (bukan hari kalender; akhir pean otomatis terlewat).
- Penyegaran otomatis: kutipan tiap **8 d**, data penuh tiap **60 d**.

## Struktur Proyek

```
├── index.html            # Halaman dashboard (label sudah LIVE)
├── logo/icon_web.svg     # Logo & favicon
├── src/
│   ├── styles.css        # Gaya asli + lencana LIVE/SIMULASI
│   └── app/
│       ├── main.js       # ★ Di-online-kan: fetch API, polling, fallback
│       ├── build-csv.js  # Ekspor CSV (mengikuti data live)
│       └── build-excel.js# Ekspor XLSX 5 sheet + 3 chart native
└── api/market/route.ts   # ★ API route server → Yahoo Finance
```

## Menjalankan / Hosting

Butuh **hosting yang bisa menjalankan server Node/Next.js** (route API harus hidup):

```bash
# letakkan index.html, logo/, src/ di folder public/ Next.js
# dan api/market/route.ts di src/app/api/market/route.ts
npm run dev      # atau deploy ke Vercel / Netlify (dengan runtime Next.js)
```

> ⚠️ **GitHub Pages statis tidak bisa** menjalankan `/api/market` — bila file
> ini di-host statis, dashboard otomatis jatuh ke MODE SIMULASI (aman, tidak
> error). Untuk data live, gunakan Vercel / Railway / VPS dengan Next.js.

Browser tidak dapat memanggil Yahoo Finance langsung (CORS), karena itu proxy
server ini wajib ada.

## Perubahan vs Versi Sebelumnya

| Panel | Sebelumnya (simulasi) | Sekarang (live) |
| --- | --- | --- |
| 01 Chart | Pendapatan Online/Toko fiktif | Nilai transaksi harian BBCA per Sesi I/II |
| Hero | "Pendapatan hari ini" | Harga BBCA terkini + volume riil |
| 02 KPI | Revenue/pesanan/AOV/konversi | Nilai periode, volume, penutupan, porsi Sesi I |
| 03 | Produk terlaris fiktif | Saham bank teraktif riil (7 emiten) |
| 04 | Wilayah fiktif | Komposisi Sesi I vs II |
| 05 | Feed transaksi fiktif | Kutipan langsung polling 8 d + bar intrahari riil |
| Ekspor | Data simulasi | Data live + sumber tercantum di file |

## Fitur yang Dipertahankan

- Grafik SVG buatan sendiri dengan tooltip *hover* & garis rata-rata
- Sakelar periode **7H / 30H / 90H** (hari bursa)
- Ekspor **CSV** (`;` + UTF-8 BOM, aman Excel Indonesia) dan **XLSX**
  (5 sheet, 3 chart native Excel, dibangun manual tanpa library)
- Jam real-time, ticker berjalan, tombol jeda pada feed kutipan
