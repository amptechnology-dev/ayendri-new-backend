const mongoose = require("mongoose");
const UserModel = require("../model/user.model.js");
const StoreModel = require("../model/store.model.js");
const ProductModel = require("../model/product.model.js");
const OrderModel = require("../model/order.model.js"); // adjust path if different

const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
];

// ---------- helpers ----------

const getTodayRange = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const getYesterdayRange = () => {
  const start = new Date();
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setDate(end.getDate() - 1);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

// [{_id:"PENDING", count:3}, ...] -> {PENDING:3, CONFIRMED:0, ...}
const formatStatusBreakdown = (agg = []) => {
  const map = ORDER_STATUSES.reduce((acc, s) => ({ ...acc, [s]: 0 }), {});
  agg.forEach((item) => {
    if (item._id in map) map[item._id] = item.count;
  });
  return map;
};

// ---------- ADMIN DASHBOARD ----------

const adminDashboard = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const user = await UserModel.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    if (user.role !== "ADMIN") {
      return res
        .status(403)
        .json({
          success: false,
          message: "Only ADMIN can view this dashboard",
        });
    }

    const { start: todayStart, end: todayEnd } = getTodayRange();

    const [
      totalStores,
      todayRegisteredStores,
      verifiedStores,
      unverifiedStores,
      activeStores,
      inactiveStores,
      featuredStores,
      totalUsers,
      todayRegisteredUsers,
      totalStoreOwners,
      totalProducts,
      verifiedProducts,
      unverifiedProducts,
      totalOrders,
      todayOrders,
      orderStatusAgg,
      revenueAgg,
      recentStores,
    ] = await Promise.all([
      StoreModel.countDocuments(),
      StoreModel.countDocuments({
        createdAt: { $gte: todayStart, $lte: todayEnd },
      }),
      StoreModel.countDocuments({ isVerify: true }),
      StoreModel.countDocuments({ isVerify: false }),
      StoreModel.countDocuments({ isActive: true }),
      StoreModel.countDocuments({ isActive: false }),
      StoreModel.countDocuments({ isFeatured: true }),
      UserModel.countDocuments({ role: "USER" }),
      UserModel.countDocuments({
        role: "USER",
        createdAt: { $gte: todayStart, $lte: todayEnd },
      }),
      UserModel.countDocuments({ role: "STORE" }),
      ProductModel.countDocuments(),
      ProductModel.countDocuments({ isVerified: true }),
      ProductModel.countDocuments({ isVerified: false }),
      OrderModel.countDocuments(),
      OrderModel.countDocuments({
        createdAt: { $gte: todayStart, $lte: todayEnd },
      }),
      OrderModel.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      OrderModel.aggregate([
        { $match: { status: { $ne: "CANCELLED" } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]),
      StoreModel.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .select("storeName storeUniqueId isVerify isActive createdAt"),
    ]);

    return res.status(200).json({
      success: true,
      stores: {
        total: totalStores,
        todayRegistered: todayRegisteredStores,
        verified: verifiedStores,
        unverified: unverifiedStores,
        active: activeStores,
        inactive: inactiveStores,
        featured: featuredStores,
      },
      users: {
        totalCustomers: totalUsers,
        todayRegisteredCustomers: todayRegisteredUsers,
        totalStoreOwners,
      },
      products: {
        total: totalProducts,
        verified: verifiedProducts,
        pendingVerification: unverifiedProducts,
      },
      orders: {
        total: totalOrders,
        today: todayOrders,
        statusBreakdown: formatStatusBreakdown(orderStatusAgg),
        totalRevenue: revenueAgg[0]?.total || 0,
      },
      recentStores,
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

// ---------- STORE DASHBOARD ----------

const storeDashboard = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const user = await UserModel.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    if (user.role !== "STORE") {
      return res
        .status(403)
        .json({
          success: false,
          message: "Only STORE can view this dashboard",
        });
    }

    const store = await StoreModel.findOne({ userId });
    if (!store) {
      return res
        .status(404)
        .json({ success: false, message: "Store not found" });
    }

    const storeId = store._id;
    const lowStockThreshold = parseInt(req.query.lowStockThreshold) || 5;

    const { start: todayStart, end: todayEnd } = getTodayRange();
    const { start: yesterdayStart, end: yesterdayEnd } = getYesterdayRange();

    const [
      totalOrders,
      todayOrders,
      yesterdayOrders,
      orderStatusAgg,
      revenueAgg,
      todayRevenueAgg,
      totalProducts,
      activeProducts,
      verifiedProducts,
      lowStockProducts,
      outOfStockAgg,
      recentOrders,
    ] = await Promise.all([
      OrderModel.countDocuments({ storeId }),
      OrderModel.countDocuments({
        storeId,
        createdAt: { $gte: todayStart, $lte: todayEnd },
      }),
      OrderModel.countDocuments({
        storeId,
        createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd },
      }),
      OrderModel.aggregate([
        { $match: { storeId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      OrderModel.aggregate([
        { $match: { storeId, status: { $ne: "CANCELLED" } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]),
      OrderModel.aggregate([
        {
          $match: {
            storeId,
            status: { $ne: "CANCELLED" },
            createdAt: { $gte: todayStart, $lte: todayEnd },
          },
        },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]),
      ProductModel.countDocuments({ storeId }),
      ProductModel.countDocuments({ storeId, isActive: true }),
      ProductModel.countDocuments({ storeId, isVerified: true }),
      ProductModel.aggregate([
        { $match: { storeId, isActive: true } },
        { $unwind: "$variants" },
        {
          $match: {
            "variants.isActive": true,
            "variants.stock": { $lte: lowStockThreshold },
          },
        },
        {
          $project: {
            _id: 1,
            name: 1,
            productCode: 1,
            variantId: "$variants._id",
            size: "$variants.size",
            weight: "$variants.weight",
            stock: "$variants.stock",
          },
        },
        { $sort: { stock: 1 } },
        { $limit: 20 },
      ]),
      ProductModel.aggregate([
        { $match: { storeId, isActive: true } },
        { $unwind: "$variants" },
        { $match: { "variants.isActive": true, "variants.stock": 0 } },
        { $count: "count" },
      ]),
      OrderModel.find({ storeId })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("orderNumber status totalAmount totalItems createdAt"),
    ]);

    return res.status(200).json({
      success: true,
      store: {
        _id: store._id,
        storeName: store.storeName,
        storeUniqueId: store.storeUniqueId,
        isVerify: store.isVerify,
        isActive: store.isActive,
      },
      orders: {
        total: totalOrders,
        today: todayOrders,
        yesterday: yesterdayOrders,
        statusBreakdown: formatStatusBreakdown(orderStatusAgg),
        totalRevenue: revenueAgg[0]?.total || 0,
        todayRevenue: todayRevenueAgg[0]?.total || 0,
      },
      products: {
        total: totalProducts,
        active: activeProducts,
        verified: verifiedProducts,
        outOfStockVariants: outOfStockAgg[0]?.count || 0,
        lowStockThreshold,
        lowStockProducts,
      },
      recentOrders,
    });
  } catch (error) {
    console.error("Store dashboard error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  adminDashboard,
  storeDashboard,
};
