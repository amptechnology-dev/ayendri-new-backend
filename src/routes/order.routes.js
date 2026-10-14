const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");

const {
  checkout,
  buyNow,
  getMyOrders,
  getMyOrdersByStore,
  getMyOrderById,
  cancelMyOrder,
  respondToQuote,
  getStoreOrders,
  getStoreOrderById,
  updateOrderStatus,
  updateDeliveryDate,
  submitQuote,
  checkoutPreview
} = require("../controller/order.controller.js");

// ---------- USER ----------
router.post("/checkout", verifyJwt, authorize("USER"), checkout);
router.post("/buy-now", verifyJwt, authorize("USER"), buyNow);
router.get("/my-orders", verifyJwt, authorize("USER"), getMyOrders);
router.get(
  "/my-orders/by-store",
  verifyJwt,
  authorize("USER"),
  getMyOrdersByStore,
);
router.get("/my-orders/:orderId", verifyJwt, authorize("USER"), getMyOrderById);
router.patch(
  "/my-orders/:orderId/cancel",
  verifyJwt,
  authorize("USER"),
  cancelMyOrder,
);
// price estimate accept / reject
router.patch(
  "/my-orders/:orderId/quote",
  verifyJwt,
  authorize("USER"),
  respondToQuote,
);
router.post(
  "/checkout-preview",
  verifyJwt,
  authorize("USER"),
  checkoutPreview,
);

// ---------- STORE ----------
router.get("/store-orders", verifyJwt, authorize("STORE"), getStoreOrders);
router.get(
  "/store-orders/:orderId",
  verifyJwt,
  authorize("STORE"),
  getStoreOrderById,
);
router.patch(
  "/store-orders/:orderId/status",
  verifyJwt,
  authorize("STORE"),
  updateOrderStatus,
);
router.patch(
  "/store-orders/:orderId/delivery-date",
  verifyJwt,
  authorize("STORE"),
  updateDeliveryDate,
);
// price estimate pathano
router.patch(
  "/store-orders/:orderId/quote",
  verifyJwt,
  authorize("STORE"),
  submitQuote,
);

module.exports = router;