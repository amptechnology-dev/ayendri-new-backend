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
  checkoutPreview,
  getShippingOptions, // [নতুন]
  selectShippingOption, // [নতুন]
} = require("../controller/order.controller.js");
const {
  createOrderRequest,
  getMyRequests,
  getStoreRequests,
  decideRequest,
  completeRequest,
} = require("../controller/orderRequest.controller.js");

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
// return / replace / refund request
router.post(
  "/my-orders/:orderId/requests",
  verifyJwt,
  authorize("USER"),
  createOrderRequest,
);
router.get("/my-requests", verifyJwt, authorize("USER"), getMyRequests);

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
// [নতুন] delivery speed (koto din / Air / Surface) onujayi courier list + select
router.get(
  "/store-orders/:orderId/shipping-options",
  verifyJwt,
  authorize("STORE"),
  getShippingOptions,
);
router.patch(
  "/store-orders/:orderId/delivery-option",
  verifyJwt,
  authorize("STORE"),
  selectShippingOption,
);
// price estimate pathano
router.patch(
  "/store-orders/:orderId/quote",
  verifyJwt,
  authorize("STORE"),
  submitQuote,
);
router.patch(
  "/store-requests/:requestId/decision",
  verifyJwt,
  authorize("STORE"),
  decideRequest,
);
router.patch(
  "/store-requests/:requestId/complete",
  verifyJwt,
  authorize("STORE"),
  completeRequest,
);
router.get(
  "/store-requests",
  verifyJwt,
  authorize("STORE", "ADMIN"),
  getStoreRequests,
);

module.exports = router;