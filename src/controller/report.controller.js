const mongoose = require("mongoose");
const OrderModel = require("../model/order.model.js");
const ProductModel = require("../model/product.model.js");
const StoreModel = require("../model/store.model.js");
const UserModel = require("../model/user.model.js");
const { buildReportFile } = require("../helper/reportExport.js");

// ===================== helpers =====================
const MAX_ROWS = 5000; // ekta report e max koto row (excel / pdf er jonno)
const ORDER_STATUSES = ["PENDING", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"];
const FORMATS = ["xlsx", "csv", "pdf"];

class ReportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const getUserId = (req) => req.user?._id || req.user?.id;
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const fmtLong = (d) =>
  d.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

// month (YYYY-MM) thakle seta, nahole from / to. Shob IST e
const parseRange = (q) => {
  if (q.month) {
    if (!MONTH_RE.test(q.month)) throw new ReportError(400, "Invalid month (use YYYY-MM)");
    const [y, m] = q.month.split("-").map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    const start = new Date(`${q.month}-01T00:00:00.000+05:30`);
    const next = new Date(`${ny}-${pad(nm)}-01T00:00:00.000+05:30`);
    return {
      filter: { $gte: start, $lt: next },
      label: q.month,
      text: start.toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        month: "long",
        year: "numeric",
      }),
    };
  }

  const filter = {};
  if (q.from) {
    if (!DATE_RE.test(q.from)) throw new ReportError(400, "Invalid from date (use YYYY-MM-DD)");
    filter.$gte = new Date(`${q.from}T00:00:00.000+05:30`);
  }
  if (q.to) {
    if (!DATE_RE.test(q.to)) throw new ReportError(400, "Invalid to date (use YYYY-MM-DD)");
    filter.$lte = new Date(`${q.to}T23:59:59.999+05:30`);
  }
  if (!q.from && !q.to) return { filter: null, label: "all-time", text: "All time" };

  return {
    filter,
    label: `${q.from || "start"}_to_${q.to || "today"}`,
    text: `${filter.$gte ? fmtLong(filter.$gte) : "Beginning"} to ${filter.$lte ? fmtLong(filter.$lte) : "Today"}`,
  };
};

const getCtx = async (req) => {
  const userId = getUserId(req);
  const stores = await StoreModel.find({ userId }).select("storeName").lean();
  if (!stores.length) throw new ReportError(404, "No store found for this account");

  let selected = stores;
  const { storeId } = req.query;
  if (storeId) {
    if (!mongoose.isValidObjectId(storeId)) throw new ReportError(400, "Invalid store id");
    selected = stores.filter((s) => String(s._id) === String(storeId));
    if (!selected.length) throw new ReportError(403, "Not authorized for this store");
  }

  return {
    stores: selected,
    storeIds: selected.map((s) => s._id),
    storeName: new Map(selected.map((s) => [String(s._id), s.storeName])),
    range: parseRange(req.query),
    query: req.query,
  };
};

const orderMatch = (ctx, extra = {}) => ({
  storeId: { $in: ctx.storeIds },
  ...(ctx.range.filter ? { createdAt: ctx.range.filter } : {}),
  ...extra,
});

const parseTop = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_ROWS) : MAX_ROWS;
};

const STORE_COL = { key: "store", header: "Store", type: "text", width: 22 };

