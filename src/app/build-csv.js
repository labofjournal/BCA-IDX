/* ================================================================
   build-csv.js — modul ekspor CSV (rapi & konsisten)
   ----------------------------------------------------------------
   Prinsip:
     · Pemisah field : ";"   (aman untuk Excel locale Indonesia)
     · Encoding      : UTF-8 + BOM (agar Excel ID tidak salah baca)
     · Line ending   : CRLF
     · Angka uang    : murni (tanpa pemisah ribuan)
   Dipakai oleh main.js lewat tombol "Download (CSV/XLSX)".
   Membutuhkan (runtime): state, exportFileName, triggerDownload, toast
   ================================================================ */

/* Escape satu field CSV */
function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[";\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/* Gabungkan array jadi satu baris CSV */
function csvRow(arr) {
  return arr.map(csvField).join(';');
}

const CSV_BLANK = '';

/* ============ EKSPOR CSV ============ */
function exportCSV() {
  const now = new Date();
  const num = v => Math.round(v);
  const pct = v => (Math.round(v * 100) / 100).toString().replace('.', ',');
  const sumber = state.mode === 'live'
    ? 'Data LIVE — Yahoo Finance (v8 chart, tanpa API key)'
    : 'Data SIMULASI (API offline saat ekspor)';

  const L = [];

  /* ---------- Metadata ---------- */
  L.push(csvRow([ 'BCA IDX — LIVE MARKET CONSOLE' ]));
  L.push(csvRow([ 'Sumber', sumber ]));
  L.push(csvRow([ 'Simbol utama', state.quote ? API.SYMBOL : '-' ]));
  L.push(csvRow([ 'Diekspor', now.toLocaleString('id-ID') ]));
  L.push(csvRow([ 'Periode', `${state.days} hari bursa terakhir` ]));
  L.push(CSV_BLANK);

  /* ---------- 1. Ringkasan ---------- */
  L.push(csvRow([ '1. RINGKASAN PERIODE' ]));
  L.push(csvRow([ 'Indikator', 'Nilai', 'Delta (%)' ]));
  L.push(csvRow([ 'Nilai transaksi periode (Rp)', num(state.kpi.rev), pct(state.kpi.dRev) ]));
  L.push(csvRow([ 'Total volume (lembar)', num(state.kpi.orders), pct(state.kpi.dOrd) ]));
  L.push(csvRow([ 'Harga penutupan terakhir (Rp)', num(state.kpi.aov), pct(state.kpi.dAov) ]));
  L.push(csvRow([ 'Porsi Sesi I (%)', pct(state.kpi.conv), pct(state.kpi.dCnv) ]));
  L.push(csvRow([ 'Nilai transaksi terakhir — live (Rp)', num(state.todayValue), '' ]));
  L.push(csvRow([ 'Volume terakhir — live (lembar)', num(state.todayVol), '' ]));
  L.push(csvRow([ 'Update kutipan sesi ini', num(state.sessionTx), '' ]));
  L.push(CSV_BLANK);

  /* ---------- 2. Nilai Transaksi Harian ---------- */
  L.push(csvRow([ '2. NILAI TRANSAKSI HARIAN (estimasi harga × volume)' ]));
  L.push(csvRow([ 'No', 'Tanggal', 'Sesi I (Rp)', 'Sesi II (Rp)', 'Total (Rp)', 'Penutupan (Rp)', 'Volume (lembar)' ]));
  let sumS1 = 0, sumS2 = 0, sumTot = 0;
  state.data.forEach((d, i) => {
    const s1 = num(d.s1), s2 = num(d.s2), t = num(d.total);
    sumS1 += s1; sumS2 += s2; sumTot += t;
    L.push(csvRow([ i + 1, d.dstr || d.date.toISOString().slice(0, 10), s1, s2, t, num(d.close), num(d.vol) ]));
  });
  L.push(csvRow([ '', 'TOTAL', sumS1, sumS2, sumTot, '', '' ]));
  L.push(CSV_BLANK);

  /* ---------- 3. Saham Bank Teraktif ---------- */
  L.push(csvRow([ '3. SAHAM BANK TERAKTIF' ]));
  L.push(csvRow([ 'Peringkat', 'Kode', 'Nama', 'Nilai Transaksi (Rp)', 'Volume (lembar)', 'Porsi (%)', 'Perubahan Periode (%)' ]));
  state.peers.forEach((p, i) => {
    L.push(csvRow([ i + 1, p.code, p.name, num(p.value), num(p.vol), pct(p.share), pct(p.changePct) ]));
  });
  L.push(CSV_BLANK);

  /* ---------- 4. Komposisi Sesi ---------- */
  L.push(csvRow([ '4. KOMPOSISI SESI' ]));
  L.push(csvRow([ 'Sesi', 'Porsi (%)', 'Nilai (Rp)', 'Delta (poin persentase)' ]));
  state.sessions.forEach(r => {
    L.push(csvRow([ r.name, pct(r.pct), num(r.rev), pct(r.delta) ]));
  });
  L.push(CSV_BLANK);

  /* ---------- 5. Kutipan Sesi ---------- */
  L.push(csvRow([ '5. KUTIPAN SESI (FEED LANGSUNG)' ]));
  L.push(csvRow([ 'No', 'Waktu', 'Simbol', 'Pasar', 'Kanal', 'Volume (lembar)', 'Harga (Rp)' ]));
  let sumTx = 0;
  state.txLog.forEach((t, i) => {
    sumTx += t.value;
    L.push(csvRow([ i + 1, t.time, t.product, t.city, t.channel, num(t.qty), num(t.value) ]));
  });
  L.push(csvRow([ '', 'TOTAL', '', '', '', '', num(sumTx) ]));

  /* ---------- Tulis file ---------- */
  const fname = exportFileName('csv');
  triggerDownload(new Blob([ '\uFEFF' + L.join('\r\n') ], { type: 'text/csv;charset=utf-8' }), fname);
  toast(`Terunduh: ${fname}`);
}
