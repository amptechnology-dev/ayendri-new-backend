const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const { uploadMultiImages } = require("../middleware/multiMulter.js");

const {
  addReview,
  updateReview,
  deleteReview,
  getProductReviews,
} = require("../controller/productReview.controller.js");

router.get("/:productId/reviews", getProductReviews);

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
