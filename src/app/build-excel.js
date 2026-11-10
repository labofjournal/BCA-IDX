/* ================================================================
   build-excel.js — modul pembangun file XLSX (.xlsx)
   Berisi: CRC32, ZIP (STORE), XML worksheet, chart native Excel,
           dan fungsi utama exportXLSX().
   Dipakai oleh main.js lewat tombol "Download (CSV/XLSX)".
   Membutuhkan variabel/global dari main.js (dipanggil saat runtime):
     - state          (data live/simulasi yang akan diekspor)
     - API            (konfigurasi sumber data)
     - exportFileName (nama file dd-mm-yy_hh-mm-ss)
     - triggerDownload(blob, filename)
     - toast(msg)
   ================================================================ */

/* ============ CRC32 ============ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[ n ] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[ (c ^ u8[ i ]) & 0xFF ] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ============ ZIP metode STORE ============ */
function makeZip(entries) {
  const enc = new TextEncoder();
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0;

  for (const f of entries) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data), size = data.length;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint16(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);

    offset += 30 + name.length + size;
  }

  let cSize = 0;
  central.forEach(c => cSize += c.length);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cSize, true);
  eocd.setUint32(16, offset, true);
  parts.push(...central, new Uint8Array(eocd.buffer));

  return new Blob(parts, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/* ============ XML helpers ============ */
const xmlEsc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ c ]));
function colLetter(n) {
  let s = ''; n++;
  while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/* ============ worksheet XML: border + autofit kolom & row ============ */
function sheetXML(rows, opts = {}) {
  const ncol = Math.max(...rows.map(r => r.length));
  const rowStyles = opts.rowStyles || [];

  const widths = [];
  for (let c = 0; c < ncol; c++) {
    let mx = 10;
    rows.forEach(r => {
      const v = r[ c ];
      if (v !== null && v !== undefined && v !== '') mx = Math.max(mx, String(v).length + 2);
    });
    widths.push(Math.min(mx, 40));
  }
  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;

  let body = '';
  rows.forEach((row, ri) => {
    const style = rowStyles[ ri ] || 'body';
    let rowAttrs = `r="${ri + 1}"`;
    if (style === 'title') rowAttrs += ' ht="26" customHeight="1"';
    else if (style === 'header') rowAttrs += ' ht="22" customHeight="1"';
    else if (style === 'info') rowAttrs += ' ht="18" customHeight="1"';

    let cells = '';
    row.forEach((cell, ci) => {
      if (cell === null || cell === undefined || cell === '') return;
      const ref = colLetter(ci) + (ri + 1);
      let s;
      if (style === 'title') s = 1;
      else if (style === 'info') s = 2;
      else if (style === 'header') s = 3;
      else if (typeof cell === 'number' && isFinite(cell)) s = Number.isInteger(cell) ? 5 : 6;
      else s = 4;

      if (typeof cell === 'number' && isFinite(cell)) {
        cells += `<c r="${ref}" s="${s}"><v>${cell}</v></c>`;
      } else {
        cells += `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(cell)}</t></is></c>`;
      }
    });
    body += `<row ${rowAttrs}>${cells}</row>`;
  });

  const drawing = opts.drawingRel ? `<drawing r:id="rId1"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${cols}<sheetData>${body}</sheetData>${drawing}</worksheet>`;
}

/* ============ builder chart XML (native Excel) ============ */
function chartCatCache(values) {
  return `<c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlEsc(v)}</c:v></c:pt>`).join('')}</c:strCache>`;
}
function chartNumCache(values) {
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${Number(v).toFixed(0)}</c:v></c:pt>`).join('')}</c:numCache>`;
}

function buildBarChartXML(cats, s1Vals, s2Vals) {
  const sh = `'Nilai Transaksi Harian'`;
  const lastRow = 1 + cats.length;
  const catRef = `${sh}!$A$2:$A$${lastRow}`;
  const onRef = `${sh}!$B$2:$B$${lastRow}`;
  const stRef = `${sh}!$C$2:$C$${lastRow}`;
  const catCache = chartCatCache(cats);
  const onCache = chartNumCache(s1Vals);
  const stCache = chartNumCache(s2Vals);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title>
      <c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="id-ID" sz="1200" b="1"/><a:t>Nilai Transaksi Harian — Sesi I vs Sesi II</a:t></a:r></a:p></c:rich></c:tx>
      <c:overlay val="0"/>
    </c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="stacked"/>
        <c:varyColors val="0"/>
        <c:ser>
          <c:idx val="0"/>
          <c:order val="0"/>
          <c:tx><c:strRef><c:f>${sh}!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Sesi I (Rp)</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:spPr><a:solidFill><a:srgbClr val="D14A1E"/></a:solidFill></c:spPr>
          <c:cat><c:strRef><c:f>${catRef}</c:f>${catCache}</c:strRef></c:cat>
          <c:val><c:numRef><c:f>${onRef}</c:f>${onCache}</c:numRef></c:val>
        </c:ser>
        <c:ser>
          <c:idx val="1"/>
          <c:order val="1"/>
          <c:tx><c:strRef><c:f>${sh}!$C$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Sesi II (Rp)</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:spPr><a:solidFill><a:srgbClr val="1C1712"/></a:solidFill></c:spPr>
          <c:cat><c:strRef><c:f>${catRef}</c:f>${catCache}</c:strRef></c:cat>
          <c:val><c:numRef><c:f>${stRef}</c:f>${stCache}</c:numRef></c:val>
        </c:ser>
        <c:gapWidth val="60"/>
        <c:axId val="100000001"/>
        <c:axId val="100000002"/>
      </c:barChart>
      <c:catAx>
        <c:axId val="100000001"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="b"/>
        <c:crossAx val="100000002"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="100000002"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="l"/>
        <c:crossAx val="100000001"/>
        <c:numFmt formatCode="#,##0" sourceLinked="1"/>
      </c:valAx>
    </c:plotArea>
    <c:plotVisOnly val="1"/>
    <c:dispBlanksAs val="gap"/>
  </c:chart>
</c:chartSpace>`;
}

