const mongoose = require("mongoose");
const ProductModel = require("../model/product.model.js");
const { uploadToR2 } = require("../helper/upload.js");
const UserModel = require("../model/user.model.js");
const {
  notifyStoreNewReview,
  notifyUserReviewReply,
} = require("../helper/notification.helper.js");

const getUserId = (req) => req.user?._id || req.user?.id;

// ===================== HELPERS =====================
const recalcRatingStats = (product) => {
  const total = product.reviews.length;
  const avg =
    total === 0
      ? 0
      : product.reviews.reduce((sum, r) => sum + r.rating, 0) / total;

  product.totalReviews = total;
  product.averageRating = Math.round(avg * 10) / 10;
};

// 0.5 step e 0.5 - 5, noile null
const parseRating = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.5 || n > 5 || !Number.isInteger(n * 2)) {
    return null;
  }
  return n;
};

const RATING_ERROR = "Rating must be between 0.5 and 5 (in steps of 0.5)";
const COMMENT_MAX = 1000;

const uploadReviewImage = async (files) => {
  if (!files?.length) return null;
  const file = files.find((f) => f.fieldname.startsWith("image"));
  if (!file) return null;
  const fileName = `amp-store/review/${Date.now()}-${file.originalname}`;
  return uploadToR2(file.buffer, fileName, file.mimetype);
};

const sendError = (res, error, fallbackMessage) => {
  console.log(error);
  if (error.name === "ValidationError") {
    const errors = Object.values(error.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return res.status(400).json({ message: "Validation failed", errors });
  }
  return res.status(500).json({ message: fallbackMessage });
};

const SORTERS = {
  newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  top: (a, b) =>
    b.rating - a.rating || new Date(b.createdAt) - new Date(a.createdAt),
  lowest: (a, b) =>
    a.rating - b.rating || new Date(b.createdAt) - new Date(a.createdAt),
};

const addReview = async (req, res) => {
  try {
    const { productId } = req.params;
    const userId = getUserId(req);

    const rating = parseRating(req.body.rating);
    if (rating === null) {
      return res.status(400).json({ message: RATING_ERROR });
    }

    const comment = String(req.body.comment ?? "").trim();
    if (comment.length > COMMENT_MAX) {
      return res
        .status(400)
        .json({ message: `Comment cannot exceed ${COMMENT_MAX} characters` });
    }

    const product = await ProductModel.findById(productId);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const alreadyReviewed = product.reviews.find(
      (review) => review.userId.toString() === userId.toString(),
    );
    if (alreadyReviewed) {
      return res
        .status(400)
        .json({ message: "You already reviewed this product" });
    }

    const image = await uploadReviewImage(req.files);

    product.reviews.push({ comment, rating, userId, image });
    recalcRatingStats(product);
    await product.save();

    const savedReview = product.reviews[product.reviews.length - 1];

    // [NOTIFY] STORE ke notification (fire-and-forget, fail korleo review save hoye gechhe)
    UserModel.findById(userId)
      .select("name")
      .lean()
      .then((u) =>
        notifyStoreNewReview({
          product,
          review: savedReview,
          reviewerName: u?.name,
        }),
      )
      .catch((e) => console.error("Review notify error:", e));

    return res.status(201).json({
      message: "Review added successfully",
      averageRating: product.averageRating,
      totalReviews: product.totalReviews,
      review: savedReview,
    });
  } catch (error) {
    return sendError(res, error, "Failed to add review");
  }
};

// ===================== 2. UPDATE REVIEW =====================
// PUT /api/product/:productId/reviews/:reviewId
// body: rating?, comment?, image0? (new image), removeImage="true" (image muchte)
const updateReview = async (req, res) => {
  try {
    const { productId, reviewId } = req.params;
    const userId = getUserId(req);

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

    if (req.body.rating !== undefined && req.body.rating !== "") {
      const rating = parseRating(req.body.rating);
      if (rating === null) {
        return res.status(400).json({ message: RATING_ERROR });
      }
      review.rating = rating;
    }

    if (req.body.comment !== undefined) {
      const comment = String(req.body.comment).trim();
      if (comment.length > COMMENT_MAX) {
        return res.status(400).json({
          message: `Comment cannot exceed ${COMMENT_MAX} characters`,
        });
      }
      review.comment = comment;
    }

    const newImage = await uploadReviewImage(req.files);
    if (newImage) review.image = newImage;
    else if (String(req.body.removeImage) === "true") review.image = null;

    recalcRatingStats(product);
    await product.save();

    return res.status(200).json({
      message: "Review updated successfully",
      averageRating: product.averageRating,
      totalReviews: product.totalReviews,
      review,
    });
  } catch (error) {
    return sendError(res, error, "Failed to update review");
  }
};

// ===================== 3. DELETE REVIEW =====================
// DELETE /api/product/:productId/reviews/:reviewId
const deleteReview = async (req, res) => {
  try {
    const { productId, reviewId } = req.params;
    const userId = getUserId(req);

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
    return sendError(res, error, "Failed to delete review");
  }
};

// ===================== 4. GET PRODUCT REVIEWS (public) =====================
// GET /api/product/:productId/reviews?sort=newest|top|lowest&page=1&limit=10
const getProductReviews = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ message: "Invalid product id" });
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
    const sort = SORTERS[req.query.sort] ? req.query.sort : "newest";

    const product = await ProductModel.findById(productId)
      .select("reviews averageRating totalReviews")
      // email public API te dewa hobe na
      .populate({ path: "reviews.userId", select: "name picture" })
      .lean();

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const all = product.reviews || [];

    // 5..1 star breakdown (half star nearest full star e jay: 4.5 -> 5, 0.5 -> 1)
    const breakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    all.forEach((r) => {
      const bucket = Math.min(5, Math.max(1, Math.round(r.rating)));
      breakdown[bucket] += 1;
    });

    const sorted = [...all].sort(SORTERS[sort]);
    const totalPages = Math.max(Math.ceil(sorted.length / limit), 1);

    const reviews = sorted
      .slice((page - 1) * limit, page * limit)
      .map(({ userId, ...r }) => ({
        ...r,
        user:
          userId && userId._id
            ? { _id: userId._id, name: userId.name, picture: userId.picture }
            : null,
      }));

    return res.status(200).json({
      averageRating: product.averageRating || 0,
      totalReviews: product.totalReviews || 0,
      breakdown,
      page,
      totalPages,
      reviews,
    });
  } catch (error) {
    return sendError(res, error, "Failed to get reviews");
  }
};

