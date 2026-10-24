const mongoose = require("mongoose");
const OrderModel = require("../model/order.model.js");
const StoreModel = require("../model/store.model.js");
const { OrderRequestModel } = require("../model/orderRequest.model.js");
const UserModel = require("../model/user.model.js");
const {
  createRequestSchema,
  decideRequestSchema,
  completeRequestSchema,
} = require("../schema/order.schema.js");
const {
  checkRequestEligibility,
  itemRefundAmount,
  resolveReasonText,
} = require("../helper/orderRefund.js");

const getUserId = (req) => req.user?._id || req.user?.id;

const handleError = (res, error, label) => {
  if (error.name === "ZodError") {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      })),
    });
  }
  console.error(`${label}:`, error);
  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

const isStoreOwner = async (storeId, userId) =>
  !!(await StoreModel.exists({ _id: storeId, userId }));

// user ke account number puro dekhano hobe na
const maskBank = (b) =>
  b
    ? {
        ...b,
        accountNumber: b.accountNumber
          ? `XXXXXX${String(b.accountNumber).slice(-4)}`
          : undefined,
      }
    : null;

const parsePagination = (query) => ({
  pageNum: Math.max(parseInt(query.page) || 1, 1),
  limitNum: Math.min(Math.max(parseInt(query.limit) || 10, 1), 100),
});

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getRole = async (req) => {
  if (req.user?.role) return req.user.role;
  const user = await UserModel.findById(getUserId(req)).select("role").lean();
  return user?.role || null;
};

const createOrderRequest = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order id" });
    }

    const { itemId, type, reasonCode, reason, bankDetails } =
      createRequestSchema.parse(req.body || {});

    const order = await OrderModel.findOne({ _id: orderId, userId }).lean();
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const item = (order.items || []).find((i) => String(i._id) === itemId);
    if (!item) {
      return res
        .status(404)
        .json({ success: false, message: "Item not found in this order" });
    }

    const check = checkRequestEligibility(order, item, type);
    if (!check.ok) {
      return res.status(400).json({ success: false, message: check.message });
    }

    // ek item e ekta-i active / completed request
    const duplicate = await OrderRequestModel.exists({
      orderId: order._id,
      itemId: item._id,
      status: { $in: ["REQUESTED", "APPROVED", "COMPLETED"] },
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "A request for this item already exists",
      });
    }

    const request = await OrderRequestModel.create({
      orderId: order._id,
      orderNumber: order.orderNumber,
      itemId: item._id,
      itemName: item.name,
      itemImage: item.image || null,
      quantity: item.quantity,
      userId,
      storeId: order.storeId,
      type,
      source: "CUSTOMER",
      reasonCode,
      reason: resolveReasonText(reasonCode, reason),
      refundAmount: type === "REFUND" ? itemRefundAmount(item) : 0,
      bankDetails: type === "REFUND" ? bankDetails : null,
    });

    return res.status(201).json({
      success: true,
      message: "Your request has been sent to the store",
      request: {
        ...request.toObject(),
        bankDetails: maskBank(request.bankDetails),
      },
    });
  } catch (error) {
    // unique index e atkale (duto request ekshathe ashle)
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "A request for this item already exists",
      });
    }
    return handleError(res, error, "Create Order Request Error");
  }
};

// ===================== USER: MY REQUESTS =====================
// GET /api/order/my-requests?orderId&status&page&limit
const getMyRequests = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { orderId, status } = req.query;

    const match = { userId };
    if (orderId) {
      if (!mongoose.isValidObjectId(orderId)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid order id" });
      }
      match.orderId = orderId;
    }
    if (status) match.status = status;

    const { pageNum, limitNum } = parsePagination(req.query);

    const [requests, total] = await Promise.all([
      OrderRequestModel.find(match)
        .sort({ createdAt: -1, _id: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      OrderRequestModel.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
      requests: requests.map((r) => ({
        ...r,
        bankDetails: maskBank(r.bankDetails),
      })),
    });
  } catch (error) {
    return handleError(res, error, "Get My Requests Error");
  }
};

