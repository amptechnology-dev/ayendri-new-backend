const router = require("express").Router();
const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const { uploadApk } = require("../middleware/apkUpload.js");
const {
  upsertAppRelease,
  getAllAppReleases,
  getSingleAppRelease,
  deleteAppRelease,
  getLatestAppRelease,
} = require("../controller/appRelease.controller.js");

// ---------- PUBLIC ----------
router.get("/latest", getLatestAppRelease);

// ---------- ADMIN ----------
router.post(
  "/upsert",
  verifyJwt,
  authorize("ADMIN"),
  uploadApk,
  upsertAppRelease,
);
router.get("/all", verifyJwt, authorize("ADMIN"), getAllAppReleases);
router.get("/single/:id", verifyJwt, authorize("ADMIN"), getSingleAppRelease);
router.delete("/delete/:id", verifyJwt, authorize("ADMIN"), deleteAppRelease);

module.exports = router;