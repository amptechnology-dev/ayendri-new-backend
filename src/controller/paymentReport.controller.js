const mongoose = require("mongoose");
const OrderModel = require("../model/order.model.js");
const StoreModel = require("../model/store.model.js");
const UserModel = require("../model/user.model.js");

const { ObjectId } = mongoose.Types;

// ===================== CONSTANTS / HELPERS =====================
const MAX_LIMIT = 100;
const PAYMENT_METHODS = ["COD", "ONLINE"];
const PAYMENT_STATUSES = ["PENDING", "INITIATED", "PAID", "FAILED", "REFUNDED"];
const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
];

// due = taka ekhono paoa jayni
const DUE_PAYMENT_STATUSES = ["PENDING", "INITIATED", "FAILED"];
// price fixed hoyeche emon order (quote pending order due te dhora hobe na)
const PRICED_STATUSES = ["NOT_REQUIRED", "CONFIRMED"];
const QUOTE_STATUSES = ["AWAITING_QUOTE", "QUOTED"];

const COUNT_FIELDS = [
  "totalOrders",
  "paidOrders",
  "dueOrders",
  "awaitingQuoteOrders",
];
const MONEY_FIELDS = [
  "paidAmount",
  "dueAmount",
  "codPaid",
  "onlinePaid",
  "codDue",
  "onlineDue",
  "refundedAmount",
  "cancelledAmount",
];

const getUserId = (req) => req.user?._id || req.user?.id;
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sendError = (res, code, message) =>
  res.status(code).json({ success: false, message });

const handleError = (res, error, label) => {
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

// "YYYY-MM-DD" -> IST day start / end
const parseDateRange = (from, to) => {
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
  return Object.keys(range).length ? { createdAt: range } : {};
};

// [ROLE] req.user e role thakle seta, nahole DB theke
const getRole = async (req) => {
  if (req.user?.role) return req.user.role;
  const user = await UserModel.findById(getUserId(req)).select("role").lean();
  return user?.role || null;
};

// ---------- scope ----------
// STORE : nijer store gulo (storeId dile sudhu oi ta, nijer na hole 403)
// ADMIN : shob store (storeIds = null mane "shob store"), storeId dile sudhu oi store
const resolveScope = async (req, storeId) => {
  const role = await getRole(req);
  const hasStoreId = storeId !== undefined && storeId !== "";

  if (hasStoreId && !mongoose.isValidObjectId(storeId)) {
    return { error: { code: 400, message: "Invalid store id" } };
  }

  if (role === "ADMIN") {
    if (!hasStoreId) return { role, stores: null, storeIds: null };

    const store = await StoreModel.findById(storeId)
      .select("storeName storeUniqueId isActive isVerify")
      .lean();
    if (!store) return { error: { code: 404, message: "Store not found" } };
    return { role, stores: [store], storeIds: [store._id] };
  }

  if (role !== "STORE") {
    return { error: { code: 403, message: "Not authorized" } };
  }

  const userId = getUserId(req);
  const stores = await StoreModel.find({ userId })
    .select("storeName storeUniqueId isActive isVerify")
    .lean();

  if (hasStoreId) {
    const store = stores.find((s) => String(s._id) === String(storeId));
    if (!store) {
      return { error: { code: 403, message: "Not authorized for this store" } };
    }
    return { role, stores: [store], storeIds: [store._id] };
  }

  return { role, stores, storeIds: stores.map((s) => s._id) };
};

const buildMatch = (storeIds, query, extra = {}) => {
  const match = { ...extra };
  // storeIds null = ADMIN, shob store
  if (storeIds) match.storeId = { $in: storeIds };

  // [PAYMENT OFF] jei store e payment off, tader order payment report e dhora hobe na
  match.paymentOff = { $ne: true };

  const range = parseDateRange(query.from, query.to);
  if (range.error) return { error: range.error };
  if (range.createdAt) match.createdAt = range.createdAt;

  if (query.paymentMethod) {
    if (!PAYMENT_METHODS.includes(query.paymentMethod)) {
      return { error: "Invalid paymentMethod" };
    }
    match.paymentMethod = query.paymentMethod;
  }
  if (query.paymentStatus) {
    if (!PAYMENT_STATUSES.includes(query.paymentStatus)) {
      return { error: "Invalid paymentStatus" };
    }
    match.paymentStatus = query.paymentStatus;
  }
  if (query.status) {
    if (!ORDER_STATUSES.includes(query.status)) {
      return { error: "Invalid status" };
    }
    match.status = query.status;
  }

  return { match };
};

// ===================== AGGREGATION CONDITIONS =====================
const C = {
  paid: { $eq: ["$paymentStatus", "PAID"] },
  due: {
    $and: [
      { $ne: ["$status", "CANCELLED"] },
      { $in: ["$paymentStatus", DUE_PAYMENT_STATUSES] },
      { $in: ["$priceStatus", PRICED_STATUSES] },
    ],
  },
  awaitingQuote: {
    $and: [
      { $ne: ["$status", "CANCELLED"] },
      { $in: ["$paymentStatus", DUE_PAYMENT_STATUSES] },
      { $in: ["$priceStatus", QUOTE_STATUSES] },
    ],
  },
  refunded: { $eq: ["$paymentStatus", "REFUNDED"] },
  cancelledUnpaid: {
    $and: [
      { $eq: ["$status", "CANCELLED"] },
      { $in: ["$paymentStatus", DUE_PAYMENT_STATUSES] },
    ],
  },
  cod: { $eq: ["$paymentMethod", "COD"] },
  online: { $eq: ["$paymentMethod", "ONLINE"] },
};

const both = (a, b) => ({ $and: [a, b] });
const sumIf = (cond) => ({ $sum: { $cond: [cond, "$totalAmount", 0] } });
const countIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });

