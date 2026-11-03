const puppeteer = require("puppeteer-core");

// ===================== formatters =====================
const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fmtMoney = (n) =>
  `₹${Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const fmtDate = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "";

const fmtDateTime = (d) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

const cellText = (col, v) => {
  if (v === null || v === undefined || v === "") return "-";
  if (col.type === "money") return fmtMoney(v);
  if (col.type === "number") return Number(v).toLocaleString("en-IN");
  if (col.type === "percent") return `${Number(v)}%`;
  if (col.type === "date") return fmtDate(v) || "-";
  return String(v);
};

const summaryText = (s) =>
  s.type === "money"
    ? fmtMoney(s.value)
    : s.type === "number"
      ? Number(s.value).toLocaleString("en-IN")
      : String(s.value);

// ===================== CSV =====================
const csvCell = (v) => {
  let s = String(v ?? "");
  // Excel formula injection thekano
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csvValue = (col, v) => {
  if (v === null || v === undefined) return "";
  if (col.type === "date") return fmtDate(v);
  return v;
};

const toCsv = ({ report, meta }) => {
  const { title, columns, rows, summary } = report;
  const lines = [
    [title],
    [`Period: ${meta.periodText}`],
    [`Stores: ${meta.storesText}`],
    [`Generated: ${meta.generatedAt}`],
    [],
    columns.map((c) => c.header),
    ...rows.map((r) => columns.map((c) => csvValue(c, r[c.key]))),
  ];
  if (summary?.length) {
    lines.push([]);
    summary.forEach((s) => lines.push([s.label, s.value]));
  }
  const text = lines.map((l) => l.map(csvCell).join(",")).join("\r\n");
  return Buffer.from("\ufeff" + text, "utf8"); // BOM, jate Excel e ঠিকমতো khole
};

// ===================== XLSX =====================
const toXlsx = async ({ report, meta }) => {
  let ExcelJS;
  try {
    ExcelJS = require("exceljs");
  } catch {
    throw new Error("exceljs is not installed. Run: npm i exceljs");
  }

  const { title, columns, rows, summary } = report;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.slice(0, 31));
  const n = columns.length;

  const titleRow = ws.addRow([title]);
  ws.mergeCells(titleRow.number, 1, titleRow.number, n);
  titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: "FF1D4ED8" } };

  const infoRow = ws.addRow([
    `Period: ${meta.periodText}   |   Stores: ${meta.storesText}   |   Generated: ${meta.generatedAt}`,
  ]);
  ws.mergeCells(infoRow.number, 1, infoRow.number, n);
  infoRow.getCell(1).font = { color: { argb: "FF6B7280" }, size: 10 };

  ws.addRow([]);
  (summary || []).forEach((s) => {
    const r = ws.addRow([s.label, s.value]);
    r.getCell(1).font = { bold: true };
    if (s.type === "money") r.getCell(2).numFmt = "#,##0.00";
    r.getCell(2).alignment = { horizontal: "left" };
  });
  if (summary?.length) ws.addRow([]);

  const headerRow = ws.addRow(columns.map((c) => c.header));
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D4ED8" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });

  rows.forEach((row) => {
    const r = ws.addRow(
      columns.map((c) => {
        const v = row[c.key];
        if (v === null || v === undefined) return "";
        return c.type === "date" ? new Date(v) : v;
      }),
    );
    columns.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      if (c.type === "money") cell.numFmt = "#,##0.00";
      if (c.type === "number") cell.numFmt = "#,##0";
      if (c.type === "percent") cell.numFmt = '0.00"%"';
      if (c.type === "date") cell.numFmt = "dd-mmm-yyyy";
      if (["money", "number", "percent"].includes(c.type)) {
        cell.alignment = { horizontal: "right" };
      }
    });
  });

  columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width || 16;
  });
  ws.autoFilter = {
    from: { row: headerRow.number, column: 1 },
    to: { row: headerRow.number, column: n },
  };
  ws.views = [{ state: "frozen", ySplit: headerRow.number }];

  return Buffer.from(await wb.xlsx.writeBuffer());
};

// ===================== PDF =====================
const MAX_PARALLEL = 2;
let running = 0;
const waiting = [];
const acquire = () =>
  running < MAX_PARALLEL
    ? (running++, Promise.resolve())
    : new Promise((resolve) => waiting.push(resolve));
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else running--;
};

const buildHtml = ({ report, meta }) => {
  const { title, columns, rows, summary } = report;
  const isNum = (c) => ["money", "number", "percent"].includes(c.type);

  const head = columns
    .map((c) => `<th class="${isNum(c) ? "r" : ""}">${esc(c.header)}</th>`)
    .join("");
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr>${columns
              .map((c) => `<td class="${isNum(c) ? "r" : ""}">${esc(cellText(c, r[c.key]))}</td>`)
              .join("")}</tr>`,
        )
        .join("")
    : `<tr><td colspan="${columns.length}" class="empty">No data found for this filter</td></tr>`;

  const tiles = (summary || [])
    .map(
      (s) =>
        `<div class="tile"><div class="k">${esc(s.label)}</div><div class="v">${esc(summaryText(s))}</div></div>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: "Noto Sans","Segoe UI",Arial,sans-serif; font-size: 9px; color: #1f2937; margin: 0; }
  .head { background: #1d4ed8; color: #fff; border-radius: 6px; padding: 12px 14px; }
  .head h1 { margin: 0; font-size: 17px; letter-spacing: .3px; }
  .head p { margin: 4px 0 0; font-size: 9.5px; color: #dbeafe; }
  .tiles { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
  .tile { flex: 1; min-width: 120px; border: 1px solid #dbeafe; background: #eff6ff; border-radius: 6px; padding: 7px 10px; }
  .tile .k { font-size: 8px; text-transform: uppercase; letter-spacing: .5px; color: #6b7280; }
  .tile .v { margin-top: 3px; font-size: 12px; font-weight: 700; color: #1e3a8a; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th { background: #1d4ed8; color: #fff; padding: 6px 5px; font-size: 8.5px; text-align: left; text-transform: uppercase; letter-spacing: .3px; }
  td { padding: 5px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #f8fafc; }
  tr { page-break-inside: avoid; }
  .r { text-align: right; }
  .empty { text-align: center; padding: 20px; color: #6b7280; }
</style></head><body>
  <div class="head">
    <h1>${esc(title)}</h1>
    <p>Period: ${esc(meta.periodText)} &nbsp;|&nbsp; Stores: ${esc(meta.storesText)} &nbsp;|&nbsp; Generated: ${esc(meta.generatedAt)}</p>
  </div>
  ${tiles ? `<div class="tiles">${tiles}</div>` : ""}
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body></html>`;
};

const toPdf = async ({ report, meta }) => {
  if (!process.env.CHROME_PATH) {
    throw new Error("CHROME_PATH is not set in environment");
  }
  await acquire();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setContent(buildHtml({ report, meta }), {
      waitUntil: "load",
      timeout: 30000,
    });
    const pdf = await page.pdf({
      format: "A4",
      landscape: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate:
        '<div style="font-size:8px;width:100%;text-align:center;color:#888;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: "10mm", bottom: "14mm", left: "8mm", right: "8mm" },
    });
    return Buffer.from(pdf);
  } finally {
    if (browser) await browser.close().catch(() => {});
    release();
  }
};

// ===================== entry =====================
const buildReportFile = async (format, report, { periodText, storesText }) => {
  const meta = { periodText, storesText, generatedAt: fmtDateTime(new Date()) };

  if (format === "csv") {
    return { buffer: toCsv({ report, meta }), contentType: "text/csv; charset=utf-8", ext: "csv" };
  }
  if (format === "xlsx") {
    return {
      buffer: await toXlsx({ report, meta }),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ext: "xlsx",
    };
  }
  return { buffer: await toPdf({ report, meta }), contentType: "application/pdf", ext: "pdf" };
};

module.exports = { buildReportFile };