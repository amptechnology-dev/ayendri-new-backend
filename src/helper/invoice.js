const puppeteer = require("puppeteer-core");
const OrderModel = require("../model/order.model.js");
const StoreModel = require("../model/store.model.js");
require("../model/user.model.js"); // populate er jonno model register thakte hobe
const { uploadToR2 } = require("./upload.js");
const { sendInvoiceEmailToUser } = require("./orderMail.js");

const BRAND_NAME = "Ayendri"; // footer e dekhabe, bodlate chaile ekhane

// ===================== small helpers =====================
const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const money = (n) =>
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
    : "-";

const addressLines = (a) => {
  if (!a) return [];
  if (typeof a === "string") return [a];
  return [
    a.addressLine,
    a.area,
    [a.city, a.state].filter(Boolean).join(", "),
    [a.pincode, a.country].filter(Boolean).join(", "),
  ].filter(Boolean);
};

const itemVariantLabel = (it) =>
  [it.color, it.size, it.weight, it.height].filter(Boolean).join(" / ");

const itemGstRate = (it, gstMode) => {
  const g = it.gstRates || {};
  return gstMode === "INTER"
    ? Number(g.igst || 0)
    : Number(g.cgst || 0) + Number(g.sgst || 0);
};

const paymentLabel = (order) => {
  if (order.paymentMethod === "ONLINE") {
    const ok = (order.paymentAttempts || []).find((a) => a.status === "SUCCESS");
    return order.paymentStatus === "PAID"
      ? `Paid online${ok?.mihpayid ? ` (Txn: ${ok.mihpayid})` : ""}`
      : "Online payment pending";
  }
  if (order.paymentOff) return "Payment directly with store";
  return order.paymentStatus === "PAID"
    ? "Cash on Delivery (paid)"
    : "Cash on Delivery (payable on delivery)";
};

// ---------- amount in words (Indian system) ----------
const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

const twoDigits = (n) =>
  n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");

const threeDigits = (n) => {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? twoDigits(r) : ""]
    .filter(Boolean)
    .join(" ");
};

const intToWords = (n) => {
  if (n === 0) return "Zero";
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  return [
    crore ? `${intToWords(crore)} Crore` : "",
    lakh ? `${twoDigits(lakh)} Lakh` : "",
    thousand ? `${twoDigits(thousand)} Thousand` : "",
    rest ? threeDigits(rest) : "",
  ]
    .filter(Boolean)
    .join(" ");
};

const amountInWords = (amount) => {
  const total = Math.round(Number(amount || 0) * 100);
  const rupees = Math.floor(total / 100);
  const paise = total % 100;
  let out = `Rupees ${intToWords(rupees)}`;
  if (paise) out += ` and ${twoDigits(paise)} Paise`;
  return `${out} Only`;
};

// ---------- store logo: server e download kore base64 kore nei, tahole PDF e chhobi miss hobe na ----------
const fetchImageDataUri = async (url) => {
  if (!url) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const type = res.headers.get("content-type") || "";
    if (!type.startsWith("image/")) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 3 * 1024 * 1024) return null; // 3MB er beshi hole skip
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch (e) {
    console.error("Invoice logo fetch failed:", e.message);
    return null;
  }
};

