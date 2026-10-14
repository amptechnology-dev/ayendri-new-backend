const router = require("express").Router();
const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const {
  upsertCompanyInfo,
  getCompanyInfo,
  deleteCompanyInfo,
} = require("../controller/company.controller.js");

// PUBLIC
router.get("/", getCompanyInfo);

// ADMIN only
router.put("/", verifyJwt, authorize("ADMIN"), upsertCompanyInfo);
router.delete("/", verifyJwt, authorize("ADMIN"), deleteCompanyInfo);

module.exports = router;