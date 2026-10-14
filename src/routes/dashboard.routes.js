const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");

const { adminDashboard, storeDashboard } = require("../controller/dashboard.controller.js");

router.get("/admin", verifyJwt, authorize("ADMIN"), adminDashboard);
router.get("/store", verifyJwt, authorize("STORE"), storeDashboard);

module.exports = router;