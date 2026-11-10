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
const { processInvoice } = require("../helper/invoice.js");
const { startFulfilment } = require("../helper/fulfilment.js"); 
const CheckoutSessionModel = require("../model/checkoutSession.model.js");
const {
  restoreOrderStock,
  publicSession,
  releaseSessionHolds,
  finalizeSessionOrder,
  notifyOrderPlaced,
} = require("./order.controller.js"); // age-r restoreOrderStock er line replace

const BACKEND_URL = process.env.BACKEND_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;

const getUserId = (req) => req.user?._id || req.user?.id;

const genTxnId = (orderNumber) =>
  `${orderNumber}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;

// PayU txnid max 25 char. "CS-" prefix diye session txn chena jay
const genSessionTxnId = () =>
  `CS-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
const isSessionTxn = (txnid) => String(txnid || "").startsWith("CS-");

// session theke order toiri holeo ei hook gulo chalate hobe (ekbar)
const afterSessionOrderCreated = (order) => {
  notifyOrderPlaced(order);
  processInvoice(order._id).catch((e) =>
    console.error("Invoice error:", e.message),
  );
  startFulfilment(order._id).catch((e) =>
    console.error("Auto shipment error:", e.message),
  );
};

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

    // updated thakle mane ei call ei PAID set hoyeche (duplicate callback e null ashbe)
    if (updated) {
      processInvoice(updated._id).catch((e) =>
        console.error("Invoice error:", e.message),
      );

      // 🔥 CHANGED (2): PAID save howar por auto fulfilment/shipment
      startFulfilment(updated._id).catch((e) =>
        console.error("Auto shipment error:", e.message),
      );
    }
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


