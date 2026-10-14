const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser");
const authorize = require("../middleware/authorize");
const { uploadMultiImages } = require("../middleware/multiMulter");

const {
  createAds,
  allAds,
  publicAds,
  singleAds,
  updateAds,
  deleteAds,
} = require("../controller/ads.controller");

// ---------- PUBLIC ----------
router.get("/public", publicAds); // "/:adsId" er age thakte hobe

// ---------- PROTECTED (CRUD) ----------
router.post("/", verifyJwt, authorize("ADMIN"), uploadMultiImages, createAds);
router.get("/", verifyJwt, authorize("ADMIN"), allAds);
router.get("/:adsId", verifyJwt, authorize("ADMIN"), singleAds);
router.put("/:adsId", verifyJwt, authorize("ADMIN"), uploadMultiImages, updateAds);
router.delete("/:adsId", verifyJwt, authorize("ADMIN"), deleteAds);

module.exports = router;