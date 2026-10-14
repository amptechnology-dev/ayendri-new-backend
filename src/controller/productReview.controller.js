const ProductModel = require("../model/product.model.js");
const { uploadToR2 } = require("../helper/upload.js");

// ===================== HELPER =====================
// reviews array theke averageRating + totalReviews recalculate kore
// (eta na thakle listing/sort-e proti bar reviews.length loop korte hobe)
const recalcRatingStats = (product) => {
  const total = product.reviews.length;
  const avg =
    total === 0
      ? 0
      : product.reviews.reduce((sum, r) => sum + r.rating, 0) / total;

  product.totalReviews = total;
  product.averageRating = Math.round(avg * 10) / 10; // 1 decimal e round
};

// ===================== 1. ADD REVIEW =====================
// POST /product/:productId/reviews  (multipart/form-data: comment, rating, image?)
const addReview = async (req, res) => {
  try {
    const { productId } = req.params;
    const { comment, rating } = req.body;
    const userId = req.user?._id || req.user?.id;

    if (!rating) {
      return res.status(400).json({ message: "Rating is required" });
    }

    const product = await ProductModel.findById(productId);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const alreadyReviewed = product.reviews.find(
      (review) => review.userId.toString() === userId.toString(),
    );
    if (alreadyReviewed) {
      return res.status(400).json({
        message: "You already reviewed this product",
      });
    }

    let image = null;
    if (req.files?.length) {
      const file = req.files.find((f) => f.fieldname.startsWith("image"));
      if (file) {
        const fileName = `amp-store/review/${Date.now()}-${file.originalname}`;
        image = await uploadToR2(file.buffer, fileName, file.mimetype);
      }
    }

    const newReview = {
      comment,
      rating,
      userId,
      image,
    };

    product.reviews.push(newReview);
    recalcRatingStats(product);

    await product.save();

    return res.status(201).json({
      message: "Review added successfully",
      averageRating: product.averageRating,
      totalReviews: product.totalReviews,
      reviews: product.reviews,
    });
  } catch (error) {
    console.log(error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => ({
        field: e.path,
        message: e.message,
      }));
      return res.status(400).json({ message: "Validation failed", errors });
    }

    return res.status(500).json({ message: "Failed to add review" });
  }
};

// ===================== 2. UPDATE REVIEW =====================
// PUT /product/:productId/reviews/:reviewId
const updateReview = async (req, res) => {
  try {
    const { productId, reviewId } = req.params;
    const { comment, rating } = req.body;
    const userId = req.user?._id || req.user?.id;

    const product = await ProductModel.findById(productId);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const review = product.reviews.id(reviewId);
    if (!review) {
      return res.status(404).json({ message: "Review not found" });
    }

    if (review.userId.toString() !== userId.toString()) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    if (req.files?.length) {
      const file = req.files.find((f) => f.fieldname.startsWith("image"));
      if (file) {
        const fileName = `amp-store/review/${Date.now()}-${file.originalname}`;
        review.image = await uploadToR2(file.buffer, fileName, file.mimetype);
      }
    }

    review.comment = comment ?? review.comment;
    review.rating = rating ?? review.rating;

    recalcRatingStats(product);

    await product.save();

    return res.status(200).json({
      message: "Review updated successfully",
      averageRating: product.averageRating,
      totalReviews: product.totalReviews,
      review,
    });
  } catch (error) {
    console.log(error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => ({
        field: e.path,
        message: e.message,
      }));
      return res.status(400).json({ message: "Validation failed", errors });
    }

    return res.status(500).json({ message: "Failed to update review" });
  }
};

// ===================== 3. DELETE REVIEW =====================
// DELETE /product/:productId/reviews/:reviewId
const deleteReview = async (req, res) => {
  try {
    const { productId, reviewId } = req.params;
    const userId = req.user?._id || req.user?.id;

    const product = await ProductModel.findById(productId);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const review = product.reviews.id(reviewId);
    if (!review) {
      return res.status(404).json({ message: "Review not found" });
    }

    if (review.userId.toString() !== userId.toString()) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    product.reviews.pull(reviewId);
    recalcRatingStats(product);

    await product.save();

    return res.status(200).json({
      message: "Review deleted successfully",
      averageRating: product.averageRating,
      totalReviews: product.totalReviews,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({ message: "Failed to delete review" });
  }
};

// ===================== 4. GET PRODUCT REVIEWS =====================
// GET /product/:productId/reviews
const getProductReviews = async (req, res) => {
  try {
    const { productId } = req.params;

    const product = await ProductModel.findById(productId)
      .select("reviews averageRating totalReviews")
      .populate({
        path: "reviews.userId",
        select: "name email picture",
      });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.status(200).json({
      averageRating: product.averageRating,
      totalReviews: product.totalReviews,
      reviews: product.reviews,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({ message: "Failed to get reviews" });
  }
};

module.exports = { addReview, updateReview, deleteReview, getProductReviews };