// ============ SESSION: INITIATE PAYMENT ============
// POST /api/payment/session/initiate/:sessionId
const initiateSessionPayment = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(sessionId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid session id" });
    }
    initiatePaymentSchema.parse(req.body || {});

    const session = await CheckoutSessionModel.findOne({
      _id: sessionId,
      userId,
    }).lean();
    if (!session) {
      return res
        .status(404)
        .json({ success: false, message: "Checkout session not found" });
    }
    if (session.status === "PAID") {
      return res.status(400).json({
        success: false,
        message: "Payment already completed",
        orderId: session.orderId || null,
      });
    }
    if (session.status !== "PENDING" || new Date(session.expiresAt) <= new Date()) {
      return res.status(410).json({
        success: false,
        code: "SESSION_EXPIRED",
        message: "Payment time is over. Please place the order again",
      });
    }
    if (!session.amount || session.amount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order amount" });
    }

    const user = await UserModel.findById(userId)
      .select("name email phone")
      .lean();
    const addr = session.orderPayload?.deliveryAddress;

    const txnid = genSessionTxnId();
    const amount = Number(session.amount).toFixed(2);
    const productinfo = `Order ${String(session._id).slice(-8).toUpperCase()}`;
    const firstname = (addr?.fullName || user?.name || "Customer").split(" ")[0];
    const email = user?.email || "noemail@example.com";
    const phone = addr?.phone || user?.phone || "";
    const udf1 = String(session._id);

    const hash = generateRequestHash({
      txnid,
      amount,
      productinfo,
      firstname,
      email,
      udf1,
    });

    // expiresAt barano hocche na: stock hold er time fixed
    const upd = await CheckoutSessionModel.updateOne(
      { _id: session._id, status: "PENDING" },
      { $push: { attempts: { txnid, amount: Number(amount) } } },
    );
    if (!upd.modifiedCount) {
      return res.status(409).json({
        success: false,
        message: "Session has just changed, please refresh",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Payment initiated",
      paymentUrl: PAYU_PAYMENT_URL,
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
    return handleError(res, error, "Initiate Session Payment Error");
  }
};

// ============ internal: PayU result -> session -> order (idempotent) ============
const applySessionPayment = async (payload) => {
  const { txnid, status, mihpayid, mode, bank_ref_num, error_Message, udf1 } =
    payload;

  if (!mongoose.isValidObjectId(udf1)) return { session: null };

  const session = await CheckoutSessionModel.findOne({
    _id: udf1,
    "attempts.txnid": txnid,
  }).lean();
  if (!session) return { session: null };

  // PAID session theke order (na thakle) toiri + hook (ekbar)
  const settle = async (id) => {
    const { order, created } = await finalizeSessionOrder(id);
    if (created && order) afterSessionOrderCreated(order);
    return order;
  };

  // duplicate callback / age paid hoye order toiri hoyni (retry)
  if (session.status === "PAID") {
    const order = await settle(session._id);
    return { session, order, success: true, already: true };
  }

  // amount tamper check
  const attempt = session.attempts.find((a) => a.txnid === txnid);
  if (!attempt || Number(payload.amount) !== Number(attempt.amount)) {
    return { session, tampered: true };
  }

  const success = String(status).toLowerCase() === "success";
  const now = new Date();

  if (!success) {
    // session PENDING thake, user retry korte pabe
    await CheckoutSessionModel.updateOne(
      { _id: session._id, status: "PENDING" },
      {
        $set: {
          "attempts.$[a].status": "FAILED",
          "attempts.$[a].mihpayid": mihpayid || null,
          "attempts.$[a].errorMessage": error_Message || null,
          "attempts.$[a].completedAt": now,
        },
      },
      { arrayFilters: [{ "a.txnid": txnid, "a.status": "INITIATED" }] },
    );
    return { session, success: false };
  }

  // atomic claim: PENDING -> PAID (ekjon-i order banabe)
  const claimed = await CheckoutSessionModel.findOneAndUpdate(
    { _id: session._id, status: "PENDING", "attempts.txnid": txnid },
    {
      $set: {
        status: "PAID",
        paidAt: now,
        "attempts.$.status": "SUCCESS",
        "attempts.$.mihpayid": mihpayid || null,
        "attempts.$.mode": mode || null,
        "attempts.$.bankRefNum": bank_ref_num || null,
        "attempts.$.completedAt": now,
      },
    },
    { new: true },
  ).lean();

  if (claimed) {
    const order = await settle(claimed._id);
    return { session: claimed, order, success: true };
  }

  // PENDING nai: race (onno request PAID korlo) ba session expire hoye stock release hoye geche
  const current = await CheckoutSessionModel.findById(session._id).lean();
  if (current?.status === "PAID") {
    const order = await settle(current._id);
    return { session: current, order, success: true, already: true };
  }

  // taka kete geche kintu session expire: manual refund lagbe
  await CheckoutSessionModel.updateOne(
    { _id: session._id, status: { $ne: "PAID" } },
    {
      $set: {
        status: "REFUND_REQUIRED",
        paidAt: now,
        "attempts.$[a].status": "SUCCESS",
        "attempts.$[a].mihpayid": mihpayid || null,
        "attempts.$[a].mode": mode || null,
        "attempts.$[a].bankRefNum": bank_ref_num || null,
        "attempts.$[a].completedAt": now,
      },
    },
    { arrayFilters: [{ "a.txnid": txnid }] },
  );
  console.error(
    `LATE PAYMENT, REFUND REQUIRED: session=${session._id} txnid=${txnid} mihpayid=${mihpayid}`,
  );
  return { session: current, lateExpired: true, success: false };
};

// ============ 2. PAYU SUCCESS / FAILURE CALLBACK ============
// POST /api/payment/payu/success   &   /payu/failure  (PayU browser redirect)
const payuCallback = async (req, res) => {
  const payload = req.body || {};
  const enc = encodeURIComponent;
  try {
    if (!isValidResponseHash(payload)) {
      console.error("PayU hash mismatch", payload.txnid);
      return res.redirect(
        `${FRONTEND_URL}/payment/result?status=invalid&txnid=${enc(payload.txnid || "")}`,
      );
    }

    // ---------- [ONLINE checkout session] ----------
    if (isSessionTxn(payload.txnid)) {
      let result;
      try {
        result = await applySessionPayment(payload);
      } catch (err) {
        // taka kete thakte pare, order toiri fail: frontend session verify call korbe
        console.error("Session finalize error:", err);
        return res.redirect(
          `${FRONTEND_URL}/payment/result?status=error&sessionId=${enc(payload.udf1 || "")}&txnid=${enc(payload.txnid)}`,
        );
      }

      if (!result.session || result.tampered) {
        return res.redirect(
          `${FRONTEND_URL}/payment/result?status=invalid&txnid=${enc(payload.txnid)}`,
        );
      }
      if (result.lateExpired) {
        return res.redirect(
          `${FRONTEND_URL}/payment/result?status=expired&sessionId=${result.session._id}&txnid=${enc(payload.txnid)}`,
        );
      }

      const ok = !!result.success;
      return res.redirect(
        `${FRONTEND_URL}/payment/result?status=${ok ? "success" : "failed"}` +
          `&sessionId=${result.session._id}` +
          (ok && result.order ? `&orderId=${result.order._id}` : "") +
          `&txnid=${enc(payload.txnid)}`,
      );
    }

    // ---------- order-based payment (price-on-request quote order) ----------
    const result = await applyPaymentResult(payload);

    if (!result.order || result.tampered) {
      return res.redirect(
        `${FRONTEND_URL}/payment/result?status=invalid&txnid=${enc(payload.txnid || "")}`,
      );
    }

    const ok = result.success || result.already;
    return res.redirect(
      `${FRONTEND_URL}/payment/result?status=${ok ? "success" : "failed"}` +
        `&orderId=${result.order._id}&txnid=${enc(payload.txnid)}`,
    );
  } catch (error) {
    console.error("PayU Callback Error:", error);
    return res.redirect(`${FRONTEND_URL}/payment/result?status=error`);
  }
};

// ============ SESSION: VERIFY / SYNC ============
// GET /api/payment/session/verify/:sessionId
const verifySessionPayment = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(sessionId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid session id" });
    }

    const session = await CheckoutSessionModel.findOne({
      _id: sessionId,
      userId,
    }).lean();
    if (!session) {
      return res
        .status(404)
        .json({ success: false, message: "Checkout session not found" });
    }

    if (session.status === "PENDING") {
      const last = session.attempts[session.attempts.length - 1];
      if (last && last.status === "INITIATED") {
        const detail = await verifyPaymentWithPayU(last.txnid);
        if (detail && detail.status !== "pending") {
          await applySessionPayment({
            txnid: last.txnid,
            status: detail.status,
            mihpayid: detail.mihpayid,
            mode: detail.mode,
            bank_ref_num: detail.bank_ref_num,
            error_Message: detail.error_Message,
            amount: detail.amt || detail.transaction_amount,
            udf1: String(session._id),
          });
        }
      }
    } else if (session.status === "PAID" && !session.orderId) {
      // paid kintu order toiri fail hoyechilo: abar chesta
      const { order, created } = await finalizeSessionOrder(session._id);
      if (created && order) afterSessionOrderCreated(order);
    }

    const fresh = await CheckoutSessionModel.findById(sessionId).lean();
    const order = fresh.orderId
      ? await OrderModel.findById(fresh.orderId).lean()
      : null;

    return res.status(200).json({
      success: true,
      status: fresh.status,
      session: publicSession(fresh),
      order,
    });
  } catch (error) {
    return handleError(res, error, "Verify Session Payment Error");
  }
};

