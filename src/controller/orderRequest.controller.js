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
  requestRefundAmount,
  resolveReasonText,
} = require("../helper/orderRefund.js");
const {
  isAvailable: isShiprocketAvailable,
  createReturnOrder,
} = require("../helper/shiprocket.js");

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

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

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const splitName = (full) => {
  const parts = String(full || "Customer").trim().split(/\s+/);
  return { first: parts[0], last: parts.slice(1).join(" ") || "." };
};

// Approved RETURN er jonno Shiprocket e return pickup toiri kore.
// Kono karone na hole error ferot dey na, request e note rekhe store ke manually korte dey.
const startReturnPickup = async (request) => {
  try {
    const order = await OrderModel.findById(request.orderId)
      .select("+pickupAddress")
      .lean();
    if (!order) return { status: "MANUAL", note: "Order not found" };

    // courier diye ashe nai (LOCAL / own delivery), tai courier return lagbe na
    if (!order.shipment?.awb) {
      return { status: "MANUAL", note: "Not shipped via courier" };
    }
    if (!isShiprocketAvailable()) {
      return { status: "FAILED", note: "Shiprocket is currently unavailable" };
    }

    const store = order.pickupAddress;
    if (!store?.pincode || !store?.addressLine) {
      return {
        status: "MANUAL",
        note: "Store pickup address is missing, arrange return manually",
      };
    }

    const item = (order.items || []).find(
      (i) => String(i._id) === String(request.itemId),
    );
    if (!item) return { status: "FAILED", note: "Item not found" };

    const customer = await UserModel.findById(order.userId)
      .select("email")
      .lean();
    const d = order.deliveryAddress;
    const cust = splitName(d.fullName);
    const owner = splitName(store.contactName);

    const pItem = (order.parcel?.items || []).find(
      (p) => String(p.productId) === String(item.productId),
    );
    const unitPrice = Number(item.offerPrice ?? 0);

    const payload = {
      order_id: request.requestNumber,
      order_date: ymd(new Date()),
      // customer = pickup (jar kach theke product ashbe)
      pickup_customer_name: cust.first,
      pickup_last_name: cust.last,
      pickup_address: d.addressLine,
      pickup_address_2: d.area || "",
      pickup_city: d.city,
      pickup_state: d.state,
      pickup_country: d.country || "India",
      pickup_pincode: d.pincode,
      pickup_email: customer?.email || store.email || "noemail@example.com",
      pickup_phone: last10(d.phone),
      pickup_isd_code: "91",
      // store = shipping (jekhane product ferot jabe)
      shipping_customer_name: owner.first,
      shipping_last_name: owner.last,
      shipping_address: store.addressLine,
      shipping_address_2: store.area || "",
      shipping_city: store.city,
      shipping_state: store.state,
      shipping_country: store.country || "India",
      shipping_pincode: store.pincode,
      shipping_email: store.email || "noemail@example.com",
      shipping_phone: last10(store.phone),
      shipping_isd_code: "91",
      order_items: [
        {
          name: item.name,
          sku: item.productCode || String(item.productId),
          units: item.quantity,
          selling_price: unitPrice,
          discount: 0,
          hsn: item.hsnCode || "",
        },
      ],
      payment_method: "PREPAID",
      total_discount: 0,
      sub_total: round2(unitPrice * item.quantity),
      length: order.parcel?.length || 10,
      breadth: order.parcel?.breadth || 10,
      height: order.parcel?.height || 10,
      weight: pItem?.lineWeightKg || order.parcel?.weight || 0.5,
    };

    const data = await createReturnOrder(payload);
    return {
      status: "CREATED",
      shiprocketOrderId: data?.order_id ?? null,
      shipmentId: data?.shipment_id ?? null,
      createdAt: new Date(),
    };
  } catch (err) {
    console.error("Return pickup error:", err.message);
    return { status: "FAILED", note: err.message };
  }
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

    // [FIX] RETURN ar REFUND dutote user er deya taka ferot jabe. REPLACE e jabe na
    const refundAmount = requestRefundAmount(order, item, type);
    const moneyBack = refundAmount > 0;

    if (moneyBack && !bankDetails) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: [
          {
            field: "bankDetails",
            message:
              "Bank details or a UPI ID is required to receive your refund",
          },
        ],
      });
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

    // [GUARD] ager refund soho order e jototuku paid, tar beshi ferot hobe na
    if (moneyBack) {
      const refundableTotal = order.itemsTotal ?? order.totalAmount;
      if (Number(order.refundedAmount || 0) + refundAmount > refundableTotal + 0.005) {
        return res.status(400).json({
          success: false,
          message: "Refund amount exceeds the paid amount of this order",
        });
      }
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
      refundAmount,
      bankDetails: moneyBack ? bankDetails : null,
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

    let request = await OrderRequestModel.findOneAndUpdate(
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

    // [RETURN] approve hole courier return pickup toiri
    let returnShipment = null;
    if (action === "APPROVE" && request.type === "RETURN") {
      returnShipment = await startReturnPickup(request);
      request = await OrderRequestModel.findByIdAndUpdate(
        requestId,
        { $set: { returnShipment } },
        { new: true },
      ).lean();
    }

    return res.status(200).json({
      success: true,
      message:
        action === "APPROVE"
          ? returnShipment?.status === "CREATED"
            ? "Request approved and courier return pickup created"
            : returnShipment
              ? `Request approved. Courier return was not created (${returnShipment.note}). Arrange the return manually`
              : "Request approved"
          : "Request rejected",
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

    const paysMoney = Number(existing.refundAmount) > 0; // [FIX] REFUND + RETURN
    if (paysMoney && !referenceNo) {
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

    if (Number(request.refundAmount) > 0) {
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
        Number(request.refundAmount) > 0
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