function buildLineChartXML(cats, totalVals) {
  const sh = `'Nilai Transaksi Harian'`;
  const lastRow = 1 + cats.length;
  const catRef = `${sh}!$A$2:$A$${lastRow}`;
  const totRef = `${sh}!$D$2:$D$${lastRow}`;
  const catCache = chartCatCache(cats);
  const totCache = chartNumCache(totalVals);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title>
      <c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="id-ID" sz="1200" b="1"/><a:t>Tren Total Nilai Transaksi</a:t></a:r></a:p></c:rich></c:tx>
      <c:overlay val="0"/>
    </c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:lineChart>
        <c:grouping val="standard"/>
        <c:varyColors val="0"/>
        <c:ser>
          <c:idx val="0"/>
          <c:order val="0"/>
          <c:tx><c:strRef><c:f>${sh}!$D$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Total (Rp)</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="D14A1E"/></a:solidFill></a:ln></c:spPr>
          <c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>
          <c:cat><c:strRef><c:f>${catRef}</c:f>${catCache}</c:strRef></c:cat>
          <c:val><c:numRef><c:f>${totRef}</c:f>${totCache}</c:numRef></c:val>
          <c:smooth val="0"/>
        </c:ser>
        <c:marker val="1"/>
        <c:axId val="200000001"/>
        <c:axId val="200000002"/>
      </c:lineChart>
      <c:catAx>
        <c:axId val="200000001"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="b"/>
        <c:crossAx val="200000002"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="200000002"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="l"/>
        <c:crossAx val="200000001"/>
        <c:numFmt formatCode="#,##0" sourceLinked="1"/>
      </c:valAx>
    </c:plotArea>
    <c:plotVisOnly val="1"/>
    <c:dispBlanksAs val="gap"/>
  </c:chart>
</c:chartSpace>`;
}

function buildPieChartXML(sessionNames, sessionVals) {
  const sh = `'Komposisi Sesi'`;
  const lastRow = 1 + sessionNames.length;
  const catRef = `${sh}!$A$2:$A$${lastRow}`;
  const valRef = `${sh}!$C$2:$C$${lastRow}`;
  const catCache = chartCatCache(sessionNames);
  const valCache = chartNumCache(sessionVals);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title>
      <c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="id-ID" sz="1200" b="1"/><a:t>Porsi Nilai per Sesi Bursa</a:t></a:r></a:p></c:rich></c:tx>
      <c:overlay val="0"/>
    </c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:pieChart>
        <c:varyColors val="1"/>
        <c:ser>
          <c:idx val="0"/>
          <c:order val="0"/>
          <c:tx><c:strRef><c:f>${sh}!$C$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Nilai (Rp)</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:strRef><c:f>${catRef}</c:f>${catCache}</c:strRef></c:cat>
          <c:val><c:numRef><c:f>${valRef}</c:f>${valCache}</c:numRef></c:val>
          <c:dLbls>
            <c:showLegendKey val="0"/>
            <c:showVal val="0"/>
            <c:showCatName val="1"/>
            <c:showSerName val="0"/>
            <c:showPercent val="1"/>
            <c:showBubbleSize val="0"/>
          </c:dLbls>
        </c:ser>
        <c:firstSliceAng val="0"/>
      </c:pieChart>
    </c:plotArea>
    <c:plotVisOnly val="1"/>
    <c:dispBlanksAs val="gap"/>
  </c:chart>
</c:chartSpace>`;
}

