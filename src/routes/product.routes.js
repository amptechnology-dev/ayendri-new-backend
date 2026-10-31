const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const { uploadMultiImages } = require("../middleware/multiMulter.js");

const {
  createProduct,
  getAllProducts,
  updateProduct,
  deleteProduct,
  getSingleProduct,
  allProductWithStore,
  verifyStatus,
  getStoreCategories,
  getStoreProducts,
  getStoreProductsByCategory,
  getStoreSingleProduct,
  getProductPickupAddress,
  getBookingAvailability
} = require("../controller/product.controller.js");

// ---------- STORE (authenticated) ----------
router.post(
  "/create-product",
  verifyJwt,
  authorize("STORE"),
  uploadMultiImages,
  createProduct,
);
router.put(
  "/update-product/:id",
  verifyJwt,
  authorize("STORE"),
  uploadMultiImages,
  updateProduct,
);
router.get("/all-products", verifyJwt, authorize("STORE"), getAllProducts);
router.get("/single-product/:id", getSingleProduct);
router.get(
  "/all-products-with-store",
  verifyJwt,
  authorize("STORE"),
  allProductWithStore,
);
router.delete("/delete-product/:id", deleteProduct);
router.patch("/verify-status/:id", verifyJwt, authorize("STORE"), verifyStatus);

// ---------- STOREFRONT (public, by storeUniqueId) ----------
router.get("/store/:storeUniqueId/categories", getStoreCategories);
router.get(
  "/store/:storeUniqueId/categories/:categoryId/products",
  getStoreProductsByCategory,
);
router.get("/store/:storeUniqueId/products", getStoreProducts);
router.get("/store/:storeUniqueId/products/:productId", getStoreSingleProduct);
router.get(
  "/pickup-address/:id",
  verifyJwt,
  authorize("STORE"),
  getProductPickupAddress,
);

router.get(
  "/store/:storeUniqueId/products/:productId/availability",
  getBookingAvailability,
);

module.exports = router;
