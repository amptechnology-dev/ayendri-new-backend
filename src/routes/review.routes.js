const router = require("express").Router();

const {addReview, updateReview, deleteReview, getStoreReviews} = require("../controller/review.controller.js");
const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");

router.post("/add-review/:storeId", verifyJwt, addReview);
router.put("/update-review/:storeId/:reviewId", verifyJwt, updateReview);
router.delete("/delete-review/:storeId/:reviewId", verifyJwt, deleteReview);
router.get("/store-reviews/:storeId", getStoreReviews);

module.exports = router;