// ============ 4b. EXPIRE UNPAID SESSIONS (cron) ============
// stock + booking slot release. Expire er age PayU te ekbar check kore dekhe
const expireUnpaidSessions = async () => {
  const expired = await CheckoutSessionModel.find({
    status: "PENDING",
    expiresAt: { $lte: new Date() },
  }).lean();

  for (const s of expired) {
    try {
      const last = s.attempts[s.attempts.length - 1];
      if (last && last.status === "INITIATED") {
        const detail = await verifyPaymentWithPayU(last.txnid);
        if (detail && detail.status !== "pending") {
          const r = await applySessionPayment({
            txnid: last.txnid,
            status: detail.status,
            mihpayid: detail.mihpayid,
            mode: detail.mode,
            bank_ref_num: detail.bank_ref_num,
            error_Message: detail.error_Message,
            amount: detail.amt || detail.transaction_amount,
            udf1: String(s._id),
          });
          if (r.success) continue; // payment hoyeche, order toiri hoye geche
        }
      }

      const closed = await CheckoutSessionModel.findOneAndUpdate(
        { _id: s._id, status: "PENDING" }, // race guard
        { $set: { status: "EXPIRED" } },
        { new: true },
      ).lean();
      if (closed) await releaseSessionHolds(closed);
    } catch (e) {
      console.error("Expire session error:", s._id, e.message);
    }
  }

  // PAID kintu order toiri hoyni emon session abar chesta
  const stuck = await CheckoutSessionModel.find({
    status: "PAID",
    orderId: null,
    paidAt: { $lte: new Date(Date.now() - 60 * 1000) },
  })
    .select("_id")
    .lean();

  for (const s of stuck) {
    try {
      const { order, created } = await finalizeSessionOrder(s._id);
      if (created && order) afterSessionOrderCreated(order);
    } catch (e) {
      console.error("Retry finalize error:", s._id, e.message);
    }
  }
};

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

