const router = require("express").Router();
const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const {
  upsertTermsCondition,
  getAllTermsConditions,
  getSingleTermsCondition,
  deleteTermsCondition,
  getActiveTermsConditions,
} = require("../controller/termsCondition.controller.js");

// ---------- PUBLIC ----------
router.get("/active", getActiveTermsConditions);

// ---------- ADMIN ----------
router.post("/upsert", verifyJwt, authorize("ADMIN"), upsertTermsCondition);
router.get("/all", verifyJwt, authorize("ADMIN"), getAllTermsConditions);
router.get("/single/:id", verifyJwt, authorize("ADMIN"), getSingleTermsCondition);
router.delete("/delete/:id", verifyJwt, authorize("ADMIN"), deleteTermsCondition);

module.exports = router;