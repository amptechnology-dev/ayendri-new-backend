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
const ProductModel = require("../model/product.model.js");
const { uploadSimpleImages } = require("../helper/productImages.js");
const { checkStoreDelivery } = require("../helper/deliveryEstimate.js");
const { getStorePolicy } = require("../helper/storePolicy.js");
const {
  locateStockUnit,
  decrementStockForLine,
  restoreStockForLine,
  logStockChange,
  findUnitStock,
} = require("../helper/stockManager.js");
const { isStockManaged } = require("../helper/storeSettings.js");
const { sendPickupContactOrderMail } = require("../helper/pickupMail.js");
const { notifyUserOrderStatus } = require("../helper/notification.helper.js");
const { startFulfilment } = require("../helper/fulfilment.js");
const {
  uploadEvidenceFiles,
  MAX_EVIDENCE_FILES,
} = require("../helper/productImages.js");

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
  // upload helper er statusCode error (file besi boro / video convert fail etc.)
  if (error.statusCode) {
    return res
      .status(error.statusCode)
      .json({ success: false, message: error.message });
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
const last10 = (p) =>
  String(p || "")
    .replace(/\D/g, "")
    .slice(-10);
const splitName = (full) => {
  const parts = String(full || "Customer")
    .trim()
    .split(/\s+/);
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

// ===================== [REPLACE] =====================

// [TEMP OFF] order.controller er kickOffShipment er moto. Auto shipment chalu korle eta-o uncomment koro
const kickOffReplacementShipment = (order) => {
  // if (!order?.autoShip) return;
  // startFulfilment(order._id).catch((e) =>
  //   console.error("Replacement auto shipment error:", e.message),
  // );
};

const cleanId = (id) => {
  if (id === undefined || id === null) return null;
  const s = String(id).trim();
  return !s || s === "null" || s === "undefined" ? null : id;
};

// original order er parcel snapshot theke sudhu ei ekta item er parcel
const parcelForItem = (order, item) => {
  const p = (order.parcel?.items || []).find(
    (x) =>
      String(x.productId) === String(item.productId) &&
      String(x.variantId || "") === String(item.variantId || ""),
  );
  if (!p) return null;
  const weight = Math.max(0.1, round2(p.lineWeightKg || 0.5));
  const length = p.length || 10;
  const breadth = p.breadth || 10;
  const height = (p.height || 10) * (p.quantity || 1);
  const volumetricWeight = round2((length * breadth * height) / 5000);
  return {
    length,
    breadth,
    height,
    weight,
    volumetricWeight,
    chargeableWeight: Math.max(weight, volumetricWeight),
    dimsComplete: !p.usedDefaultDims,
    weightComplete: !p.usedDefaultWeight,
    items: [p],
  };
};

// REPLACE approve hole notun order toiri. Fail hole stock ferot diye { ok:false } return kore
const createReplacementOrder = async (request, userId) => {
  const original = await OrderModel.findById(request.orderId)
    .select("+pickupAddress")
    .lean();
  if (!original) {
    return { ok: false, status: 404, message: "Original order not found" };
  }

  const item = (original.items || []).find(
    (i) => String(i._id) === String(request.itemId),
  );
  if (!item) {
    return { ok: false, status: 404, message: "Item not found in the order" };
  }

  if (await OrderModel.exists({ replacementRequestId: request._id })) {
    return {
      ok: false,
      status: 409,
      message: "A replacement order already exists for this request",
    };
  }

  // ---------- stock (shudhu stock managed product e) ----------
  let stock = null;
  const product = await ProductModel.findById(item.productId).select(
    "variants currentStock lowStockThreshold hasStockManagement productType",
  );
  if (product && isStockManaged(product)) {
    const unit = locateStockUnit(product, cleanId(item.variantId));
    if (!unit) {
      return {
        ok: false,
        status: 409,
        message:
          "This variant is no longer available, so a replacement cannot be sent",
      };
    }
    const r = await decrementStockForLine({
      productId: product._id,
      variantId: unit.variantId,
      sizeVariantId: unit.sizeVariantId,
      quantity: item.quantity,
    });
    if (!r.success) {
      return {
        ok: false,
        status: 409,
        message: `Not enough stock to send a replacement for "${item.name}". Update the stock and approve again`,
      };
    }
    stock = {
      unit,
      newStock: findUnitStock(r.product, unit.variantId, unit.sizeVariantId),
    };
  }

  const rollbackStock = async () => {
    if (!stock) return;
    await restoreStockForLine({
      productId: item.productId,
      variantId: stock.unit.variantId,
      sizeVariantId: stock.unit.sizeVariantId,
      quantity: item.quantity,
    }).catch((e) => console.error("Replacement stock rollback:", e.message));
  };

  try {
    // ---------- delivery (customer er jonno free, store courier cost bahon kore) ----------
    const parcel = parcelForItem(original, item);
    const policy = await getStorePolicy(original.storeId);
    let deliveryInfo = null;
    let autoShip = false;

    if (policy.hasDelivery) {
      try {
        const d = await checkStoreDelivery({
          storeId: original.storeId,
          pincode: original.deliveryAddress?.pincode,
          country: original.deliveryAddress?.country,
          parcel,
          cod: false,
          policy,
          fastest: false,
          pickupPincode: original.pickupAddress?.pincode,
        });
        if (d.deliverable && d.info) {
          deliveryInfo = {
            ...d.info,
            baseShippingCharge: d.info.shippingCharge, // courier er asol rate (report e store bear kore)
            shippingCharge: 0,
            shippingNote: "Free replacement delivery",
          };
          autoShip = d.info.mode === "NATIONAL";
        }
      } catch (e) {
        console.error("Replacement delivery estimate failed:", e.message);
      }
    }

    // courier e declared value hishebe purono price rakhchi, kintu customer er payable 0
    const unit = Number(item.offerPrice ?? 0);
    const declared = round2(unit * item.quantity);

    const lineItem = {
      productId: item.productId,
      variantId: item.variantId ?? null,
      name: item.name,
      productCode: item.productCode,
      image: item.image ?? null,
      unit: item.unit,
      color: item.color ?? null,
      size: item.size ?? null,
      weight: item.weight ?? null,
      height: item.height ?? null,
      mrp: Number(item.mrp ?? unit),
      offerPrice: unit,
      quantity: item.quantity,
      lineTotal: declared,
      priceOnRequest: false,
      gstRates: null,
      gstInclusive: false,
      hsnCode: item.hsnCode ?? null,
      taxableAmount: 0,
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: 0,
      gstAmount: 0,
      lineTotalWithGst: 0,
      productType: "PRODUCT",
      // replacement order e abar return / replace / refund hobe na
      isReturnable: false,
      returnDays: null,
      isReplaceable: false,
      replaceDays: null,
      isRefundable: false,
      refundDays: null,
    };

    const order = await OrderModel.create({
      orderType: "REPLACEMENT",
      replacementOf: original._id,
      replacementRequestId: request._id,
      replacementRequestNumber: request.requestNumber,

      userId: original.userId,
      storeId: original.storeId,
      storeName: original.storeName,
      storeUniqueId: original.storeUniqueId,

      items: [lineItem],
      totalItems: item.quantity,
      totalMrp: 0,
      discount: 0,
      gstMode: original.gstMode || "INTRA",
      subtotal: 0,
      totalTaxable: 0,
      totalCgst: 0,
      totalSgst: 0,
      totalIgst: 0,
      totalGst: 0,
      totalAmount: 0, // customer kichu dibe na
      itemsTotal: declared, // shudhu Shiprocket er sub_total er jonno

      deliveryAddress: original.deliveryAddress,
      note: `Replacement for order ${original.orderNumber} (${request.requestNumber})`,
      shippingCharge: 0,
      deliveryEnabled: policy.hasDelivery,
      deliveryInfo,
      parcel: policy.hasDelivery ? parcel : null,
      pickupAddress: original.pickupAddress || null,
      expectedDeliveryDate: deliveryInfo?.estimatedMaxDate || null,

      // taka nai: courier e Prepaid jabe (paymentOff = true)
      paymentMethod: "COD",
      paymentOff: true,
      paymentStatus: "PENDING",
      paymentExpiresAt: null,

      status: "CONFIRMED",
      statusHistory: [
        {
          status: "CONFIRMED",
          changedBy: userId,
          note: `Replacement approved (${request.requestNumber})`,
          at: new Date(),
        },
      ],

      autoShip,
      shipStartDate: new Date(),
    });

    if (stock) {
      await logStockChange({
        productId: item.productId,
        storeId: original.storeId,
        userId,
        variantId: stock.unit.variantId,
        sizeVariantId: stock.unit.sizeVariantId,
        productName: item.name,
        variantLabel:
          [item.color, item.size, item.weight, item.height]
            .filter(Boolean)
            .join(" / ") || "Default",
        type: "OUT",
        reason: "OTHER",
        note: `Replacement order ${order.orderNumber}`,
        previousStock: stock.newStock + item.quantity,
        newStock: stock.newStock,
      }).catch((e) => console.error("Replacement stock log:", e.message));
    }

    return { ok: true, order };
  } catch (err) {
    console.error("Create replacement order error:", err);
    await rollbackStock();
    return {
      ok: false,
      status: 500,
      message: "Could not create the replacement order. Please try again",
    };
  }
};

// replacement order DELIVERED hole request auto COMPLETED
const markReplacementDelivered = async (order) => {
  if (order?.orderType !== "REPLACEMENT" || !order.replacementRequestId) return;
  try {
    await OrderRequestModel.updateOne(
      { _id: order.replacementRequestId, status: "APPROVED" },
      {
        $set: {
          status: "COMPLETED",
          completedAt: new Date(),
          completeNote: "Replacement delivered",
        },
      },
    );
  } catch (e) {
    console.error("Mark replacement delivered error:", e.message);
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

    // multipart/form-data te bankDetails JSON string hoye ashe
    const body = { ...(req.body || {}) };
    if (typeof body.bankDetails === "string") {
      if (!body.bankDetails.trim()) {
        delete body.bankDetails;
      } else {
        try {
          body.bankDetails = JSON.parse(body.bankDetails);
        } catch {
          return res
            .status(400)
            .json({ success: false, message: "Invalid bankDetails format" });
        }
      }
    }

    const { itemId, type, reasonCode, reason, bankDetails } =
      createRequestSchema.parse(body);

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
      if (
        Number(order.refundedAmount || 0) + refundAmount >
        refundableTotal + 0.005
      ) {
        return res.status(400).json({
          success: false,
          message: "Refund amount exceeds the paid amount of this order",
        });
      }
    }

    const files = Array.isArray(req.files)
      ? req.files
      : Object.values(req.files || {}).flat();
    const evidence = await uploadEvidenceFiles(files);

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
      evidence,
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

const getStoreRequests = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { orderId, status, type, storeId, search } = req.query;
    const isAdmin = (await getRole(req)) === "ADMIN";

    const match = {};

    if (isAdmin) {
      // ADMIN: shob store (view only)
      if (storeId) {
        if (!mongoose.isValidObjectId(storeId)) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid store id" });
        }
        match.storeId = storeId;
      }
    } else {
      const stores = await StoreModel.find({ userId }).select("_id").lean();
      const ownIds = stores.map((s) => String(s._id));
      match.storeId = { $in: ownIds };

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

    const [rows, total] = await Promise.all([
      OrderRequestModel.find(match)
        .sort({ createdAt: -1, _id: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      OrderRequestModel.countDocuments(match),
    ]);

    // ADMIN table e store name / id dekhanor jonno
    let requests = rows;
    if (isAdmin && rows.length) {
      const ids = [...new Set(rows.map((r) => String(r.storeId)))];
      const stores = await StoreModel.find({ _id: { $in: ids } })
        .select("storeName storeUniqueId")
        .lean();
      const map = new Map(stores.map((s) => [String(s._id), s]));
      requests = rows.map((r) => {
        const s = map.get(String(r.storeId));
        return {
          ...r,
          storeName: s?.storeName || null,
          storeUniqueId: s?.storeUniqueId || null,
        };
      });
    }

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

    let returnShipment = null;
    let replacementOrder = null;

    // [RETURN] approve hole courier return pickup toiri
    if (action === "APPROVE" && request.type === "RETURN") {
      returnShipment = await startReturnPickup(request);
      request = await OrderRequestModel.findByIdAndUpdate(
        requestId,
        { $set: { returnShipment } },
        { new: true },
      ).lean();
    }

    // [REPLACE] approve hole: notun order + purono item er courier pickup
    if (action === "APPROVE" && request.type === "REPLACE") {
      const rep = await createReplacementOrder(request, userId);

      if (!rep.ok) {
        // approve undo: request abar REQUESTED e, store thik kore abar approve korbe
        await OrderRequestModel.updateOne(
          { _id: requestId, status: "APPROVED" },
          {
            $set: { status: "REQUESTED", storeNote: null, decidedAt: null },
            $unset: { decidedBy: "" },
          },
        );
        return res
          .status(rep.status || 409)
          .json({ success: false, message: rep.message });
      }

      replacementOrder = rep.order;
      returnShipment = await startReturnPickup(request);

      request = await OrderRequestModel.findByIdAndUpdate(
        requestId,
        {
          $set: {
            returnShipment,
            replacementOrderId: replacementOrder._id,
            replacementOrderNumber: replacementOrder.orderNumber,
          },
        },
        { new: true },
      ).lean();

      notifyUserOrderStatus(replacementOrder);
      if (replacementOrder.pickupAddress?.email) {
        sendPickupContactOrderMail({ order: replacementOrder }).catch((e) =>
          console.error("Replacement pickup mail error:", e.message),
        );
      }
      kickOffReplacementShipment(replacementOrder);
    }

    let message;
    if (action !== "APPROVE") {
      message = "Request rejected";
    } else if (replacementOrder) {
      message =
        returnShipment?.status === "CREATED"
          ? `Replacement approved. Order ${replacementOrder.orderNumber} created and courier pickup of the old item booked`
          : `Replacement approved. Order ${replacementOrder.orderNumber} created. Courier pickup of the old item was not created (${returnShipment?.note || "n/a"}), arrange it manually`;
    } else if (returnShipment?.status === "CREATED") {
      message = "Request approved and courier return pickup created";
    } else if (returnShipment) {
      message = `Request approved. Courier return was not created (${returnShipment.note}). Arrange the return manually`;
    } else {
      message = "Request approved";
    }

    return res.status(200).json({
      success: true,
      message,
      request,
      replacementOrder: replacementOrder
        ? {
            _id: replacementOrder._id,
            orderNumber: replacementOrder.orderNumber,
            autoShip: replacementOrder.autoShip,
          }
        : null,
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
  markReplacementDelivered,
};
