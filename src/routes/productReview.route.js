const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const { uploadMultiImages } = require("../middleware/multiMulter.js");

const {
  addReview,
  updateReview,
  deleteReview,
  getProductReviews,
  replyToReview,
  deleteReply,
  getStoreOwnerReviews,
} = require("../controller/productReview.controller.js");

// ---------- STORE: nijer shob product er review + reply ----------
router.get("/my-store-reviews", verifyJwt, authorize("STORE"), getStoreOwnerReviews);

router.post(
  "/:productId/reviews/:reviewId/reply",
  verifyJwt,
  authorize("STORE"),
  replyToReview,
);
router.delete(
  "/:productId/reviews/:reviewId/reply",
  verifyJwt,
  authorize("STORE"),
  deleteReply,
);

// ---------- PUBLIC ----------
router.get("/:productId/reviews", getProductReviews);

// ---------- USER ----------
router.post(
  "/:productId/reviews",
  verifyJwt,
  authorize("USER"),
  uploadMultiImages,
  addReview,
);
router.put(
  "/:productId/reviews/:reviewId",
  verifyJwt,
  authorize("USER"),
  uploadMultiImages,
  updateReview,
);
router.delete(
  "/:productId/reviews/:reviewId",
  verifyJwt,
  authorize("USER"),
  deleteReview,
);

module.exports = router;