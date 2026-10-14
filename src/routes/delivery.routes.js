const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");

const {
  saveDeliverySettings,
  getDeliverySettings,
  previewServicePincodes,
  checkDelivery,
  lookupPincode,
  getMyPincode,
  createShiprocketShipment,
  courierWebhook,
} = require("../controller/delivery.controller.js");

// ---------- STORE ----------
router.put("/settings", verifyJwt, authorize("STORE"), saveDeliverySettings);
router.get(
  "/settings/:storeId",
  verifyJwt,
  authorize("STORE"),
  getDeliverySettings,
);
router.get(
  "/settings/:storeId/service-pincodes",
  verifyJwt,
  authorize("STORE"),
  previewServicePincodes,
);
// NATIONAL order er courier shipment (Shiprocket)
router.post(
  "/orders/:orderId/shipment",
  verifyJwt,
  authorize("STORE"),
  createShiprocketShipment,
);

// ---------- USER ----------
router.get("/my-pincode", verifyJwt, authorize("USER"), getMyPincode);

// ---------- PUBLIC (user app / storefront) ----------
router.get("/check", checkDelivery);
router.get("/pincode/:pincode", lookupPincode);

// ---------- WEBHOOK (courier -> amader server, x-api-key diye secure) ----------
router.post("/courier-webhook", courierWebhook);

module.exports = router;