// ===================== 1. ORDERS (all / pending) =====================
const ordersReport = (mode) => async (ctx) => {
  const { query } = ctx;
  const extra = {};

  if (mode === "pending") {
    extra.status = { $in: ["PENDING", "CONFIRMED"] };
  } else if (query.status) {
    if (!ORDER_STATUSES.includes(query.status)) throw new ReportError(400, "Invalid status");
    extra.status = query.status;
  }

  const orders = await OrderModel.find(orderMatch(ctx, extra))
    .select(
      "orderNumber createdAt storeId status paymentMethod paymentStatus totalAmount totalItems shippingCharge deliveryAddress.fullName deliveryAddress.phone deliveryAddress.city",
    )
    .sort(mode === "pending" ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 })
    .limit(MAX_ROWS)
    .lean();

  const now = Date.now();
  const rows = orders.map((o) => ({
    orderNumber: o.orderNumber,
    createdAt: o.createdAt,
    store: ctx.storeName.get(String(o.storeId)) || "",
    customer: o.deliveryAddress?.fullName || "",
    phone: o.deliveryAddress?.phone || "",
    city: o.deliveryAddress?.city || "",
    status: o.status,
    payment: `${o.paymentMethod} / ${o.paymentStatus}`,
    items: o.totalItems || 0,
    shipping: round2(o.shippingCharge),
    total: round2(o.totalAmount),
    ageDays: Math.floor((now - new Date(o.createdAt).getTime()) / 86400000),
  }));

  const columns = [
    { key: "orderNumber", header: "Order #", type: "text", width: 14 },
    { key: "createdAt", header: "Placed On", type: "date", width: 14 },
    STORE_COL,
    { key: "customer", header: "Customer", type: "text", width: 22 },
    { key: "phone", header: "Phone", type: "text", width: 14 },
    { key: "city", header: "City", type: "text", width: 16 },
    { key: "status", header: "Status", type: "text", width: 12 },
    { key: "payment", header: "Payment", type: "text", width: 18 },
    { key: "items", header: "Items", type: "number", width: 8 },
    { key: "shipping", header: "Shipping", type: "money", width: 12 },
    { key: "total", header: "Total", type: "money", width: 14 },
  ];

  let summary;
  if (mode === "pending") {
    columns.splice(7, 0, { key: "ageDays", header: "Waiting (days)", type: "number", width: 12 });
    summary = [
      { label: "Pending orders", value: rows.length, type: "number" },
      { label: "Pending value", value: round2(rows.reduce((s, r) => s + r.total, 0)), type: "money" },
      { label: "Oldest pending (days)", value: rows.length ? rows[0].ageDays : 0, type: "number" },
      { label: "Awaiting confirm", value: rows.filter((r) => r.status === "PENDING").length, type: "number" },
    ];
  } else {
    const count = (s) => rows.filter((r) => r.status === s).length;
    summary = [
      { label: "Total orders", value: rows.length, type: "number" },
      {
        label: "Order value (excl. cancelled)",
        value: round2(rows.filter((r) => r.status !== "CANCELLED").reduce((s, r) => s + r.total, 0)),
        type: "money",
      },
      { label: "Pending", value: count("PENDING"), type: "number" },
      { label: "Confirmed", value: count("CONFIRMED"), type: "number" },
      { label: "Shipped", value: count("SHIPPED"), type: "number" },
      { label: "Delivered", value: count("DELIVERED"), type: "number" },
      { label: "Cancelled", value: count("CANCELLED"), type: "number" },
    ];
  }

  return {
    title: mode === "pending" ? "Pending Orders Report" : "Orders Report",
    columns,
    rows,
    summary,
  };
};

// ===================== 2. TOP CUSTOMERS =====================
const topCustomersReport = async (ctx) => {
  const data = await OrderModel.aggregate([
    { $match: orderMatch(ctx, { status: { $ne: "CANCELLED" } }) },
    { $sort: { createdAt: 1 } },
    {
      $group: {
        _id: "$userId",
        orders: { $sum: 1 },
        items: { $sum: "$totalItems" },
        spent: { $sum: "$totalAmount" },
        lastOrderAt: { $max: "$createdAt" },
        name: { $last: "$deliveryAddress.fullName" },
        phone: { $last: "$deliveryAddress.phone" },
      },
    },
    { $sort: { orders: -1, spent: -1 } },
    { $limit: parseTop(ctx.query.top) },
  ]);

  const users = await UserModel.find({ _id: { $in: data.map((d) => d._id) } })
    .select("name email")
    .lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  const rows = data.map((d, i) => {
    const u = userMap.get(String(d._id));
    return {
      rank: i + 1,
      customer: u?.name || d.name || "",
      phone: d.phone || "",
      email: u?.email || "",
      orders: d.orders,
      items: d.items,
      spent: round2(d.spent),
      lastOrderAt: d.lastOrderAt,
    };
  });

  return {
    title: "Top Customers Report",
    columns: [
      { key: "rank", header: "#", type: "number", width: 6 },
      { key: "customer", header: "Customer", type: "text", width: 24 },
      { key: "phone", header: "Phone", type: "text", width: 14 },
      { key: "email", header: "Email", type: "text", width: 28 },
      { key: "orders", header: "Orders", type: "number", width: 10 },
      { key: "items", header: "Items", type: "number", width: 10 },
      { key: "spent", header: "Total Spent", type: "money", width: 16 },
      { key: "lastOrderAt", header: "Last Order", type: "date", width: 14 },
    ],
    rows,
    summary: [
      { label: "Customers", value: rows.length, type: "number" },
      { label: "Orders", value: rows.reduce((s, r) => s + r.orders, 0), type: "number" },
      { label: "Revenue", value: round2(rows.reduce((s, r) => s + r.spent, 0)), type: "money" },
    ],
  };
};

