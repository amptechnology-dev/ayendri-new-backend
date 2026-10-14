const mongoose = require("mongoose");
const { z } = require("zod");
const OrderModel = require("../model/order.model.js");
const StoreModel = require("../model/store.model.js");
const UserModel = require("../model/user.model.js");
const { PayoutModel, PAYOUT_METHODS } = require("../model/payout.model.js");

// ===================== HELPERS =====================
const MAX_LIMIT = 100;
const EPS = 0.005;

const STORE_SHARE = {
  $cond: [
    { $eq: ["$deliveryInfo.source", "SHIPROCKET"] },
    {
      $subtract: [
        "$totalAmount",
        {
          $max: [
            { $ifNull: ["$shippingCharge", 0] },
            { $ifNull: ["$deliveryInfo.courierRate", 0] },
          ],
        },
      ],
    },
    "$totalAmount",
  ],
};

const getUserId = (req) => req.user?._id || req.user?.id;
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sendError = (res, code, message, errors) =>
  res
    .status(code)
    .json({ success: false, message, ...(errors ? { errors } : {}) });

const handleError = (res, error, label) => {
  if (error.name === "ZodError") {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    });
  }
  console.error(`${label}:`, error);
  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

const parsePagination = (query) => {
  const pageNum = Math.max(parseInt(query.page) || 1, 1);
  const limitNum = Math.min(
    Math.max(parseInt(query.limit) || 10, 1),
    MAX_LIMIT,
  );
  return { pageNum, limitNum };
};

const getRole = async (req) => {
  if (req.user?.role) return req.user.role;
  const user = await UserModel.findById(getUserId(req)).select("role").lean();
  return user?.role || null;
};

// "YYYY-MM-DD" -> paidAt range (IST)
const parsePaidRange = (from, to) => {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const range = {};
  if (from) {
    if (!re.test(from)) return { error: "Invalid from date (use YYYY-MM-DD)" };
    range.$gte = new Date(`${from}T00:00:00.000+05:30`);
  }
  if (to) {
    if (!re.test(to)) return { error: "Invalid to date (use YYYY-MM-DD)" };
    range.$lte = new Date(`${to}T23:59:59.999+05:30`);
  }
  return { range: Object.keys(range).length ? range : null };
};

const maxDate = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

// ONLINE + PAID order er taka admin er kache ashe.
// CANCELLED hole oi taka customer ke refund korte hobe, tai store er pawna na (held).
const fetchTotalRows = async (storeIds) => {
  const [rec, pay] = await Promise.all([
    OrderModel.aggregate([
      {
        $match: {
          storeId: { $in: storeIds },
          paymentMethod: "ONLINE",
          paymentStatus: "PAID",
        },
      },
      {
        $group: {
          _id: "$storeId",
          received: {
            $sum: {
              $cond: [{ $ne: ["$status", "CANCELLED"] }, STORE_SHARE, 0],
            },
          },
          held: {
            $sum: {
              $cond: [{ $eq: ["$status", "CANCELLED"] }, "$totalAmount", 0],
            },
          },
          orders: { $sum: 1 },
          lastReceivedAt: { $max: "$paidAt" },
        },
      },
    ]),
    PayoutModel.aggregate([
      { $match: { storeId: { $in: storeIds }, isVoided: false } },
      {
        $group: {
          _id: "$storeId",
          paidOut: { $sum: "$amount" },
          payoutCount: { $sum: 1 },
          lastPayoutAt: { $max: "$paidAt" },
        },
      },
    ]),
  ]);

  return {
    rec: new Map(rec.map((r) => [String(r._id), r])),
    pay: new Map(pay.map((r) => [String(r._id), r])),
  };
};

// rec = { received, held, orders, lastReceivedAt }, pay = { paidOut, payoutCount, lastPayoutAt }
const buildSummary = (rec = {}, pay = {}) => {
  const totalReceived = round2(rec.received);
  const totalPaidOut = round2(pay.paidOut);
  return {
    totalReceived,
    onHoldAmount: round2(rec.held),
    totalPaidOut,
    // negative hole admin beshi diye felechhe (pore order cancel hole hote pare)
    balance: round2(totalReceived - totalPaidOut),
    onlineOrders: rec.orders || 0,
    payoutCount: pay.payoutCount || 0,
    lastReceivedAt: rec.lastReceivedAt || null,
    lastPayoutAt: pay.lastPayoutAt || null,
    settlementRate:
      totalReceived > 0
        ? round2(Math.min(100, (totalPaidOut / totalReceived) * 100))
        : 0,
  };
};

