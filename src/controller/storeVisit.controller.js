const mongoose = require("mongoose");
const StoreModel = require("../model/store.model.js");
const StoreVisitModel = require("../model/storeVisit.model.js");
const UserModel = require("../model/user.model.js");
const OrderModel = require("../model/order.model.js");

const getUserId = (req) => req.user?._id || req.user?.id;

const escapeRegex = (str = "") => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const USER_DETAIL_FIELDS =
  "name email phone picture role provider address isActive isVerified createdAt";

/* ================= MASKING ================= */

// "Mithun Ray" -> "M**** Ray"
const maskName = (name = "") => {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const first = `${parts[0][0]}****`;
  return parts.length > 1 ? `${first} ${parts[parts.length - 1]}` : first;
};

// "9830012335" -> "XXXXX35"
const maskPhone = (phone) => {
  if (!phone) return "";
  return `XXXXX${String(phone).trim().slice(-2)}`;
};

// "abc@gmail.com" -> "XXXXX.com"
const maskEmail = (email) => {
  if (!email) return "";
  const value = String(email).trim();
  const dot = value.lastIndexOf(".");
  return `XXXXX${dot > -1 ? value.slice(dot) : ""}`;
};

const maskUser = (user) => ({
  ...user,
  name: maskName(user.name),
  email: maskEmail(user.email),
  phone: maskPhone(user.phone),
  picture: null,
});

/* ================= HELPERS ================= */

const parsePaging = (query) => {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit) || 10, 1), 50);
  const search = String(query.search || "").trim();
  return { page, limit, search };
};

// owner er store id gulo, optional storeId filter shoho (nijer store hole)
const resolveOwnedStoreIds = async (ownerId, storeId) => {
  const owned = await StoreModel.find({ userId: ownerId })
    .select("_id")
    .lean();
  let ids = owned.map((s) => s._id);

  if (storeId) {
    if (!mongoose.isValidObjectId(storeId)) {
      return { error: { status: 400, message: "Invalid store id" } };
    }
    if (!ids.some((id) => String(id) === String(storeId))) {
      return {
        error: {
          status: 403,
          message: "Store not found or not owned by you",
        },
      };
    }
    ids = [new mongoose.Types.ObjectId(storeId)];
  }

  return { ids };
};

const serverError = (res, label, error) => {
  console.error(`${label}:`, error);
  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

/* ================= REGISTER VISIT (mobile app) ================= */

// POST /api/store-visit
// body: { storeUniqueId: "STR-1790430355162" } ba { storeId: "<mongo id>" }
const registerStoreVisit = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { storeUniqueId, storeId } = req.body || {};

    let filter;
    if (typeof storeUniqueId === "string" && storeUniqueId.trim()) {
      filter = { storeUniqueId: storeUniqueId.trim() };
    } else if (storeId && mongoose.isValidObjectId(storeId)) {
      filter = { _id: storeId };
    } else {
      return res.status(400).json({
        success: false,
        message: "storeUniqueId or valid storeId required",
      });
    }

    const store = await StoreModel.findOne({ ...filter, isActive: true })
      .select("_id")
      .lean();
    if (!store) {
      return res
        .status(404)
        .json({ success: false, message: "Store not found" });
    }

    // prothom bar hole create, nahole shudhu lastVisitedAt update
    await StoreVisitModel.updateOne(
      { userId, storeId: store._id },
      { $set: { lastVisitedAt: new Date() } },
      { upsert: true },
    );

    return res
      .status(200)
      .json({ success: true, message: "Store visit registered" });
  } catch (error) {
    return serverError(res, "registerStoreVisit", error);
  }
};

/* ================= VISITORS (visited, no order in that store) ================= */