// ===================== 3. MOST SELLING PRODUCTS =====================
const topProductsReport = async (ctx) => {
  const data = await OrderModel.aggregate([
    { $match: orderMatch(ctx, { status: { $ne: "CANCELLED" } }) },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.productId",
        storeId: { $first: "$storeId" },
        name: { $last: "$items.name" },
        productCode: { $last: "$items.productCode" },
        qty: { $sum: "$items.quantity" },
        orderIds: { $addToSet: "$_id" },
        revenue: {
          $sum: {
            $ifNull: ["$items.lineTotalWithGst", { $ifNull: ["$items.lineTotal", 0] }],
          },
        },
      },
    },
    { $addFields: { orders: { $size: "$orderIds" } } },
    { $project: { orderIds: 0 } },
    { $sort: { qty: -1, revenue: -1 } },
    { $limit: parseTop(ctx.query.top) },
  ]);

  const rows = data.map((d, i) => ({
    rank: i + 1,
    name: d.name,
    productCode: d.productCode || "",
    store: ctx.storeName.get(String(d.storeId)) || "",
    orders: d.orders,
    qty: d.qty,
    revenue: round2(d.revenue),
  }));

  return {
    title: "Most Selling Products Report",
    columns: [
      { key: "rank", header: "#", type: "number", width: 6 },
      { key: "name", header: "Product", type: "text", width: 34 },
      { key: "productCode", header: "Code", type: "text", width: 14 },
      STORE_COL,
      { key: "orders", header: "Orders", type: "number", width: 10 },
      { key: "qty", header: "Units Sold", type: "number", width: 12 },
      { key: "revenue", header: "Revenue (incl. GST)", type: "money", width: 20 },
    ],
    rows,
    summary: [
      { label: "Products sold", value: rows.length, type: "number" },
      { label: "Units sold", value: rows.reduce((s, r) => s + r.qty, 0), type: "number" },
      { label: "Revenue", value: round2(rows.reduce((s, r) => s + r.revenue, 0)), type: "money" },
    ],
  };
};

// ===================== 4. LOW STOCK =====================
const unitLabel = (v) => [v.color, v.size, v.weight, v.height].filter(Boolean).join(" / ") || "-";

// product / color variant / size variant, tin level er stock unit alada kore
const flattenUnits = (p) => {
  const out = [];
  const push = (variant, u) =>
    out.push({
      name: p.name,
      productCode: p.productCode || "",
      unit: p.unit || "",
      storeId: p.storeId,
      variant,
      sku: u.sku || "",
      currentStock: Number(u.currentStock || 0),
      threshold: Number(u.lowStockThreshold || 0),
    });

  if (Array.isArray(p.variants) && p.variants.length) {
    p.variants.forEach((v) => {
      if (v.isActive === false) return;
      if (Array.isArray(v.sizeVariants) && v.sizeVariants.length) {
        v.sizeVariants.forEach((sv) => {
          if (sv.isActive === false) return;
          push(unitLabel({ color: v.color, ...sv }), sv);
        });
      } else {
        push(unitLabel(v), v);
      }
    });
  } else {
    push("-", p);
  }
  return out;
};

const lowStockReport = async (ctx) => {
  const products = await ProductModel.find({
    storeId: { $in: ctx.storeIds },
    hasStockManagement: true,
  })
    .select(
      "name productCode unit storeId currentStock lowStockThreshold variants.color variants.size variants.weight variants.height variants.sku variants.currentStock variants.lowStockThreshold variants.isActive variants.sizeVariants",
    )
    .lean();

  let units = products.flatMap(flattenUnits).filter((u) => u.currentStock <= u.threshold);
  if (ctx.query.level === "out") units = units.filter((u) => u.currentStock <= 0);

  units.sort((a, b) => a.currentStock - b.currentStock || a.name.localeCompare(b.name));
  units = units.slice(0, MAX_ROWS);

  const rows = units.map((u) => ({
    name: u.name,
    productCode: u.productCode,
    store: ctx.storeName.get(String(u.storeId)) || "",
    variant: u.variant,
    sku: u.sku,
    currentStock: u.currentStock,
    threshold: u.threshold,
    status: u.currentStock <= 0 ? "Out of stock" : "Low stock",
  }));

  return {
    title: "Low Stock Report",
    columns: [
      { key: "name", header: "Product", type: "text", width: 32 },
      { key: "productCode", header: "Code", type: "text", width: 14 },
      STORE_COL,
      { key: "variant", header: "Variant", type: "text", width: 24 },
      { key: "sku", header: "SKU", type: "text", width: 14 },
      { key: "currentStock", header: "Current Stock", type: "number", width: 14 },
      { key: "threshold", header: "Low Stock Limit", type: "number", width: 14 },
      { key: "status", header: "Status", type: "text", width: 14 },
    ],
    rows,
    summary: [
      { label: "Items needing stock", value: rows.length, type: "number" },
      { label: "Out of stock", value: rows.filter((r) => r.currentStock <= 0).length, type: "number" },
      { label: "Low stock", value: rows.filter((r) => r.currentStock > 0).length, type: "number" },
    ],
  };
};