const summaryForStores = (maps, ids) => {
  const rec = { received: 0, held: 0, orders: 0, lastReceivedAt: null };
  const pay = { paidOut: 0, payoutCount: 0, lastPayoutAt: null };
  ids.forEach((id) => {
    const r = maps.rec.get(String(id));
    const p = maps.pay.get(String(id));
    if (r) {
      rec.received += r.received;
      rec.held += r.held;
      rec.orders += r.orders;
      rec.lastReceivedAt = maxDate(rec.lastReceivedAt, r.lastReceivedAt);
    }
    if (p) {
      pay.paidOut += p.paidOut;
      pay.payoutCount += p.payoutCount;
      pay.lastPayoutAt = maxDate(pay.lastPayoutAt, p.lastPayoutAt);
    }
  });
  return buildSummary(rec, pay);
};

const formatPayout = (p, { withAdmin = false } = {}) => {
  const store = p.storeId && p.storeId.storeName ? p.storeId : null;
  return {
    payoutId: p._id,
    payoutNumber: p.payoutNumber,
    storeId: store ? store._id : p.storeId,
    storeName: store?.storeName || null,
    storeUniqueId: store?.storeUniqueId || null,
    amount: p.amount,
    method: p.method,
    referenceNo: p.referenceNo,
    note: p.note,
    paidAt: p.paidAt,
    balanceBefore: p.balanceBefore,
    balanceAfter: p.balanceAfter,
    isVoided: p.isVoided,
    voidReason: p.isVoided ? p.voidReason : null,
    voidedAt: p.isVoided ? p.voidedAt : null,
    ...(withAdmin ? { paidByName: p.paidBy?.name || null } : {}),
    createdAt: p.createdAt,
  };
};

// ===================== VALIDATION =====================
const createPayoutSchema = z.object({
  amount: z.coerce
    .number({ invalid_type_error: "Enter a valid amount" })
    .positive("Amount must be greater than 0"),
  method: z.enum(PAYOUT_METHODS).default("BANK_TRANSFER"),
  referenceNo: z.string().trim().max(100).optional(),
  note: z.string().trim().max(300).optional(),
  paidAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional(),
});

const voidPayoutSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Reason must be at least 3 characters")
    .max(300),
});

// ===================== ADMIN 1. STORE LIST =====================
// GET /api/payment/payout/stores
// query: page, limit, search, onlyPending=true, sortBy (balance_desc|received_desc|paid_desc|name_asc)
const getPayoutStores = async (req, res) => {
  try {
    const { pageNum, limitNum } = parsePagination(req.query);
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const onlyPending = req.query.onlyPending === "true";

    const SORT_MAP = {
      balance_desc: { balance: -1 },
      received_desc: { received: -1 },
      paid_desc: { paidOut: -1 },
      name_asc: { storeName: 1 },
    };
    const sort = {
      ...(SORT_MAP[req.query.sortBy] || SORT_MAP.balance_desc),
      _id: 1,
    };

    const storeMatch = {};
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      storeMatch.$or = [{ storeName: rx }, { storeUniqueId: rx }];
    }

    const pick = (arr, field, fallback = 0) => ({
      $ifNull: [{ $arrayElemAt: [`$${arr}.${field}`, 0] }, fallback],
    });

    const pipeline = [
      { $match: storeMatch },
      {
        $lookup: {
          from: OrderModel.collection.name,
          let: { sid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$storeId", "$$sid"] },
                paymentMethod: "ONLINE",
                paymentStatus: "PAID",
              },
            },
            {
              $group: {
                _id: null,
                received: {
                  $sum: {
                    $cond: [{ $ne: ["$status", "CANCELLED"] }, STORE_SHARE, 0],
                  },
                },
                held: {
                  $sum: {
                    $cond: [
                      { $eq: ["$status", "CANCELLED"] },
                      "$totalAmount",
                      0,
                    ],
                  },
                },
                orders: { $sum: 1 },
                lastReceivedAt: { $max: "$paidAt" },
              },
            },
          ],
          as: "rec",
        },
      },
      {
        $lookup: {
          from: PayoutModel.collection.name,
          let: { sid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$storeId", "$$sid"] },
                isVoided: false,
              },
            },
            {
              $group: {
                _id: null,
                paidOut: { $sum: "$amount" },
                payoutCount: { $sum: 1 },
                lastPayoutAt: { $max: "$paidAt" },
              },
            },
          ],
          as: "pay",
        },
      },
      {
        $addFields: {
          received: pick("rec", "received"),
          held: pick("rec", "held"),
          orders: pick("rec", "orders"),
          lastReceivedAt: pick("rec", "lastReceivedAt", null),
          paidOut: pick("pay", "paidOut"),
          payoutCount: pick("pay", "payoutCount"),
          lastPayoutAt: pick("pay", "lastPayoutAt", null),
        },
      },
      { $addFields: { balance: { $subtract: ["$received", "$paidOut"] } } },
      {
        $project: {
          storeName: 1,
          storeUniqueId: 1,
          isActive: 1,
          isVerify: 1,
          received: 1,
          held: 1,
          orders: 1,
          lastReceivedAt: 1,
          paidOut: 1,
          payoutCount: 1,
          lastPayoutAt: 1,
          balance: 1,
        },
      },
    ];

    if (onlyPending) pipeline.push({ $match: { balance: { $gt: EPS } } });

    pipeline.push(
      { $sort: sort },
      {
        $facet: {
          data: [{ $skip: (pageNum - 1) * limitNum }, { $limit: limitNum }],
          totalCount: [{ $count: "count" }],
          overall: [
            {
              $group: {
                _id: null,
                received: { $sum: "$received" },
                held: { $sum: "$held" },
                orders: { $sum: "$orders" },
                lastReceivedAt: { $max: "$lastReceivedAt" },
                paidOut: { $sum: "$paidOut" },
                payoutCount: { $sum: "$payoutCount" },
                lastPayoutAt: { $max: "$lastPayoutAt" },
                pendingStores: {
                  $sum: { $cond: [{ $gt: ["$balance", EPS] }, 1, 0] },
                },
              },
            },
          ],
        },
      },
    );

    const [result] = await StoreModel.aggregate(pipeline);
    const totalStores = result?.totalCount?.[0]?.count || 0;
    const overall = result?.overall?.[0] || {};

    const stores = (result?.data || []).map((s) => ({
      storeId: s._id,
      storeName: s.storeName,
      storeUniqueId: s.storeUniqueId,
      isActive: s.isActive,
      isVerify: s.isVerify,
      ...buildSummary(s, s),
    }));

    return res.status(200).json({
      success: true,
      page: pageNum,
      limit: limitNum,
      totalStores,
      totalPages: Math.ceil(totalStores / limitNum),
      summary: {
        ...buildSummary(overall, overall),
        pendingStores: overall.pendingStores || 0,
      },
      stores,
    });
  } catch (error) {
    return handleError(res, error, "Get Payout Stores Error");
  }
};

