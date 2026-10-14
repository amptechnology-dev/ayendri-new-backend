const router = require("express").Router();
const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const {
  initiatePayment,
  payuCallback,
  verifyPayment,
  simulatePayment,
} = require("../controller/payment.controller.js");
const {
  getReportMeta,
  getCustomerPaymentReport,
  getCustomerPaymentDetail,
  getStorePaymentReport,
  getStorePaymentDetail,
} = require("../controller/paymentReport.controller.js");
const {
  getPayoutStores,
  getPayoutStoreDetail,
  createPayout,
  voidPayout,
  getMyPayouts,
} = require("../controller/payout.controller.js");

// ===================== USER =====================
router.post(
  "/initiate/:orderId",
  verifyJwt,
  authorize("USER"),
  initiatePayment,
);
router.get("/verify/:orderId", verifyJwt, authorize("USER"), verifyPayment);

// ===================== PAYU CALLBACK (public, PayU redirect) =====================
router.post("/payu/success", payuCallback);
router.post("/payu/failure", payuCallback);

// ===================== PAYMENT REPORT =====================
router.get(
  "/report/meta",
  verifyJwt,
  authorize("STORE", "ADMIN"),
  getReportMeta,
);

router.get(
  "/report/customers",
  verifyJwt,
  authorize("STORE"),
  getCustomerPaymentReport,
);
router.get(
  "/report/customers/:customerId",
  verifyJwt,
  authorize("STORE"),
  getCustomerPaymentDetail,
);

router.get(
  "/report/stores",
  verifyJwt,
  authorize("STORE", "ADMIN"),
  getStorePaymentReport,
);
router.get(
  "/report/stores/:storeId",
  verifyJwt,
  authorize("STORE", "ADMIN"),
  getStorePaymentDetail,
);

// ===================== PAYOUT (ADMIN -> STORE settlement) =====================
// STORE: admin theke koto taka peyeche + history
router.get("/payout/my", verifyJwt, authorize("STORE"), getMyPayouts);

// ADMIN: shob store er received / paid / pending
router.get("/payout/stores", verifyJwt, authorize("ADMIN"), getPayoutStores);
// ADMIN: ekta store er summary + payout history
router.get(
  "/payout/stores/:storeId",
  verifyJwt,
  authorize("ADMIN"),
  getPayoutStoreDetail,
);
// ADMIN: store ke taka dewa (payout record toiri)
router.post(
  "/payout/stores/:storeId",
  verifyJwt,
  authorize("ADMIN"),
  createPayout,
);
// ADMIN: bhul payout void
router.patch(
  "/payout/:payoutId/void",
  verifyJwt,
  authorize("ADMIN"),
  voidPayout,
);

// ===================== TESTING ONLY =====================
router.post(
  "/dev/simulate/:orderId",
  verifyJwt,
  authorize("USER"),
  simulatePayment,
);

module.exports = router;