const { z } = require("zod");
const mongoose = require("mongoose");

const objectId = z.string().refine((val) => mongoose.isValidObjectId(val), {
  message: "Invalid ObjectId",
});

const addToWishlistSchema = z.object({
  productId: objectId,
});

module.exports = { addToWishlistSchema };