// GET /api/store-visit/visitors?page=1&limit=10&search=&storeId=
// store.isVisitor false hole name/phone/email masked, true hole full data
const getStoreVisitors = async (req, res) => {
  try {
    const ownerId = getUserId(req);
    const { page, limit, search } = parsePaging(req.query);

    const scope = await resolveOwnedStoreIds(ownerId, req.query.storeId);
    if (scope.error) {
      return res
        .status(scope.error.status)
        .json({ success: false, message: scope.error.message });
    }
    const storeIds = scope.ids;

    if (!storeIds.length) {
      return res.status(200).json({
        success: true,
        page,
        limit,
        totalPages: 0,
        totalVisitors: 0,
        visitors: [],
      });
    }

    const userMatch = { "user.role": "USER" };
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      // masked store er hidden field e search kora jabe na (data leak hobe)
      userMatch.$or = [
        { "store.isVisitor": true, "user.name": rx },
        { "store.isVisitor": true, "user.email": rx },
        { "store.isVisitor": true, "user.phone": rx },
      ];
    }

    const [result] = await StoreVisitModel.aggregate([
      { $match: { storeId: { $in: storeIds } } },
      // oi store e order thakle se Customer, Visitor na
      {
        $lookup: {
          from: OrderModel.collection.name,
          let: { uid: "$userId", sid: "$storeId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$userId", "$$uid"] },
                    { $eq: ["$storeId", "$$sid"] },
                  ],
                },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: "orders",
        },
      },
      { $match: { orders: { $size: 0 } } },
      {
        $lookup: {
          from: StoreModel.collection.name,
          localField: "storeId",
          foreignField: "_id",
          as: "store",
        },
      },
      { $unwind: "$store" },
      {
        $lookup: {
          from: UserModel.collection.name,
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      { $match: userMatch },
      { $sort: { lastVisitedAt: -1, _id: -1 } },
      {
        $facet: {
          data: [
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              // inclusion projection: password / fcmTokens kokhono ashbe na
              $project: {
                _id: 1,
                lastVisitedAt: 1,
                createdAt: 1,
                "user._id": 1,
                "user.name": 1,
                "user.email": 1,
                "user.phone": 1,
                "user.picture": 1,
                "user.isActive": 1,
                "user.isVerified": 1,
                "store._id": 1,
                "store.storeName": 1,
                "store.storeUniqueId": 1,
                "store.isVisitor": 1,
              },
            },
          ],
          total: [{ $count: "count" }],
        },
      },
    ]);

    const totalVisitors = result?.total?.[0]?.count || 0;

    const visitors = (result?.data || []).map(({ user, store, ...rest }) => {
      const masked = !store.isVisitor;
      return {
        ...rest,
        masked,
        user: masked ? maskUser(user) : user,
        store: {
          _id: store._id,
          storeName: store.storeName,
          storeUniqueId: store.storeUniqueId,
        },
      };
    });

    return res.status(200).json({
      success: true,
      page,
      limit,
      totalPages: Math.ceil(totalVisitors / limit),
      totalVisitors,
      visitors,
    });
  } catch (error) {
    return serverError(res, "getStoreVisitors", error);
  }
};