// $group stage er accumulators (customer / store / overall, shobar jonno same)
const summaryAcc = () => ({
  totalOrders: { $sum: 1 },
  paidAmount: sumIf(C.paid),
  paidOrders: countIf(C.paid),
  dueAmount: sumIf(C.due),
  dueOrders: countIf(C.due),
  codPaid: sumIf(both(C.paid, C.cod)),
  onlinePaid: sumIf(both(C.paid, C.online)),
  codDue: sumIf(both(C.due, C.cod)),
  onlineDue: sumIf(both(C.due, C.online)),
  refundedAmount: sumIf(C.refunded),
  cancelledAmount: sumIf(C.cancelledUnpaid),
  awaitingQuoteOrders: countIf(C.awaitingQuote),
  lastPaymentAt: { $max: "$paidAt" },
});

const formatSummary = (d = {}) => {
  const out = { lastPaymentAt: d.lastPaymentAt || null };
  COUNT_FIELDS.forEach((k) => (out[k] = d[k] || 0));
  MONEY_FIELDS.forEach((k) => (out[k] = round2(d[k])));
  out.totalBilled = round2(out.paidAmount + out.dueAmount);
  out.collectionRate =
    out.totalBilled > 0 ? round2((out.paidAmount / out.totalBilled) * 100) : 0;
  return out;
};

// JS side e same "due" logic (order list row er jonno)
const isDueOrder = (o) =>
  o.status !== "CANCELLED" &&
  DUE_PAYMENT_STATUSES.includes(o.paymentStatus) &&
  PRICED_STATUSES.includes(o.priceStatus);

