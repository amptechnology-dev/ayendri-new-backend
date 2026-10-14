const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const { getCartAndOrders } = require("../controller/profile.controller.js");

router.get("/cart-and-orders", verifyJwt, authorize("USER"), getCartAndOrders);

module.exports = router;