// ===================== ADMIN 2. STORE DETAIL + HISTORY =====================
// GET /api/payment/payout/stores/:storeId
// query: page, limit, from, to (paidAt)
const getPayoutStoreDetail = async (req, res) => {
  try {
    const { storeId } = req.params;
    if (!mongoose.isValidObjectId(storeId)) {
      return sendError(res, 400, "Invalid store id");
    }

    const store = await StoreModel.findById(storeId)
      .select("storeName storeUniqueId isActive isVerify")
      .lean();
    if (!store) return sendError(res, 404, "Store not found");

    const { range, error } = parsePaidRange(req.query.from, req.query.to);
    if (error) return sendError(res, 400, error);

    const match = { storeId: store._id };
    if (range) match.paidAt = range;

    const { pageNum, limitNum } = parsePagination(req.query);

    const [maps, payouts, totalPayouts] = await Promise.all([
      fetchTotalRows([store._id]),
      PayoutModel.find(match)
        .populate("paidBy", "name")
        .sort({ paidAt: -1, createdAt: -1, _id: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      PayoutModel.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      store: {
        storeId: store._id,
        storeName: store.storeName,
        storeUniqueId: store.storeUniqueId,
      },
      summary: summaryForStores(maps, [store._id]),
      page: pageNum,
      limit: limitNum,
      totalPayouts,
      totalPages: Math.ceil(totalPayouts / limitNum),
      payouts: payouts.map((p) => formatPayout(p, { withAdmin: true })),
    });
  } catch (error) {
    return handleError(res, error, "Get Payout Store Detail Error");
  }
};

// ===================== ADMIN 3. CREATE PAYOUT =====================
// POST /api/payment/payout/stores/:storeId
// body: { amount, method?, referenceNo?, note?, paidAt? (YYYY-MM-DD) }
const createPayout = async (req, res) => {
  try {
    const { storeId } = req.params;
    const adminId = getUserId(req);

    if (!mongoose.isValidObjectId(storeId)) {
      return sendError(res, 400, "Invalid store id");
    }

    const body = createPayoutSchema.parse(req.body || {});
    const amount = round2(body.amount);

    const store = await StoreModel.findById(storeId)
      .select("storeName storeUniqueId")
      .lean();
    if (!store) return sendError(res, 404, "Store not found");

    let paidAt = new Date();
    if (body.paidAt) {
      paidAt = new Date(`${body.paidAt}T00:00:00.000+05:30`);
      if (paidAt > new Date()) {
        return sendError(res, 400, "Validation failed", [
          { field: "paidAt", message: "Payout date cannot be in the future" },
        ]);
      }
    }

    // pending balance er beshi deya jabe na
    const maps = await fetchTotalRows([store._id]);
    const before = summaryForStores(maps, [store._id]);

    if (before.balance <= EPS) {
      return sendError(res, 400, "Validation failed", [
        { field: "amount", message: "No pending balance for this store" },
      ]);
    }
    if (amount > before.balance + EPS) {
      return sendError(res, 400, "Validation failed", [
        {
          field: "amount",
          message: `Amount exceeds pending balance (₹${before.balance.toFixed(2)})`,
        },
      ]);
    }

    const payout = await PayoutModel.create({
      storeId: store._id,
      amount,
      method: body.method,
      referenceNo: body.referenceNo || null,
      note: body.note || null,
      paidAt,
      paidBy: adminId,
      balanceBefore: before.balance,
      balanceAfter: round2(before.balance - amount),
    });

    const fresh = await fetchTotalRows([store._id]);

    return res.status(201).json({
      success: true,
      message: `₹${amount.toFixed(2)} paid to ${store.storeName}`,
      payout: formatPayout(payout.toObject()),
      summary: summaryForStores(fresh, [store._id]),
    });
  } catch (error) {
    return handleError(res, error, "Create Payout Error");
  }
};

// ===================== ADMIN 4. VOID PAYOUT =====================
// PATCH /api/payment/payout/:payoutId/void   body: { reason }
const voidPayout = async (req, res) => {
  try {
    const { payoutId } = req.params;
    if (!mongoose.isValidObjectId(payoutId)) {
      return sendError(res, 400, "Invalid payout id");
    }

    const { reason } = voidPayoutSchema.parse(req.body || {});

    // atomic: ekbar-i void hobe
    const payout = await PayoutModel.findOneAndUpdate(
      { _id: payoutId, isVoided: false },
      {
        $set: {
          isVoided: true,
          voidReason: reason,
          voidedAt: new Date(),
          voidedBy: getUserId(req),
        },
      },
      { new: true },
    ).lean();

    if (!payout) {
      return sendError(res, 409, "Payout not found or already voided");
    }

    const maps = await fetchTotalRows([payout.storeId]);

    return res.status(200).json({
      success: true,
      message: "Payout voided",
      payout: formatPayout(payout),
      summary: summaryForStores(maps, [payout.storeId]),
    });
  } catch (error) {
    return handleError(res, error, "Void Payout Error");
  }
};

// ===================== STORE: MY PAYOUTS =====================
// GET /api/payment/payout/my
// query: page, limit, storeId (optional), from, to
const getMyPayouts = async (req, res) => {
  try {
    const stores = await StoreModel.find({ userId: getUserId(req) })
      .select("storeName storeUniqueId")
      .lean();

    let scoped = stores;
    const { storeId } = req.query;
    if (storeId) {
      if (!mongoose.isValidObjectId(storeId)) {
        return sendError(res, 400, "Invalid store id");
      }
      scoped = stores.filter((s) => String(s._id) === String(storeId));
      if (!scoped.length) {
        return sendError(res, 403, "Not authorized for this store");
      }
    }
    const ids = scoped.map((s) => s._id);

    const { range, error } = parsePaidRange(req.query.from, req.query.to);
    if (error) return sendError(res, 400, error);

    const match = { storeId: { $in: ids } };
    if (range) match.paidAt = range;

    const { pageNum, limitNum } = parsePagination(req.query);

    const [maps, payouts, totalPayouts] = await Promise.all([
      fetchTotalRows(ids),
      PayoutModel.find(match)
        .populate("storeId", "storeName storeUniqueId")
        .sort({ paidAt: -1, createdAt: -1, _id: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      PayoutModel.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      summary: summaryForStores(maps, ids),
      stores: scoped.map((s) => ({
        storeId: s._id,
        storeName: s.storeName,
        storeUniqueId: s.storeUniqueId,
        ...summaryForStores(maps, [s._id]),
      })),
      page: pageNum,
      limit: limitNum,
      totalPayouts,
      totalPages: Math.ceil(totalPayouts / limitNum),
      payouts: payouts.map((p) => formatPayout(p)),
    });
  } catch (error) {
    return handleError(res, error, "Get My Payouts Error");
  }
};

module.exports = {
  getPayoutStores,
  getPayoutStoreDetail,
  createPayout,
  voidPayout,
  getMyPayouts,
};