const formatOrderRow = (o) => {
  const paid = o.paymentStatus === "PAID";
  const populated = o.userId && o.userId.name !== undefined;
  return {
    orderId: o._id,
    orderNumber: o.orderNumber,
    createdAt: o.createdAt,
    storeId: o.storeId,
    storeName: o.storeName,
    storeUniqueId: o.storeUniqueId,
    customer: populated
      ? {
          _id: o.userId._id,
          name: o.userId.name,
          phone: o.userId.phone,
          email: o.userId.email,
        }
      : { _id: o.userId, name: o.deliveryAddress?.fullName || null },
    status: o.status,
    priceStatus: o.priceStatus,
    totalAmount: o.totalAmount,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    paidAmount: paid ? o.totalAmount : 0,
    dueAmount: isDueOrder(o) ? o.totalAmount : 0,
    paidAt: o.paidAt,
    paymentExpiresAt: o.paymentExpiresAt,
    paymentAttempts: o.paymentAttempts || [],
  };
};

const ORDER_ROW_FIELDS =
  "orderNumber createdAt storeId storeName storeUniqueId userId deliveryAddress status priceStatus totalAmount paymentMethod paymentStatus paidAt paymentExpiresAt paymentAttempts";

const overallSummary = async (match) => {
  const [row] = await OrderModel.aggregate([
    { $match: match },
    { $group: { _id: null, ...summaryAcc() } },
  ]);
  return formatSummary(row);
};

// ===================== 0. META (role + own stores) =====================
// GET /api/payment/report/meta   (STORE, ADMIN)
// frontend ei role dekhe STORE view / ADMIN view dekhay
const getReportMeta = async (req, res) => {
  try {
    const role = await getRole(req);
    if (role !== "STORE" && role !== "ADMIN") {
      return sendError(res, 403, "Not authorized");
    }

    let stores = [];
    if (role === "STORE") {
      const owned = await StoreModel.find({ userId: getUserId(req) })
        .select("storeName storeUniqueId")
        .lean();
      stores = owned.map((s) => ({
        _id: s._id,
        storeName: s.storeName,
        storeUniqueId: s.storeUniqueId,
      }));
    }

    return res.status(200).json({ success: true, role, stores });
  } catch (error) {
    return handleError(res, error, "Payment Report Meta Error");
  }
};

// ===================== 1. CUSTOMER WISE REPORT (STORE) =====================
// GET /api/payment/report/customers
// query: page, limit, search, storeId, from, to, paymentMethod, onlyDue=true, sortBy
const getCustomerPaymentReport = async (req, res) => {
  try {
    const scope = await resolveScope(req, req.query.storeId);
    if (scope.error) return sendError(res, scope.error.code, scope.error.message);

    const built = buildMatch(scope.storeIds, req.query);
    if (built.error) return sendError(res, 400, built.error);
    const { match } = built;

    const { pageNum, limitNum } = parsePagination(req.query);
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const onlyDue = req.query.onlyDue === "true";

    const SORT_MAP = {
      due_desc: { dueAmount: -1 },
      paid_desc: { paidAmount: -1 },
      latest: { lastOrderAt: -1 },
      name_asc: { customerName: 1 },
    };
    const sort = { ...(SORT_MAP[req.query.sortBy] || SORT_MAP.due_desc), _id: 1 };

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: "$userId",
          ...summaryAcc(),
          lastOrderAt: { $max: "$createdAt" },
          fallbackName: { $last: "$deliveryAddress.fullName" },
          fallbackPhone: { $last: "$deliveryAddress.phone" },
        },
      },
      ...(onlyDue ? [{ $match: { dueAmount: { $gt: 0 } } }] : []),
      {
        $lookup: {
          from: "users",
          let: { uid: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$_id", "$$uid"] } } },
            { $project: { name: 1, phone: 1, email: 1 } },
          ],
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          customerName: { $ifNull: ["$user.name", "$fallbackName"] },
          customerPhone: { $ifNull: ["$user.phone", "$fallbackPhone"] },
          customerEmail: "$user.email",
        },
      },
    ];

    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      pipeline.push({
        $match: {
          $or: [
            { customerName: rx },
            { customerPhone: rx },
            { customerEmail: rx },
          ],
        },
      });
    }

    pipeline.push(
      { $sort: sort },
      {
        $facet: {
          data: [{ $skip: (pageNum - 1) * limitNum }, { $limit: limitNum }],
          totalCount: [{ $count: "count" }],
        },
      },
    );

    const [[result], summary] = await Promise.all([
      OrderModel.aggregate(pipeline),
      overallSummary(match),
    ]);

    const totalCustomers = result?.totalCount?.[0]?.count || 0;
    const customers = (result?.data || []).map((c) => ({
      customerId: c._id,
      name: c.customerName || null,
      phone: c.customerPhone || null,
      email: c.customerEmail || null,
      lastOrderAt: c.lastOrderAt,
      ...formatSummary(c),
    }));

    return res.status(200).json({
      success: true,
      page: pageNum,
      limit: limitNum,
      totalCustomers,
      totalPages: Math.ceil(totalCustomers / limitNum),
      summary,
      customers,
    });
  } catch (error) {
    return handleError(res, error, "Customer Payment Report Error");
  }
};

