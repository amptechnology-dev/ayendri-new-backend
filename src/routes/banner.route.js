const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const { uploadMultiImages } = require("../middleware/multiMulter.js");

const {
  getProductOptions,
  createBanner,
  getAllBanners,
  getSingleBanner,
  updateBanner,
  deleteBanner,
  publicGetAllBanners,
  publicGetOfferBanners,
  publicGetBannersByCategory,
} = require("../controller/banner.controller.js");

// ---------- STORE (authenticated) ----------
router.get(
  "/product-options",
  verifyJwt,
  authorize("STORE"),
  getProductOptions,
);
router.post(
  "/create-banner",
  verifyJwt,
  authorize("STORE"),
  uploadMultiImages,
  createBanner,
);
router.put(
  "/update-banner/:id",
  verifyJwt,
  authorize("STORE"),
  uploadMultiImages,
  updateBanner,
);
router.get("/all-banners", verifyJwt, authorize("STORE"), getAllBanners);
router.get(
  "/single-banner/:id",
  verifyJwt,
  authorize("STORE"),
  getSingleBanner,
);
router.delete(
  "/delete-banner/:id",
  verifyJwt,
  authorize("STORE"),
  deleteBanner,
);

// ---------- PUBLIC ----------
router.get("/banners", publicGetAllBanners);
router.get("/public/offer-banners", publicGetOfferBanners);
router.get("/public/by-category/:categoryId", publicGetBannersByCategory);

module.exports = router;