// ===================== 5. GST (product wise) =====================
const gstReport = async (ctx) => {
  const data = await OrderModel.aggregate([
    { $match: orderMatch(ctx, { status: { $ne: "CANCELLED" } }) },
    { $unwind: "$items" },
    { $match: { "items.gstAmount": { $gt: 0 } } },
    {
      $group: {
        _id: { p: "$items.productId", h: "$items.hsnCode" },
        storeId: { $first: "$storeId" },
        name: { $last: "$items.name" },
        productCode: { $last: "$items.productCode" },
        qty: { $sum: "$items.quantity" },
        taxable: {
          $sum: {
            $ifNull: ["$items.taxableAmount", { $ifNull: ["$items.lineTotal", 0] }],
          },
        },
        cgst: { $sum: "$items.cgstAmount" },
        sgst: { $sum: "$items.sgstAmount" },
        igst: { $sum: "$items.igstAmount" },
        gst: { $sum: "$items.gstAmount" },
        total: {
          $sum: {
            $ifNull: ["$items.lineTotalWithGst", { $ifNull: ["$items.lineTotal", 0] }],
          },
        },
      },
    },
    { $sort: { gst: -1 } },
    { $limit: MAX_ROWS },
  ]);

  const rows = data.map((d) => ({
    name: d.name,
    productCode: d.productCode || "",
    store: ctx.storeName.get(String(d.storeId)) || "",
    hsn: d._id.h || "",
    qty: d.qty,
    taxable: round2(d.taxable),
    rate: d.taxable > 0 ? round2((d.gst / d.taxable) * 100) : 0,
    cgst: round2(d.cgst),
    sgst: round2(d.sgst),
    igst: round2(d.igst),
    gst: round2(d.gst),
    total: round2(d.total),
  }));

  const sum = (k) => round2(rows.reduce((s, r) => s + r[k], 0));

  return {
    title: "GST Report (Product wise)",
    columns: [
      { key: "name", header: "Product", type: "text", width: 32 },
      { key: "productCode", header: "Code", type: "text", width: 14 },
      STORE_COL,
      { key: "hsn", header: "HSN", type: "text", width: 12 },
      { key: "qty", header: "Qty", type: "number", width: 8 },
      { key: "taxable", header: "Taxable Value", type: "money", width: 16 },
      { key: "rate", header: "GST Rate", type: "percent", width: 10 },
      { key: "cgst", header: "CGST", type: "money", width: 14 },
      { key: "sgst", header: "SGST", type: "money", width: 14 },
      { key: "igst", header: "IGST", type: "money", width: 14 },
      { key: "gst", header: "Total GST", type: "money", width: 14 },
      { key: "total", header: "Total (incl. GST)", type: "money", width: 18 },
    ],
    rows,
    summary: [
      { label: "Taxable value", value: sum("taxable"), type: "money" },
      { label: "CGST", value: sum("cgst"), type: "money" },
      { label: "SGST", value: sum("sgst"), type: "money" },
      { label: "IGST", value: sum("igst"), type: "money" },
      { label: "Total GST payable", value: sum("gst"), type: "money" },
    ],
  };
};