// ===================== 2. SINGLE CUSTOMER DETAIL (STORE) =====================
// GET /api/payment/report/customers/:customerId
// query: page, limit, storeId, from, to, paymentMethod, paymentStatus, status
const getCustomerPaymentDetail = async (req, res) => {
  try {
    const { customerId } = req.params;
    if (!mongoose.isValidObjectId(customerId)) {
      return sendError(res, 400, "Invalid customer id");
    }

    const scope = await resolveScope(req, req.query.storeId);
    if (scope.error) return sendError(res, scope.error.code, scope.error.message);

    const built = buildMatch(scope.storeIds, req.query, {
      userId: new ObjectId(customerId),
    });
    if (built.error) return sendError(res, 400, built.error);
    const { match } = built;

    const { pageNum, limitNum } = parsePagination(req.query);

    const [customer, summary, orders, totalOrders] = await Promise.all([
      UserModel.findById(customerId).select("name phone email picture").lean(),
      overallSummary(match),
      OrderModel.find(match)
        .select(ORDER_ROW_FIELDS)
        .sort({ createdAt: -1, _id: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      OrderModel.countDocuments(match),
    ]);

    if (!customer && totalOrders === 0) {
      return sendError(res, 404, "No payment records for this customer");
    }

    return res.status(200).json({
      success: true,
      customer,
      summary,
      page: pageNum,
      limit: limitNum,
      totalOrders,
      totalPages: Math.ceil(totalOrders / limitNum),
      orders: orders.map(formatOrderRow),
    });
  } catch (error) {
    return handleError(res, error, "Customer Payment Detail Error");
  }
};

// ===================== 3. STORE WISE REPORT (ADMIN + STORE) =====================
// GET /api/payment/report/stores
// ADMIN : shob store er payment (kon store theke koto eseche)
// STORE : sudhu nijer store gulo
// query: page, limit, search (store name / id), storeId, from, to, paymentMethod, sortBy
const getStorePaymentReport = async (req, res) => {
  try {
    const scope = await resolveScope(req, req.query.storeId);
    if (scope.error) return sendError(res, scope.error.code, scope.error.message);

    const built = buildMatch(scope.storeIds, req.query);
    if (built.error) return sendError(res, 400, built.error);
    const { match } = built;

    const { pageNum, limitNum } = parsePagination(req.query);
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    const SORT_MAP = {
      paid_desc: { paidAmount: -1 },
      due_desc: { dueAmount: -1 },
      orders_desc: { totalOrders: -1 },
      name_asc: { storeName: 1 },
    };
    const sort = { ...(SORT_MAP[req.query.sortBy] || SORT_MAP.paid_desc), _id: 1 };

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: "$storeId",
          ...summaryAcc(),
          customerIds: { $addToSet: "$userId" },
        },
      },
      {
        $lookup: {
          from: "stores",
          localField: "_id",
          foreignField: "_id",
          as: "store",
        },
      },
      { $unwind: { path: "$store", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          storeName: { $ifNull: ["$store.storeName", ""] },
          storeUniqueId: { $ifNull: ["$store.storeUniqueId", ""] },
          totalCustomers: { $size: "$customerIds" },
        },
      },
      { $project: { customerIds: 0 } },
    ];

    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      pipeline.push({
        $match: { $or: [{ storeName: rx }, { storeUniqueId: rx }] },
      });
    }

    pipeline.push(
      { $sort: sort },
      {
        $facet: {
          data: [{ $skip: (pageNum - 1) * limitNum }, { $limit: limitNum }],
          totalCount: [{ $count: "count" }],
        },
      },
    );

    const [[result], summary] = await Promise.all([
      OrderModel.aggregate(pipeline),
      overallSummary(match),
    ]);

    const totalStores = result?.totalCount?.[0]?.count || 0;
    const stores = (result?.data || []).map((s) => ({
      storeId: s._id,
      storeName: s.storeName,
      storeUniqueId: s.storeUniqueId,
      isActive: s.store?.isActive ?? null,
      isVerify: s.store?.isVerify ?? null,
      totalCustomers: s.totalCustomers || 0,
      ...formatSummary(s),
    }));

    return res.status(200).json({
      success: true,
      page: pageNum,
      limit: limitNum,
      totalStores,
      totalPages: Math.ceil(totalStores / limitNum),
      count: stores.length,
      summary,
      stores,
    });
  } catch (error) {
    return handleError(res, error, "Store Payment Report Error");
  }
};