// GET /api/store-visit/visitors/:visitId
// shudhu isVisitor=true store er visitor details dekha jabe
const getVisitorDetails = async (req, res) => {
  try {
    const ownerId = getUserId(req);
    const { visitId } = req.params;

    if (!mongoose.isValidObjectId(visitId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid visit id" });
    }

    const visit = await StoreVisitModel.findById(visitId)
      .populate({ path: "userId", select: USER_DETAIL_FIELDS })
      .populate({
        path: "storeId",
        select: "storeName storeUniqueId userId isVisitor",
      })
      .lean();

    // onner store er visitor dekha jabe na
    if (
      !visit ||
      !visit.userId ||
      !visit.storeId ||
      String(visit.storeId.userId) !== String(ownerId)
    ) {
      return res
        .status(404)
        .json({ success: false, message: "Visitor not found" });
    }

    if (!visit.storeId.isVisitor) {
      return res.status(403).json({
        success: false,
        message: "Visitor details are locked for this store",
      });
    }

    const { userId: user, storeId: store } = visit;

    return res.status(200).json({
      success: true,
      visitor: {
        visitId: visit._id,
        firstVisitedAt: visit.createdAt,
        lastVisitedAt: visit.lastVisitedAt,
        user,
        store: {
          _id: store._id,
          storeName: store.storeName,
          storeUniqueId: store.storeUniqueId,
        },
      },
    });
  } catch (error) {
    return serverError(res, "getVisitorDetails", error);
  }
};

/* ================= CUSTOMERS (at least one order in that store) ================= */

// GET /api/store-visit/customers?page=1&limit=10&search=&storeId=
const getStoreCustomers = async (req, res) => {
  try {
    const ownerId = getUserId(req);
    const { page, limit, search } = parsePaging(req.query);

    const scope = await resolveOwnedStoreIds(ownerId, req.query.storeId);
    if (scope.error) {
      return res
        .status(scope.error.status)
        .json({ success: false, message: scope.error.message });
    }
    const storeIds = scope.ids;

    if (!storeIds.length) {
      return res.status(200).json({
        success: true,
        page,
        limit,
        totalPages: 0,
        totalCustomers: 0,
        customers: [],
      });
    }

    const userMatch = { "user.role": "USER" };
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      userMatch.$or = [
        { "user.name": rx },
        { "user.email": rx },
        { "user.phone": rx },
      ];
    }

    const [result] = await OrderModel.aggregate([
      { $match: { storeId: { $in: storeIds } } },
      {
        $group: {
          _id: { userId: "$userId", storeId: "$storeId" },
          totalOrders: { $sum: 1 },
          totalSpent: {
            $sum: {
              $cond: [
                { $ne: ["$status", "CANCELLED"] },
                { $ifNull: ["$totalAmount", 0] },
                0,
              ],
            },
          },
          firstOrderAt: { $min: "$createdAt" },
          lastOrderAt: { $max: "$createdAt" },
        },
      },
      {
        $lookup: {
          from: UserModel.collection.name,
          localField: "_id.userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      { $match: userMatch },
      {
        $lookup: {
          from: StoreModel.collection.name,
          localField: "_id.storeId",
          foreignField: "_id",
          as: "store",
        },
      },
      { $unwind: "$store" },
      { $sort: { lastOrderAt: -1, "_id.userId": -1 } },
      {
        $facet: {
          data: [
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                totalOrders: 1,
                totalSpent: 1,
                firstOrderAt: 1,
                lastOrderAt: 1,
                "user._id": 1,
                "user.name": 1,
                "user.email": 1,
                "user.phone": 1,
                "user.picture": 1,
                "user.isActive": 1,
                "user.isVerified": 1,
                "store._id": 1,
                "store.storeName": 1,
                "store.storeUniqueId": 1,
              },
            },
          ],
          total: [{ $count: "count" }],
        },
      },
    ]);

    const totalCustomers = result?.total?.[0]?.count || 0;

    return res.status(200).json({
      success: true,
      page,
      limit,
      totalPages: Math.ceil(totalCustomers / limit),
      totalCustomers,
      customers: result?.data || [],
    });
  } catch (error) {
    return serverError(res, "getStoreCustomers", error);
  }
};

// GET /api/store-visit/customers/:userId?storeId=<storeId>
// ekta customer er full details + oi store e tar order summary
const getCustomerDetails = async (req, res) => {
  try {
    const ownerId = getUserId(req);
    const { userId } = req.params;
    const { storeId } = req.query;

    if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(storeId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user or store id" });
    }

    // onner store er customer dekha jabe na
    const store = await StoreModel.findOne({ _id: storeId, userId: ownerId })
      .select("storeName storeUniqueId")
      .lean();
    if (!store) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    const orderFilter = {
      userId: new mongoose.Types.ObjectId(userId),
      storeId: store._id,
    };

    const [user, statsAgg, recentOrders, visit] = await Promise.all([
      UserModel.findById(userId).select(USER_DETAIL_FIELDS).lean(),
      OrderModel.aggregate([
        { $match: orderFilter },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            totalSpent: {
              $sum: {
                $cond: [
                  { $ne: ["$status", "CANCELLED"] },
                  { $ifNull: ["$totalAmount", 0] },
                  0,
                ],
              },
            },
          },
        },
      ]),
      OrderModel.find(orderFilter)
        .sort({ createdAt: -1 })
        .limit(5)
        .select("orderNumber status totalAmount createdAt")
        .lean(),
      StoreVisitModel.findOne({ userId, storeId: store._id })
        .select("createdAt lastVisitedAt")
        .lean(),
    ]);

    if (!user || !statsAgg[0]) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    return res.status(200).json({
      success: true,
      customer: {
        firstVisitedAt: visit?.createdAt || null,
        lastVisitedAt: visit?.lastVisitedAt || null,
        user,
        store,
        orderStats: {
          totalOrders: statsAgg[0].totalOrders,
          totalSpent: statsAgg[0].totalSpent,
        },
        recentOrders,
      },
    });
  } catch (error) {
    return serverError(res, "getCustomerDetails", error);
  }
};

module.exports = {
  registerStoreVisit,
  getStoreVisitors,
  getVisitorDetails,
  getStoreCustomers,
  getCustomerDetails,
};