// ===================== STORE: LIST REQUESTS =====================
// GET /api/order/store-requests?orderId&status&type&storeId&search&page&limit
// Shudhu nijer store er request. ADMIN dekhte pabe na.
const getStoreRequests = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { orderId, status, type, storeId, search } = req.query;

    const stores = await StoreModel.find({ userId }).select("_id").lean();
    const ownIds = stores.map((s) => String(s._id));

    const match = { storeId: { $in: ownIds } };

    if (storeId) {
      if (!mongoose.isValidObjectId(storeId)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid store id" });
      }
      if (!ownIds.includes(String(storeId))) {
        return res.status(403).json({
          success: false,
          message: "Not authorized for this store",
        });
      }
      match.storeId = storeId;
    }

    if (orderId) {
      if (!mongoose.isValidObjectId(orderId)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid order id" });
      }
      match.orderId = orderId;
    }
    if (status) match.status = status;
    if (type) match.type = type;

    const term = typeof search === "string" ? search.trim() : "";
    if (term) {
      const rx = new RegExp(escapeRegex(term), "i");
      match.$or = [
        { requestNumber: rx },
        { orderNumber: rx },
        { itemName: rx },
      ];
    }

    const { pageNum, limitNum } = parsePagination(req.query);

    const [requests, total] = await Promise.all([
      OrderRequestModel.find(match)
        .sort({ createdAt: -1, _id: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      OrderRequestModel.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
      requests,
    });
  } catch (error) {
    return handleError(res, error, "Get Store Requests Error");
  }
};

// ===================== STORE: APPROVE / REJECT =====================
// PATCH /api/order/store-requests/:requestId/decision   body: { action, note? }
const decideRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(requestId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid request id" });
    }

    const { action, note } = decideRequestSchema.parse(req.body || {});

    const existing = await OrderRequestModel.findById(requestId).lean();
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "Request not found" });
    }
    if (!(await isStoreOwner(existing.storeId, userId))) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized for this request" });
    }
    if (existing.status !== "REQUESTED") {
      return res.status(400).json({
        success: false,
        message: "This request has already been processed",
      });
    }

    const request = await OrderRequestModel.findOneAndUpdate(
      { _id: requestId, status: "REQUESTED" },
      {
        $set: {
          status: action === "APPROVE" ? "APPROVED" : "REJECTED",
          storeNote: note || null,
          decidedAt: new Date(),
          decidedBy: userId,
        },
      },
      { new: true },
    ).lean();

    if (!request) {
      return res.status(409).json({
        success: false,
        message: "This request has just changed, please refresh",
      });
    }

    return res.status(200).json({
      success: true,
      message: action === "APPROVE" ? "Request approved" : "Request rejected",
      request,
    });
  } catch (error) {
    return handleError(res, error, "Decide Request Error");
  }
};

const completeRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(requestId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid request id" });
    }

    const { referenceNo, note } = completeRequestSchema.parse(req.body || {});

    const existing = await OrderRequestModel.findById(requestId).lean();
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "Request not found" });
    }
    if (!(await isStoreOwner(existing.storeId, userId))) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized for this request" });
    }
    if (existing.status !== "APPROVED") {
      return res.status(400).json({
        success: false,
        message: "Only an approved request can be completed",
      });
    }
    if (existing.type === "REFUND" && !referenceNo) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: [
          {
            field: "referenceNo",
            message: "Payment reference (UTR / transaction ID) is required",
          },
        ],
      });
    }

    const request = await OrderRequestModel.findOneAndUpdate(
      { _id: requestId, status: "APPROVED" },
      {
        $set: {
          status: "COMPLETED",
          completedAt: new Date(),
          referenceNo: referenceNo || null,
          completeNote: note || null,
        },
      },
      { new: true },
    ).lean();

    if (!request) {
      return res.status(409).json({
        success: false,
        message: "This request has just changed, please refresh",
      });
    }

    if (request.type === "REFUND" && request.refundAmount > 0) {
      const order = await OrderModel.findByIdAndUpdate(
        request.orderId,
        { $inc: { refundedAmount: request.refundAmount } },
        { new: true },
      )
        .select("refundedAmount totalAmount itemsTotal")
        .lean();

      if (order) {
        const refundableTotal = order.itemsTotal ?? order.totalAmount;
        if (order.refundedAmount + 0.005 >= refundableTotal) {
          await OrderModel.updateOne(
            { _id: order._id },
            { $set: { paymentStatus: "REFUNDED" } },
          );
        }
      }
    }

    return res.status(200).json({
      success: true,
      message:
        request.type === "REFUND"
          ? "Refund marked as paid"
          : "Request marked as completed",
      request,
    });
  } catch (error) {
    return handleError(res, error, "Complete Request Error");
  }
};

module.exports = {
  createOrderRequest,
  getMyRequests,
  getStoreRequests,
  decideRequest,
  completeRequest,
};
