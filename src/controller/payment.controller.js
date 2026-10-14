const mongoose = require("mongoose");
const crypto = require("crypto");
const OrderModel = require("../model/order.model.js");
const UserModel = require("../model/user.model.js");
const { initiatePaymentSchema } = require("../schema/order.schema.js");
const {
  PAYU_KEY,
  PAYU_PAYMENT_URL,
  generateRequestHash,
  isValidResponseHash,
  verifyPaymentWithPayU,
} = require("../helper/payu.js");
const { restoreOrderStock } = require("./order.controller.js");

const BACKEND_URL = process.env.BACKEND_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;

const getUserId = (req) => req.user?._id || req.user?.id;

const genTxnId = (orderNumber) =>
  `${orderNumber}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;

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

// ============ 1. INITIATE PAYMENT ============
// POST /api/payment/initiate/:orderId
const initiatePayment = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order id" });
    }
    initiatePaymentSchema.parse(req.body || {});

    const order = await OrderModel.findOne({ _id: orderId, userId });
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (order.paymentMethod !== "ONLINE") {
      return res.status(400).json({
        success: false,
        message: "This order is not an online payment order",
      });
    }
    if (order.paymentStatus === "PAID") {
      return res
        .status(400)
        .json({ success: false, message: "Order is already paid" });
    }
    if (order.status !== "PENDING" && order.status !== "CONFIRMED") {
      return res.status(400).json({
        success: false,
        message: `Cannot pay for an order that is ${order.status}`,
      });
    }
    // price-on-request: quote accept howar age payment hobe na
    if (["AWAITING_QUOTE", "QUOTED"].includes(order.priceStatus)) {
      return res.status(400).json({
        success: false,
        message: "Please accept the price estimate before paying",
      });
    }
    if (!order.totalAmount || order.totalAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order amount" });
    }

    const user = await UserModel.findById(userId)
      .select("name email phone")
      .lean();

    const txnid = genTxnId(order.orderNumber);
    const amount = order.totalAmount.toFixed(2); // PayU: 2 decimal string
    const productinfo = `Order ${order.orderNumber}`;
    const firstname = (
      order.deliveryAddress?.fullName ||
      user?.name ||
      "Customer"
    ).split(" ")[0];
    const email = user?.email || "noemail@example.com";
    const phone = order.deliveryAddress?.phone || user?.phone || "";

    const udf1 = String(order._id); // callback e order khuje pawar jonno

    const hash = generateRequestHash({
      txnid,
      amount,
      productinfo,
      firstname,
      email,
      udf1,
    });

    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          paymentStatus: "INITIATED",
          paymentExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
        $push: { paymentAttempts: { txnid, amount: Number(amount) } },
      },
    );

    return res.status(200).json({
      success: true,
      message: "Payment initiated",
      paymentUrl: PAYU_PAYMENT_URL,
      // frontend eta ekta hidden form e POST korbe paymentUrl e
      payuParams: {
        key: PAYU_KEY,
        txnid,
        amount,
        productinfo,
        firstname,
        email,
        phone,
        udf1,
        surl: `${BACKEND_URL}/api/payment/payu/success`,
        furl: `${BACKEND_URL}/api/payment/payu/failure`,
        hash,
      },
    });
  } catch (error) {
    return handleError(res, error, "Initiate Payment Error");
  }
};

// ============ internal: apply PayU result to order (idempotent) ============
const applyPaymentResult = async (payload) => {
  const { txnid, status, mihpayid, mode, bank_ref_num, error_Message, udf1 } =
    payload;

  const order = await OrderModel.findOne({
    _id: udf1,
    "paymentAttempts.txnid": txnid,
  });
  if (!order) return { order: null };

  // already PAID hole kichu korbo na (duplicate callback)
  if (order.paymentStatus === "PAID") return { order, already: true };

  // amount tamper check: PayU er amount == amar attempt er amount
  const attempt = order.paymentAttempts.find((a) => a.txnid === txnid);
  if (!attempt || Number(payload.amount) !== Number(attempt.amount)) {
    return { order, tampered: true };
  }

  const success = String(status).toLowerCase() === "success";

  if (success) {
    const updated = await OrderModel.findOneAndUpdate(
      {
        _id: order._id,
        paymentStatus: { $ne: "PAID" },
        "paymentAttempts.txnid": txnid,
      },
      {
        $set: {
          paymentStatus: "PAID",
          paidAt: new Date(),
          paymentExpiresAt: null,
          "paymentAttempts.$.status": "SUCCESS",
          "paymentAttempts.$.mihpayid": mihpayid || null,
          "paymentAttempts.$.mode": mode || null,
          "paymentAttempts.$.bankRefNum": bank_ref_num || null,
          "paymentAttempts.$.completedAt": new Date(),
        },
      },
      { new: true },
    ).lean();
    return { order: updated || order, success: true };
  }

  const updated = await OrderModel.findOneAndUpdate(
    { _id: order._id, paymentStatus: { $nin: ["PAID", "FAILED"] } },
    {
      $set: {
        paymentStatus: "FAILED",
        "paymentAttempts.$[a].status": "FAILED",
        "paymentAttempts.$[a].mihpayid": mihpayid || null,
        "paymentAttempts.$[a].errorMessage": error_Message || null,
        "paymentAttempts.$[a].completedAt": new Date(),
      },
    },
    { new: true, arrayFilters: [{ "a.txnid": txnid }] },
  ).lean();
  return { order: updated || order, success: false };
};

// ============ 2. PAYU SUCCESS / FAILURE CALLBACK ============
// POST /api/payment/payu/success   &   /payu/failure  (PayU browser redirect)
const payuCallback = async (req, res) => {
  const payload = req.body || {};
  try {
    if (!isValidResponseHash(payload)) {
      console.error("PayU hash mismatch", payload.txnid);
      return res.redirect(
        `${FRONTEND_URL}/payment/result?status=invalid&txnid=${payload.txnid || ""}`,
      );
    }

    const result = await applyPaymentResult(payload);

    if (!result.order || result.tampered) {
      return res.redirect(
        `${FRONTEND_URL}/payment/result?status=invalid&txnid=${payload.txnid || ""}`,
      );
    }

    const ok = result.success || result.already;
    return res.redirect(
      `${FRONTEND_URL}/payment/result?status=${ok ? "success" : "failed"}` +
        `&orderId=${result.order._id}&txnid=${payload.txnid}`,
    );
  } catch (error) {
    console.error("PayU Callback Error:", error);
    return res.redirect(`${FRONTEND_URL}/payment/result?status=error`);
  }
};

// ============ 3. VERIFY / SYNC PAYMENT STATUS ============
// GET /api/payment/verify/:orderId   (frontend result page / postman theke)
const verifyPayment = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order id" });
    }

    const order = await OrderModel.findOne({ _id: orderId, userId });
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    // already final
    if (order.paymentStatus === "PAID") {
      return res.status(200).json({ success: true, order });
    }

    const last = order.paymentAttempts[order.paymentAttempts.length - 1];
    if (last && last.status === "INITIATED") {
      const detail = await verifyPaymentWithPayU(last.txnid);
      if (detail && detail.status !== "pending") {
        await applyPaymentResult({
          txnid: last.txnid,
          status: detail.status,
          mihpayid: detail.mihpayid,
          mode: detail.mode,
          bank_ref_num: detail.bank_ref_num,
          error_Message: detail.error_Message,
          amount: detail.amt || detail.transaction_amount,
          udf1: String(order._id),
        });
      }
    }

    const fresh = await OrderModel.findById(orderId).lean();
    return res.status(200).json({ success: true, order: fresh });
  } catch (error) {
    return handleError(res, error, "Verify Payment Error");
  }
};

// ============ 4. EXPIRE UNPAID ONLINE ORDERS (cron) ============
// stock restore + auto cancel
const expireUnpaidOrders = async () => {
  const expired = await OrderModel.find({
    paymentMethod: "ONLINE",
    paymentStatus: { $in: ["PENDING", "INITIATED", "FAILED"] },
    status: "PENDING",
    paymentExpiresAt: { $lte: new Date() },
  })
    .select("_id userId")
    .lean();

  for (const o of expired) {
    const cancelled = await OrderModel.findOneAndUpdate(
      {
        _id: o._id,
        status: "PENDING",
        paymentStatus: { $in: ["PENDING", "INITIATED", "FAILED"] },
      },
      {
        $set: {
          status: "CANCELLED",
          cancelReason: "Payment not completed in time",
          cancelledBy: "USER",
        },
        $push: {
          statusHistory: {
            status: "CANCELLED",
            changedBy: o.userId,
            note: "Payment timeout",
            at: new Date(),
          },
        },
      },
      { new: true },
    ).lean();
    if (cancelled) await restoreOrderStock(cancelled, o.userId);
  }
};

const simulatePayment = async (req, res) => {
  try {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    const { orderId } = req.params;
    const userId = getUserId(req);
    const result = req.body?.result === "failure" ? "failure" : "success";

    if (!mongoose.isValidObjectId(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order id" });
    }

    const order = await OrderModel.findOne({ _id: orderId, userId });
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const last = order.paymentAttempts[order.paymentAttempts.length - 1];
    if (!last) {
      return res.status(400).json({
        success: false,
        message: "আগে POST /api/payment/initiate/:orderId কল করুন",
      });
    }

    await applyPaymentResult({
      txnid: last.txnid,
      status: result,
      mihpayid: `DEV${Date.now()}`,
      mode: "DEV",
      bank_ref_num: "DEV_REF",
      error_Message: result === "failure" ? "Simulated failure" : null,
      amount: last.amount,
      udf1: String(order._id),
    });

    const fresh = await OrderModel.findById(orderId).lean();
    return res.status(200).json({
      success: true,
      message: `Payment ${result} simulated`,
      order: fresh,
    });
  } catch (error) {
    return handleError(res, error, "Simulate Payment Error");
  }
};

module.exports = {
  initiatePayment,
  payuCallback,
  verifyPayment,
  expireUnpaidOrders,
  simulatePayment,
};
