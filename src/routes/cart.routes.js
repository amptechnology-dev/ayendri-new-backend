const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");

const {
  addToCart,
  getCart,
  updateCartItem,
  removeCartItem,
  removeStoreItems,
  clearCart,
} = require("../controller/cart.controller.js");

router.use(verifyJwt, authorize("USER"));

router.post("/add", addToCart);
router.get("/", getCart);
router.patch("/items/:itemId", updateCartItem);
router.delete("/items/:itemId", removeCartItem);
router.delete("/stores/:storeId", removeStoreItems);
router.delete("/", clearCart);

module.exports = router;