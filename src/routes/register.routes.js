const router = require("express").Router();

const {
  registerAdmin,
  registerOwner,
  registerUser,
  createUser,
  allStores,
  singleStore,
  updateStoreAndUser,
  deleteStoreAndUser,
  userBasedStores,
  publicAllStores,
  storeWithProducts,
  registerStoreOwner,
  verifyStoreStatus,
  createStore,
  updateStoreFeatured,
  verifyEmailOTP,
  storesBySubCategory,
  searchStoreNames,
  allStates,
  storesByState,
  recentSearchStores,
  clearRecentSearches,
  relatedStores,
  nearbyStores,
  generateStoreQrCode
} = require("../controller/register.controller.js");
const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const { uploadMultiImages } = require("../middleware/multiMulter.js");

router.post("/create-admin", registerAdmin);
// router.get("/all-admins", allAdmin);
router.post("/create-user", uploadMultiImages, createUser);
router.post("/register-owner", registerOwner);
router.post("/register-user", registerUser);
router.post("/verify-email-otp", verifyEmailOTP);
router.post("/register-store-owner", uploadMultiImages, registerStoreOwner);
router.post("/create-store", verifyJwt, uploadMultiImages, createStore);
router.get("/all-stores", allStores);
router.get("/single-store/:storeId", verifyJwt, singleStore);
router.put(
  "/update-store-and-user/:storeId",
  verifyJwt,
  uploadMultiImages,
  updateStoreAndUser,
);
router.delete("/delete-store-and-user/:storeId", deleteStoreAndUser);
router.get("/user-based-stores", verifyJwt, userBasedStores);
router.get("/public-all-stores", publicAllStores);
router.get("/store-with-products/:storeId", verifyJwt, storeWithProducts);
router.patch("/verify-store-status/:storeId", verifyStoreStatus);
router.patch("/update-store-featured/:storeId", updateStoreFeatured);
router.get("/stores-by-subcategory/:subCategoryId", storesBySubCategory);
router.get("/search-store-names", searchStoreNames);
router.get("/all-states", allStates);
router.get("/stores-by-state/:state", storesByState);
router.get("/recent-search-stores", verifyJwt, recentSearchStores);
router.delete("/clear-recent-searches", verifyJwt, clearRecentSearches);
router.get("/related-stores/:storeId", relatedStores);
router.get("/nearby-stores", verifyJwt, nearbyStores);
router.post("/generate-store-qr/:storeId", verifyJwt, generateStoreQrCode);

module.exports = router;
