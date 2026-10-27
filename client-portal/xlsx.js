/* ── Sentinels Client Portal · minimal .xlsx writer ─────────────────
   Builds an Excel workbook in the browser with no third-party library:
   one worksheet per sheet, a bold frozen header row, column widths and
   number formats, packed in a ZIP compressed with the browser's
   CompressionStream (uncompressed where it is missing). Used by prices.js,
   history.js and nodos.js.
     await Xlsx.download('file.xlsx', [{ name, columns: [{ title, width, fmt }], rows: [[...]] }])
   fmt: 'text' (default), '0', '0.00' or '0.0000'. */
const Xlsx = (() => {
  const FMT = { text: 0, '0': 3, '0.00': 4, '0.0000': 5 };  // cellXfs index (header is 1, see styles)
  const xml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const col = i => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
  const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  function sheetXml({ columns, rows }) {
    const cell = (v, r, c, s) => {
      const ref = col(c) + r;
      if (v == null || v === '') return '';
      if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
      return `<c r="${ref}" s="${s}" t="inlineStr"><is><t>${xml(v)}</t></is></c>`;
    };
    const head = `<row r="1">${columns.map((c, i) => cell(c.title, 1, i, 1)).join('')}</row>`;
    const body = rows.map((row, k) => `<row r="${k + 2}">${row.map((v, i) => cell(v, k + 2, i, FMT[columns[i].fmt] || 0)).join('')}</row>`).join('');
    return HEAD + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      `<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 12}" customWidth="1"/>`).join('')}</cols>` +
      `<sheetData>${head}${body}</sheetData></worksheet>`;
  }

  function files(sheets) {
    const out = {
      '[Content_Types].xml': HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>',
      '_rels/.rels': HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': HEAD + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels': HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      // cellXfs: 0 general, 1 bold header, 2 text, 3 integer, 4 two decimals, 5 four decimals
      'xl/styles.xml': HEAD + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0000"/></numFmts>' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    };
    sheets.forEach((s, i) => { out[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s); });
    return out;
  }

  /* ── ZIP (deflate with the browser's CompressionStream; stored where it is missing) ── */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const canDeflate = typeof CompressionStream === 'function';
  const deflate = async data => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  async function zip(entries) {
    const enc = new TextEncoder(), parts = [], dir = [];
    const d = new Date(), time = d.getHours() << 11 | d.getMinutes() << 5 | d.getSeconds() >> 1, date = d.getFullYear() - 1980 << 9 | d.getMonth() + 1 << 5 | d.getDate();
    let offset = 0;
    for (const [name, text] of Object.entries(entries)) {
      const n = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const body = canDeflate ? await deflate(data) : data, method = canDeflate ? 8 : 0;
      const h = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, method, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, body.length, 4], [22, data.length, 4], [26, n.length, 2], [28, 0, 2]]
        .forEach(([o, v, s]) => s === 4 ? h.setUint32(o, v, true) : h.setUint16(o, v, true));
      const c = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, method, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, body.length, 4], [24, data.length, 4], [28, n.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
        .forEach(([o, v, s]) => s === 4 ? c.setUint32(o, v, true) : c.setUint16(o, v, true));
      parts.push(h, n, body); dir.push(c, n);
      offset += 30 + n.length + body.length;
    }
    const size = dir.reduce((t, p) => t + p.byteLength, 0), e = new DataView(new ArrayBuffer(22));
    const count = Object.keys(entries).length;
    [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, count, 2], [10, count, 2], [12, size, 4], [16, offset, 4], [20, 0, 2]]
      .forEach(([o, v, s]) => s === 4 ? e.setUint32(o, v, true) : e.setUint16(o, v, true));
    return new Blob([...parts, ...dir, e], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  const build = sheets => zip(files(sheets));  // Promise<Blob>
  async function download(filename, sheets) {
    const url = URL.createObjectURL(await build(sheets));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  return { build, download };
})();