const expireUnpaidOrders = async () => {
  const expired = await OrderModel.find({
    paymentMethod: "ONLINE",
    status: { $in: ["PENDING", "CONFIRMED"] },
    paymentStatus: { $ne: "PAID" },
    paymentExpiresAt: { $lte: new Date() },
  })
    .select("_id userId")
    .lean();

  for (const o of expired) {
    const cancelled = await OrderModel.findOneAndUpdate(
      {
        _id: o._id,
        status: { $in: ["PENDING", "CONFIRMED"] },
        paymentStatus: { $ne: "PAID" },
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

  // [ONLINE checkout session] payment na howa session
  await expireUnpaidSessions();
};

// POST /api/payment/dev/simulate-session/:sessionId   body: { result: "success" | "failure" }
const simulateSessionPayment = async (req, res) => {
  try {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    const { sessionId } = req.params;
    const userId = getUserId(req);
    const result = req.body?.result === "failure" ? "failure" : "success";

    if (!mongoose.isValidObjectId(sessionId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid session id" });
    }

    const session = await CheckoutSessionModel.findOne({
      _id: sessionId,
      userId,
    }).lean();
    if (!session) {
      return res
        .status(404)
        .json({ success: false, message: "Checkout session not found" });
    }

    const last = session.attempts[session.attempts.length - 1];
    if (!last) {
      return res.status(400).json({
        success: false,
        message: "Age POST /api/payment/session/initiate/:sessionId call koro",
      });
    }

    await applySessionPayment({
      txnid: last.txnid,
      status: result,
      mihpayid: `DEV${Date.now()}`,
      mode: "DEV",
      bank_ref_num: "DEV_REF",
      error_Message: result === "failure" ? "Simulated failure" : null,
      amount: last.amount,
      udf1: String(session._id),
    });

    const fresh = await CheckoutSessionModel.findById(sessionId).lean();
    const order = fresh.orderId
      ? await OrderModel.findById(fresh.orderId).lean()
      : null;

    return res.status(200).json({
      success: true,
      message: `Payment ${result} simulated`,
      status: fresh.status,
      session: publicSession(fresh),
      order,
    });
  } catch (error) {
    return handleError(res, error, "Simulate Session Payment Error");
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
  initiateSessionPayment,
  payuCallback,
  verifyPayment,
  verifySessionPayment,
  expireUnpaidOrders,
  simulatePayment,
  simulateSessionPayment,
};