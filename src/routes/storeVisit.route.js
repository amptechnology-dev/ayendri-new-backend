const router = require("express").Router();
const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const {
  registerStoreVisit,
  getStoreVisitors,
  getVisitorDetails,
  getStoreCustomers,
  getCustomerDetails,
} = require("../controller/storeVisit.controller.js");

// mobile app (USER) store visit register kore
router.post("/", verifyJwt, authorize("USER"), registerStoreVisit);

// dashboard (STORE) visitors: visited but no order (masked unless store.isVisitor)
router.get("/visitors", verifyJwt, authorize("STORE"), getStoreVisitors);
router.get(
  "/visitors/:visitId",
  verifyJwt,
  authorize("STORE"),
  getVisitorDetails,
);

// dashboard (STORE) customers: users with orders in the store
router.get("/customers", verifyJwt, authorize("STORE"), getStoreCustomers);
router.get(
  "/customers/:userId",
  verifyJwt,
  authorize("STORE"),
  getCustomerDetails,
);

module.exports = router;