// ===================== 6. SHIPPING COST =====================
const shippingCostReport = async (ctx) => {
  const match = orderMatch(ctx, {
    "deliveryInfo.source": "SHIPROCKET",
    status: { $ne: "CANCELLED" },
  });
  if (ctx.query.booked === "true") match["shipment.awb"] = { $nin: [null, ""] };
  else if (ctx.query.booked === "false") match["shipment.awb"] = null;

  const orders = await OrderModel.find(match)
    .select(
      "orderNumber createdAt storeId status shippingCharge deliveryInfo.courierRate deliveryInfo.courierName deliveryInfo.courierMode shipment.awb shipment.status shipment.courierName",
    )
    .sort({ createdAt: -1, _id: -1 })
    .limit(MAX_ROWS)
    .lean();

  const rows = orders.map((o) => {
    const cost = round2(o.deliveryInfo?.courierRate);
    const paid = round2(o.shippingCharge);
    return {
      orderNumber: o.orderNumber,
      createdAt: o.createdAt,
      store: ctx.storeName.get(String(o.storeId)) || "",
      courier: o.shipment?.courierName || o.deliveryInfo?.courierName || "",
      awb: o.shipment?.awb || "Not booked",
      mode: o.deliveryInfo?.courierMode === "AIR" ? "Air" : o.deliveryInfo?.courierMode === "SURFACE" ? "Surface" : "",
      status: o.status,
      shipmentStatus: o.shipment?.status || "",
      customerPaid: paid,
      courierCost: cost,
      storeBears: round2(Math.max(0, cost - paid)),
    };
  });

  const sum = (k) => round2(rows.reduce((s, r) => s + r[k], 0));

  return {
    title: "Shipping Cost Report",
    columns: [
      { key: "orderNumber", header: "Order #", type: "text", width: 14 },
      { key: "createdAt", header: "Placed On", type: "date", width: 14 },
      STORE_COL,
      { key: "courier", header: "Courier", type: "text", width: 20 },
      { key: "awb", header: "AWB", type: "text", width: 18 },
      { key: "mode", header: "Mode", type: "text", width: 10 },
      { key: "status", header: "Order Status", type: "text", width: 14 },
      { key: "shipmentStatus", header: "Shipment Status", type: "text", width: 18 },
      { key: "customerPaid", header: "Customer Paid", type: "money", width: 14 },
      { key: "courierCost", header: "Courier Charge", type: "money", width: 14 },
      { key: "storeBears", header: "Store Bears", type: "money", width: 14 },
    ],
    rows,
    summary: [
      { label: "Orders", value: rows.length, type: "number" },
      { label: "Courier charge", value: sum("courierCost"), type: "money" },
      { label: "Customers paid", value: sum("customerPaid"), type: "money" },
      { label: "Store bears", value: sum("storeBears"), type: "money" },
    ],
  };
};

// ===================== registry =====================
const BUILDERS = {
  orders: ordersReport("all"),
  "pending-orders": ordersReport("pending"),
  "top-customers": topCustomersReport,
  "top-products": topProductsReport,
  "low-stock": lowStockReport,
  gst: gstReport,
  "shipping-cost": shippingCostReport,
};

// low stock ekhonkar obostha, tai period "Current stock"
const periodTextOf = (type, ctx) => (type === "low-stock" ? "Current stock" : ctx.range.text);

const run = async (req) => {
  const builder = BUILDERS[req.params.type];
  if (!builder) throw new ReportError(404, "Unknown report");
  const ctx = await getCtx(req);
  const report = await builder(ctx);
  return { ctx, report };
};

const handleError = (res, error, label) => {
  if (error instanceof ReportError) {
    return res.status(error.code).json({ success: false, message: error.message });
  }
  console.error(`${label}:`, error);
  return res.status(500).json({ success: false, message: error.message || "Internal server error" });
};

// ===================== GET /api/report/:type =====================
const getReport = async (req, res) => {
  try {
    const { ctx, report } = await run(req);

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
    const total = report.rows.length;

    return res.status(200).json({
      success: true,
      type: req.params.type,
      title: report.title,
      period: periodTextOf(req.params.type, ctx),
      columns: report.columns,
      summary: report.summary,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      truncated: total >= MAX_ROWS,
      rows: report.rows.slice((page - 1) * limit, page * limit),
    });
  } catch (error) {
    return handleError(res, error, "Get Report Error");
  }
};

// ===================== GET /api/report/:type/download?format=xlsx|csv|pdf =====================
const downloadReport = async (req, res) => {
  try {
    const format = String(req.query.format || "").toLowerCase();
    if (!FORMATS.includes(format)) {
      return res.status(400).json({ success: false, message: "format must be xlsx, csv or pdf" });
    }

    const { ctx, report } = await run(req);

    const file = await buildReportFile(format, report, {
      periodText: periodTextOf(req.params.type, ctx),
      storesText: ctx.stores.map((s) => s.storeName).join(", "),
    });

    const label = req.params.type === "low-stock" ? "current" : ctx.range.label;
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.params.type}-${label}.${file.ext}"`,
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(file.buffer);
  } catch (error) {
    return handleError(res, error, "Download Report Error");
  }
};

module.exports = { getReport, downloadReport };