function buildDrawingXML() {
  const anchor = (id, fromCol, fromRow, toCol, toRow, rid) => `  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="${id}" name="Chart ${id - 1}"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rid}"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
${anchor(2, 0, 14, 5, 30, 'rId1')}
${anchor(3, 6, 14, 11, 30, 'rId2')}
${anchor(4, 0, 31, 5, 47, 'rId3')}
</xdr:wsDr>`;
}

/* ============ EKSPOR XLSX (border + autofit + 3 chart di Dashboard) ============ */
function exportXLSX() {
  const r1 = v => Math.round(v * 100) / 100;
  const n = state.data.length;
  const sumber = state.mode === 'live'
    ? 'Data LIVE — Yahoo Finance (v8 chart, tanpa API key)'
    : 'Data SIMULASI (API offline saat ekspor)';

  const cats = state.data.map(d => d.dstr || d.date.toISOString().slice(0, 10));
  const s1Vals = state.data.map(d => Math.round(d.s1));
  const s2Vals = state.data.map(d => Math.round(d.s2));
  const totalVals = state.data.map(d => Math.round(d.total));
  const sesNames = state.sessions.map(r => r.name);
  const sesVals = state.sessions.map(r => r.rev);

  const dashboardRows = [
    [ 'BCA IDX — Live Market Console (Yahoo Finance)' ],
    [ 'Sumber', sumber ],
    [ 'Diekspor', new Date().toLocaleString('id-ID') ],
    [ 'Periode', `${state.days} hari bursa terakhir` ],
    [],
    [ 'Indikator', 'Nilai', 'Delta (%)' ],
    [ 'Nilai transaksi periode (Rp)', state.kpi.rev, r1(state.kpi.dRev) ],
    [ 'Total volume (lembar)', state.kpi.orders, r1(state.kpi.dOrd) ],
    [ 'Harga penutupan terakhir (Rp)', state.kpi.aov, r1(state.kpi.dAov) ],
    [ 'Porsi Sesi I (%)', state.kpi.conv, r1(state.kpi.dCnv) ],
    [ 'Nilai transaksi terakhir — live (Rp)', Math.round(state.todayValue), '' ],
    [ 'Volume terakhir — live (lembar)', Math.round(state.todayVol), '' ],
    [ 'Update kutipan sesi ini', state.sessionTx, '' ],
    [],
    [ 'GRAFIK DASHBOARD — Bar · Line · Pie' ]
  ];
  const dashboardStyles = [
    'title', 'info', 'info', 'info', 'blank', 'header',
    'body', 'body', 'body', 'body', 'body', 'body', 'body',
    'blank', 'title'
  ];

  const sheets = [
    {
      name: 'Dashboard',
      rows: dashboardRows,
      rowStyles: dashboardStyles,
      hasDrawing: true
    },
    {
      name: 'Nilai Transaksi Harian',
      rows: [
        [ 'Tanggal', 'Sesi I (Rp)', 'Sesi II (Rp)', 'Total (Rp)' ],
        ...state.data.map(d => [ d.dstr || d.date.toISOString().slice(0, 10), Math.round(d.s1), Math.round(d.s2), Math.round(d.total) ])
      ],
      rowStyles: [ 'header', ...Array(n).fill('body') ]
    },
    {
      name: 'Saham Bank',
      rows: [
        [ 'Peringkat', 'Kode', 'Nama', 'Nilai Transaksi (Rp)', 'Volume (lembar)', 'Porsi (%)', 'Perubahan Periode (%)' ],
        ...state.peers.map((p, i) => [ i + 1, p.code, p.name, p.value, p.vol, r1(p.share), r1(p.changePct) ])
      ],
      rowStyles: [ 'header', ...Array(state.peers.length).fill('body') ]
    },
    {
      name: 'Komposisi Sesi',
      rows: [
        [ 'Sesi', 'Porsi (%)', 'Nilai (Rp)', 'Delta (pp)' ],
        ...state.sessions.map(r => [ r.name, r1(r.pct), r.rev, r1(r.delta) ])
      ],
      rowStyles: [ 'header', ...Array(state.sessions.length).fill('body') ]
    },
    {
      name: 'Kutipan',
      rows: [
        [ 'Waktu', 'Simbol', 'Pasar', 'Kanal', 'Volume (lembar)', 'Harga (Rp)' ],
        ...state.txLog.map(t => [ t.time, t.product, t.city, t.channel, t.qty, t.value ])
      ],
      rowStyles: [ 'header', ...Array(state.txLog.length).fill('body') ]
    }
  ];

  const W = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const PK = 'http://schemas.openxmlformats.org/package/2006/relationships';

  const sheetOverrides = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const chartOverrides = [ 1, 2, 3 ].map(i => `<Override PartName="/xl/charts/chart${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('');

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>${chartOverrides}</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PK}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${W}" xmlns:r="${R}"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PK}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${W}">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="#,##0"/>
    <numFmt numFmtId="165" formatCode="0.00"/>
  </numFmts>
  <fonts count="3">
    <font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/><family val="2"/><color rgb="FF1C1712"/></font>
    <font><b/><sz val="14"/><name val="Calibri"/><family val="2"/><color rgb="FFD14A1E"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFAF6EB"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFB8A98A"/></left>
      <right style="thin"><color rgb="FFB8A98A"/></right>
      <top style="thin"><color rgb="FFB8A98A"/></top>
      <bottom style="thin"><color rgb="FFB8A98A"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="7">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment vertical="center" horizontal="right"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment vertical="center" horizontal="right"/></xf>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;

  const sheetXmls = sheets.map(s => sheetXML(s.rows, {
    rowStyles: s.rowStyles,
    drawingRel: s.hasDrawing
  }));

  const chart1 = buildBarChartXML(cats, s1Vals, s2Vals);
  const chart2 = buildLineChartXML(cats, totalVals);
  const chart3 = buildPieChartXML(sesNames, sesVals);

  const drawing = buildDrawingXML();
  const drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PK}"><Relationship Id="rId1" Type="${R}/chart" Target="../charts/chart1.xml"/><Relationship Id="rId2" Type="${R}/chart" Target="../charts/chart2.xml"/><Relationship Id="rId3" Type="${R}/chart" Target="../charts/chart3.xml"/></Relationships>`;

  const sheet1Rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PK}"><Relationship Id="rId1" Type="${R}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;

  const entries = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: styles },
    ...sheetXmls.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
    { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: sheet1Rels },
    { name: 'xl/drawings/drawing1.xml', data: drawing },
    { name: 'xl/drawings/_rels/drawing1.xml.rels', data: drawingRels },
    { name: 'xl/charts/chart1.xml', data: chart1 },
    { name: 'xl/charts/chart2.xml', data: chart2 },
    { name: 'xl/charts/chart3.xml', data: chart3 }
  ];

  const fname = exportFileName('xlsx');
  triggerDownload(makeZip(entries), fname);
  toast(`Terunduh: ${fname}`);
}
