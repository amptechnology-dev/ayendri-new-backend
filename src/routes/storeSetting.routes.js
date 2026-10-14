const router = require("express").Router();
const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const {
  getStoreSettingsController,
  updateStoreSettingsController,
} = require("../controller/storeSetting.controller.js");

router.get("/", verifyJwt, authorize("STORE"), getStoreSettingsController);
router.patch("/", verifyJwt, authorize("STORE"), updateStoreSettingsController);

module.exports = router;