const replyToReview = async (req, res) => {
  try {
    const { productId, reviewId } = req.params;
    const userId = getUserId(req);

    const text = String(req.body.text ?? "").trim();
    if (!text) {
      return res.status(400).json({ message: "Reply text is required" });
    }
    if (text.length > 1000) {
      return res
        .status(400)
        .json({ message: "Reply cannot exceed 1000 characters" });
    }

    // [NOTIFY] notification er jonno name, storeId, review er userId + purono reply lagbe
    const product = await ProductModel.findById(productId).select(
      "userId storeId name reviews._id reviews.userId reviews.reply",
    );
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }
    // shudhu product er owner (STORE) reply dite parbe
    if (String(product.userId) !== String(userId)) {
      return res.status(403).json({ message: "Unauthorized" });
    }
    const review = product.reviews.id(reviewId);
    if (!review) {
      return res.status(404).json({ message: "Review not found" });
    }

    const isFirstReply = !review.reply?.text;
    const reply = { text, repliedBy: userId, repliedAt: new Date() };

    await ProductModel.updateOne(
      { _id: productId, "reviews._id": reviewId },
      { $set: { "reviews.$.reply": reply } },
    );

    // [NOTIFY] shudhu prothom reply te USER ke janano (edit e bar bar notification jabe na)
    if (isFirstReply) {
      notifyUserReviewReply({ product, review });
    }

    return res.status(200).json({ message: "Reply saved", reply });
  } catch (error) {
    return sendError(res, error, "Failed to save reply");
  }
};

// ===================== 6. DELETE REPLY (STORE) =====================
// DELETE /api/product/:productId/reviews/:reviewId/reply
const deleteReply = async (req, res) => {
  try {
    const { productId, reviewId } = req.params;
    const userId = getUserId(req);

    const product = await ProductModel.findById(productId).select(
      "userId reviews._id",
    );
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }
    if (String(product.userId) !== String(userId)) {
      return res.status(403).json({ message: "Unauthorized" });
    }
    if (!product.reviews.id(reviewId)) {
      return res.status(404).json({ message: "Review not found" });
    }

    await ProductModel.updateOne(
      { _id: productId, "reviews._id": reviewId },
      { $unset: { "reviews.$.reply": "" } },
    );

    return res.status(200).json({ message: "Reply deleted" });
  } catch (error) {
    return sendError(res, error, "Failed to delete reply");
  }
};

// ===================== 7. STORE OWNER: SHOB PRODUCT ER REVIEW =====================
// GET /api/product/my-store-reviews?filter=all|unreplied|replied&page=1&limit=10
const getStoreOwnerReviews = async (req, res) => {
  try {
    const userId = getUserId(req);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
    const filter = ["unreplied", "replied"].includes(req.query.filter)
      ? req.query.filter
      : "all";

    const UNREPLIED = { "reviews.reply.text": { $in: [null, ""] } };
    const REPLIED = { "reviews.reply.text": { $nin: [null, ""] } };
    const listMatch =
      filter === "unreplied" ? UNREPLIED : filter === "replied" ? REPLIED : {};

    const pipeline = [
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      { $unwind: "$reviews" },
      {
        $facet: {
          data: [
            { $match: listMatch },
            { $sort: { "reviews.createdAt": -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              // collection name "users" na hole (User model er collection) eta change koro
              $lookup: {
                from: "users",
                localField: "reviews.userId",
                foreignField: "_id",
                as: "reviewer",
              },
            },
            { $unwind: { path: "$reviewer", preserveNullAndEmptyArrays: true } },
            {
              $project: {
                _id: "$reviews._id",
                productId: "$_id",
                productName: "$name",
                productCode: "$productCode",
                productImage: { $arrayElemAt: ["$images", 0] },
                rating: "$reviews.rating",
                comment: "$reviews.comment",
                image: "$reviews.image",
                createdAt: "$reviews.createdAt",
                reply: "$reviews.reply",
                user: {
                  _id: "$reviewer._id",
                  name: "$reviewer.name",
                  picture: "$reviewer.picture",
                },
              },
            },
          ],
          total: [{ $match: listMatch }, { $count: "count" }],
          unreplied: [{ $match: UNREPLIED }, { $count: "count" }],
        },
      },
    ];

    const [result] = await ProductModel.aggregate(pipeline);
    const total = result?.total?.[0]?.count || 0;

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
      unreplied: result?.unreplied?.[0]?.count || 0,
      reviews: result?.data || [],
    });
  } catch (error) {
    console.error("Get Store Owner Reviews Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to get reviews" });
  }
};

module.exports = {
  addReview,
  updateReview,
  deleteReview,
  getProductReviews,
  replyToReview,
  deleteReply,
  getStoreOwnerReviews,
};