// ===================== HTML =====================
const buildInvoiceHtml = ({ order, store, customer, logoSrc }) => {
  const gstMode = order.gstMode || "INTRA";
  const invoiceDate = order.invoiceGeneratedAt || new Date();
  const storeName = store?.storeName || order.storeName || "";
  const hasGst = Number(order.totalGst || 0) > 0;
  const isPaid = order.paymentStatus === "PAID";

  const seller = order.pickupAddress?.pincode
    ? {
        contact: order.pickupAddress.contactName,
        phone: order.pickupAddress.phone,
        email: order.pickupAddress.email || store?.email,
        lines: addressLines(order.pickupAddress),
      }
    : {
        contact: null,
        phone: store?.contactNo,
        email: store?.email,
        lines: addressLines(store?.address),
      };
  const sellerGstin = store?.gstin || store?.gstNumber || null;

  const rows = (order.items || [])
    .map((it, i) => {
      const rate = itemGstRate(it, gstMode);
      const taxable = it.taxableAmount ?? it.lineTotal ?? 0;
      const total = it.lineTotalWithGst ?? it.lineTotal ?? 0;
      const label = itemVariantLabel(it);
      return `
      <tr>
        <td class="c">${i + 1}</td>
        <td>
          <div class="nm">${escapeHtml(it.name)}</div>
          ${label ? `<div class="sub">${escapeHtml(label)}</div>` : ""}
          ${it.productCode ? `<div class="sub">Code: ${escapeHtml(it.productCode)}</div>` : ""}
        </td>
        <td class="c">${escapeHtml(it.hsnCode || "-")}</td>
        <td class="c">${it.quantity}</td>
        <td class="r">${money(it.offerPrice)}</td>
        <td class="r">${money(taxable)}</td>
        <td class="c">${rate ? `${rate}%` : "-"}</td>
        <td class="r">${money(it.gstAmount || 0)}</td>
        <td class="r strong">${money(total)}</td>
      </tr>`;
    })
    .join("");

  const shipping = Number(order.shippingCharge || 0);
  const itemsTotal =
    order.itemsTotal ?? Math.max(0, Number(order.totalAmount || 0) - shipping);
  const anyInclusive = (order.items || []).some((i) => i.gstInclusive);

  const totalsRows = [
    hasGst
      ? `<tr><td>Taxable value</td><td class="r">${money(order.totalTaxable)}</td></tr>`
      : "",
    hasGst && gstMode === "INTRA"
      ? `<tr><td>CGST</td><td class="r">${money(order.totalCgst)}</td></tr>
         <tr><td>SGST</td><td class="r">${money(order.totalSgst)}</td></tr>`
      : "",
    hasGst && gstMode === "INTER"
      ? `<tr><td>IGST</td><td class="r">${money(order.totalIgst)}</td></tr>`
      : "",
    `<tr><td>Items total</td><td class="r">${money(itemsTotal)}</td></tr>`,
    `<tr><td>Shipping</td><td class="r">${shipping > 0 ? money(shipping) : "Free"}</td></tr>`,
    `<tr class="grand"><td>Grand Total</td><td class="r">${money(order.totalAmount)}</td></tr>`,
  ].join("");

  const ship = order.deliveryAddress || {};
  const logoHtml = logoSrc
    ? `<img class="logo" src="${logoSrc}" alt="" />`
    : `<div class="logo fallback">${escapeHtml(
        (storeName.trim()[0] || "S").toUpperCase(),
      )}</div>`;

  const deliveryInfo = order.deliveryInfo || {};
  const deliveryText =
    deliveryInfo.etaLabel ||
    (order.expectedDeliveryDate
      ? `Expected by ${fmtDate(order.expectedDeliveryDate)}`
      : null);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root {
    --maroon: #6E1423;
    --maroon-dark: #4A0D18;
    --gold: #C9962B;
    --gold-soft: #F6EBD0;
    --cream: #FBF7F0;
    --ink: #2B2224;
    --muted: #7A6E70;
    --line: #E8DFD0;
  }
  * { box-sizing: border-box; }
  body { font-family: "Noto Sans", "Segoe UI", Arial, Helvetica, sans-serif; font-size: 11px; color: var(--ink); margin: 0; }

  /* ----- header band ----- */
  .head { background: var(--maroon); color: #fff; border-radius: 8px; padding: 16px 18px; display: flex; justify-content: space-between; align-items: center; border-bottom: 4px solid var(--gold); }
  .brand { display: flex; align-items: center; gap: 14px; }
  .logo { width: 64px; height: 64px; border-radius: 10px; background: #fff; object-fit: contain; padding: 3px; border: 2px solid var(--gold); }
  .logo.fallback { display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 700; color: var(--maroon); }
  .store-name { font-size: 17px; font-weight: 700; letter-spacing: .3px; }
  .store-sub { font-size: 10px; color: #E9D9B4; margin-top: 3px; }
  .doc { text-align: right; }
  .doc-title { font-size: 24px; font-weight: 700; color: var(--gold-soft); letter-spacing: 2px; }
  .doc-no { margin-top: 4px; font-size: 11px; color: #fff; }

  /* ----- meta strip ----- */
  .meta { display: flex; margin-top: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--cream); }
  .meta > div { flex: 1; padding: 8px 12px; border-right: 1px solid var(--line); }
  .meta > div:last-child { border-right: none; }
  .meta .k { font-size: 9px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); }
  .meta .v { margin-top: 3px; font-weight: 600; }

  /* ----- parties ----- */
  .cols { display: flex; gap: 14px; margin-top: 14px; }
  .box { flex: 1; border: 1px solid var(--line); border-left: 4px solid var(--gold); border-radius: 6px; padding: 10px 12px; line-height: 1.6; }
  .box h4 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .8px; color: var(--maroon); }
  .box .name { font-size: 12px; font-weight: 700; }

  /* ----- items ----- */
  table.items { width: 100%; border-collapse: collapse; margin-top: 16px; }
  table.items th { background: var(--maroon); color: #fff; padding: 8px 6px; font-size: 9.5px; text-transform: uppercase; letter-spacing: .4px; text-align: left; }
  table.items th:first-child { border-top-left-radius: 6px; }
  table.items th:last-child { border-top-right-radius: 6px; }
  table.items td { padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  table.items tbody tr:nth-child(even) td { background: var(--cream); }
  .c { text-align: center; } .r { text-align: right; }
  .nm { font-weight: 600; } .sub { color: var(--muted); font-size: 9.5px; margin-top: 1px; }
  .strong { font-weight: 700; }

  /* ----- bottom ----- */
  .bottom { display: flex; justify-content: space-between; margin-top: 14px; gap: 20px; align-items: flex-start; }
  .left { flex: 1; }
  .words { border: 1px dashed var(--gold); background: var(--gold-soft); border-radius: 6px; padding: 8px 10px; line-height: 1.5; }
  .words .k { font-size: 9px; text-transform: uppercase; letter-spacing: .6px; color: var(--maroon); font-weight: 700; }
  .notes { margin-top: 10px; color: #5c5154; line-height: 1.6; }
  table.totals { width: 280px; border-collapse: collapse; }
  table.totals td { padding: 6px 10px; border-bottom: 1px solid var(--line); }
  table.totals tr.grand td { background: var(--maroon); color: #fff; font-size: 13px; font-weight: 700; border-bottom: none; }
  table.totals tr.grand td:first-child { border-bottom-left-radius: 6px; }
  table.totals tr.grand td:last-child { border-bottom-right-radius: 6px; color: var(--gold-soft); }

  /* ----- paid stamp ----- */
  .stamp { display: inline-block; margin-top: 10px; padding: 4px 16px; border: 2px solid #2E7D4F; color: #2E7D4F; border-radius: 6px; font-weight: 700; letter-spacing: 3px; font-size: 14px; transform: rotate(-4deg); }

  /* ----- footer ----- */
  .foot { margin-top: 26px; border-top: 2px solid var(--gold); padding-top: 8px; text-align: center; color: var(--muted); font-size: 9.5px; line-height: 1.6; }
  .foot b { color: var(--maroon); }
  tr { page-break-inside: avoid; }
  .bottom, .cols, .meta { page-break-inside: avoid; }
</style>
</head>
<body>
  <div class="head">
    <div class="brand">
      ${logoHtml}
      <div>
        <div class="store-name">${escapeHtml(storeName)}</div>
        <div class="store-sub">${sellerGstin ? `GSTIN: ${escapeHtml(sellerGstin)}` : "&nbsp;"}</div>
      </div>
    </div>
    <div class="doc">
      <div class="doc-title">${hasGst ? "TAX INVOICE" : "INVOICE"}</div>
      <div class="doc-no">${escapeHtml(order.invoiceNumber)}</div>
    </div>
  </div>

  <div class="meta">
    <div><div class="k">Invoice Date</div><div class="v">${fmtDate(invoiceDate)}</div></div>
    <div><div class="k">Order No</div><div class="v">${escapeHtml(order.orderNumber)}</div></div>
    <div><div class="k">Order Date</div><div class="v">${fmtDate(order.createdAt)}</div></div>
    <div><div class="k">Payment</div><div class="v">${escapeHtml(paymentLabel(order))}</div></div>
  </div>

  <div class="cols">
    <div class="box">
      <h4>Sold By</h4>
      <div class="name">${escapeHtml(storeName)}</div>
      ${seller.contact ? `<div>${escapeHtml(seller.contact)}</div>` : ""}
      ${seller.lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}
      ${seller.phone ? `<div>Phone: ${escapeHtml(seller.phone)}</div>` : ""}
      ${seller.email ? `<div>Email: ${escapeHtml(seller.email)}</div>` : ""}
      ${sellerGstin ? `<div>GSTIN: ${escapeHtml(sellerGstin)}</div>` : ""}
    </div>
    <div class="box">
      <h4>Billed / Shipped To</h4>
      <div class="name">${escapeHtml(ship.fullName || customer?.name || "")}</div>
      ${addressLines(ship).map((l) => `<div>${escapeHtml(l)}</div>`).join("")}
      ${ship.phone ? `<div>Phone: ${escapeHtml(ship.phone)}</div>` : ""}
      ${customer?.email ? `<div>Email: ${escapeHtml(customer.email)}</div>` : ""}
    </div>
  </div>

  <table class="items">
    <thead>
      <tr>
        <th class="c" style="width:4%">#</th>
        <th>Item</th>
        <th class="c" style="width:9%">HSN</th>
        <th class="c" style="width:6%">Qty</th>
        <th class="r" style="width:11%">Unit Price</th>
        <th class="r" style="width:11%">Taxable</th>
        <th class="c" style="width:7%">GST</th>
        <th class="r" style="width:10%">GST Amt</th>
        <th class="r" style="width:12%">Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="bottom">
    <div class="left">
      <div class="words">
        <div class="k">Amount in words</div>
        <div>${escapeHtml(amountInWords(order.totalAmount))}</div>
      </div>
      <div class="notes">
        ${deliveryText ? `<div><b>Delivery:</b> ${escapeHtml(deliveryText)}</div>` : ""}
        ${order.bookingDate ? `<div><b>Booking date:</b> ${fmtDate(order.bookingDate)}</div>` : ""}
        ${order.note ? `<div><b>Order note:</b> ${escapeHtml(order.note)}</div>` : ""}
        ${anyInclusive ? `<div>Prices marked as GST-inclusive already include tax.</div>` : ""}
      </div>
      ${isPaid ? `<div class="stamp">PAID</div>` : ""}
    </div>
    <table class="totals"><tbody>${totalsRows}</tbody></table>
  </div>

  <div class="foot">
    <div>This is a computer generated invoice and does not require a signature.</div>
    <div>Thank you for shopping with <b>${escapeHtml(storeName)}</b> on <b>${escapeHtml(BRAND_NAME)}</b></div>
  </div>
</body>
</html>`;
};

// ===================== PDF =====================
// server er CPU bachate: ekshathe max 2 ta chrome
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

const htmlToPdfBuffer = async (html) => {
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
    await page.setContent(html, { waitUntil: "load", timeout: 30000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });
    return Buffer.from(pdf);
  } finally {
    if (browser) await browser.close().catch(() => {});
    release();
  }
};

// ===================== MAIN =====================
const QUOTE_PENDING = ["AWAITING_QUOTE", "QUOTED"];

/**
 * Invoice PDF banay, R2 te upload kore, order e URL rakhe, user ke mail pathay.
 * Idempotent: mail ekbar-i jabe. Shob condition nijei check kore, tai jekhane khushi call kora jay.
 */
const processInvoice = async (orderId) => {
  const order = await OrderModel.findById(orderId)
    .select("+pickupAddress")
    .populate("userId", "name email")
    .lean();
  if (!order) return null;

  // invoice shudhu jekhane price fixed + payment ready
  if (order.status === "CANCELLED") return null;
  if (QUOTE_PENDING.includes(order.priceStatus)) return null;
  const ready =
    order.paymentMethod === "COD" ||
    order.paymentOff === true ||
    order.paymentStatus === "PAID";
  if (!ready) return null;

  // age-i shob hoye gele kichu korar nei
  if (order.invoiceUrl && order.invoiceEmailSentAt) {
    return { url: order.invoiceUrl, emailed: false, skipped: true };
  }

  const customer = order.userId || null;
  const store = await StoreModel.findById(order.storeId).lean();

  const invoiceNumber =
    order.invoiceNumber || `INV${String(order.orderNumber).replace(/^ORD/, "")}`;
  const generatedAt = order.invoiceGeneratedAt || new Date();

  // store er prothom image = invoice logo
  const logoSrc = await fetchImageDataUri(store?.images?.[0]);

  const html = buildInvoiceHtml({
    order: { ...order, invoiceNumber, invoiceGeneratedAt: generatedAt },
    store,
    customer,
    logoSrc,
  });
  const pdfBuffer = await htmlToPdfBuffer(html);

  const key = `invoices/${order.orderNumber}.pdf`;
  const url = await uploadToR2(pdfBuffer, key, "application/pdf");

  await OrderModel.updateOne(
    { _id: order._id },
    {
      $set: {
        invoiceUrl: url,
        invoiceNumber,
        invoiceGeneratedAt: generatedAt,
      },
    },
  );

  // mail: atomic claim, tai duplicate callback e double mail jabe na
  let emailed = false;
  if (customer?.email) {
    const claimed = await OrderModel.findOneAndUpdate(
      { _id: order._id, invoiceEmailSentAt: null },
      { $set: { invoiceEmailSentAt: new Date() } },
    ).lean();

    if (claimed) {
      emailed = await sendInvoiceEmailToUser({
        toEmail: customer.email,
        userName: customer.name,
        order: { ...order, invoiceNumber },
        pdfBuffer,
        fileName: `${invoiceNumber}.pdf`,
      });
      if (!emailed) {
        // mail fail hole abar try korte debo
        await OrderModel.updateOne(
          { _id: order._id },
          { $set: { invoiceEmailSentAt: null } },
        );
      }
    }
  }

  return { url, emailed };
};

module.exports = { processInvoice, buildInvoiceHtml };