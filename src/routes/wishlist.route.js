const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");

const {
  addToWishlist,
  toggleWishlist,
  getWishlist,
  removeWishlistItem,
  removeByProductId,
  removeStoreItems,
  clearWishlist,
} = require("../controller/wishlist.controller.js");

router.use(verifyJwt, authorize("USER"));

router.post("/add", addToWishlist);
router.post("/toggle", toggleWishlist);
router.get("/", getWishlist);
router.delete("/items/:itemId", removeWishlistItem);
router.delete("/product/:productId", removeByProductId);
router.delete("/stores/:storeId", removeStoreItems);
router.delete("/", clearWishlist);

module.exports = router;