// ===================== 4. SINGLE STORE FULL DETAIL (ADMIN + STORE) =====================
// GET /api/payment/report/stores/:storeId
// query: page, limit, search, from, to, paymentMethod, paymentStatus, status
const getStorePaymentDetail = async (req, res) => {
  try {
    const scope = await resolveScope(req, req.params.storeId);
    if (scope.error) return sendError(res, scope.error.code, scope.error.message);

    const built = buildMatch(scope.storeIds, req.query);
    if (built.error) return sendError(res, 400, built.error);
    const { match } = built;

    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const listMatch = { ...match };
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      listMatch.$or = [
        { orderNumber: rx },
        { "deliveryAddress.fullName": rx },
        { "deliveryAddress.phone": rx },
      ];
    }

    const { pageNum, limitNum } = parsePagination(req.query);

    const [summary, monthly, orders, totalOrders] = await Promise.all([
      overallSummary(match),
      // mash-wise collection (last 12 month, paidAt onujayi, IST)
      OrderModel.aggregate([
        { $match: { ...match, paymentStatus: "PAID", paidAt: { $ne: null } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m",
                date: "$paidAt",
                timezone: "Asia/Kolkata",
              },
            },
            amount: { $sum: "$totalAmount" },
            orders: { $sum: 1 },
          },
        },
        { $sort: { _id: -1 } },
        { $limit: 12 },
      ]),
      OrderModel.find(listMatch)
        .select(ORDER_ROW_FIELDS)
        .populate("userId", "name phone email")
        .sort({ createdAt: -1, _id: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      OrderModel.countDocuments(listMatch),
    ]);

    const store = scope.stores[0];

    return res.status(200).json({
      success: true,
      store: {
        storeId: store._id,
        storeName: store.storeName,
        storeUniqueId: store.storeUniqueId,
      },
      summary,
      monthlyCollection: monthly.map((m) => ({
        month: m._id,
        amount: round2(m.amount),
        orders: m.orders,
      })),
      page: pageNum,
      limit: limitNum,
      totalOrders,
      totalPages: Math.ceil(totalOrders / limitNum),
      transactions: orders.map(formatOrderRow),
    });
  } catch (error) {
    return handleError(res, error, "Store Payment Detail Error");
  }
};

module.exports = {
  getReportMeta,
  getCustomerPaymentReport,
  getCustomerPaymentDetail,
  getStorePaymentReport,
  getStorePaymentDetail,
};