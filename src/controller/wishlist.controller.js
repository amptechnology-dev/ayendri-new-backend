const mongoose = require("mongoose");
const WishlistModel = require("../model/wishlist.model.js");
const ProductModel = require("../model/product.model.js");
const StoreModel = require("../model/store.model.js");
const { addToWishlistSchema } = require("../schema/wishlist.schema.js");

// ===================== HELPERS =====================

const getUserId = (req) => req.user?._id || req.user?.id;

const handleError = (res, error, label) => {
  if (error.name === "ZodError") {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      })),
    });
  }
  if (error.name === "VersionError") {
    return res.status(409).json({
      success: false,
      message: "Your wishlist was updated by another request. Please try again.",
    });
  }
  console.error(`${label}:`, error);
  return res.status(500).json({ success: false, message: "Internal server error" });
};

const priceRange = (variants = []) => {
  const active = variants.filter((v) => v.isActive !== false);
  if (active.length === 0) return { minOfferPrice: null, maxOfferPrice: null };
  const prices = active.map((v) => v.offerPrice);
  return { minOfferPrice: Math.min(...prices), maxOfferPrice: Math.max(...prices) };
};

// wishlist ke store wise group kore live product data soho response banay (cart-er serializeCart-er moto)
const serializeWishlist = async (wishlist) => {
  if (!wishlist || wishlist.items.length === 0) {
    return { _id: wishlist?._id ?? null, stores: [], summary: { totalItems: 0, totalStores: 0 } };
  }

  const productIds = [...new Set(wishlist.items.map((i) => String(i.productId)))];
  const storeIds = [...new Set(wishlist.items.map((i) => String(i.storeId)))];

  const [products, stores] = await Promise.all([
    ProductModel.find({ _id: { $in: productIds } })
      .select("name productCode images unit variants isActive isVerified categoryId")
      .lean(),
    StoreModel.find({ _id: { $in: storeIds } })
      .select("storeName storeUniqueId images isActive")
      .lean(),
  ]);

  const productMap = new Map(products.map((p) => [String(p._id), p]));
  const storeMap = new Map(stores.map((s) => [String(s._id), s]));

  const groups = new Map();
  let totalItems = 0;

  for (const item of wishlist.items) {
    const storeKey = String(item.storeId);
    const store = storeMap.get(storeKey);

    if (!groups.has(storeKey)) {
      groups.set(storeKey, {
        store: {
          _id: item.storeId,
          storeName: store?.storeName ?? null,
          storeUniqueId: store?.storeUniqueId ?? null,
          image: store?.images?.[0] ?? null,
          isActive: Boolean(store?.isActive),
        },
        items: [],
      });
    }
    const group = groups.get(storeKey);

    const product = productMap.get(String(item.productId));
    const isAvailable = Boolean(product?.isActive && product?.isVerified && store?.isActive);
    const { minOfferPrice, maxOfferPrice } = priceRange(product?.variants);

    group.items.push({
      _id: item._id,
      productId: item.productId,
      name: product?.name ?? null,
      productCode: product?.productCode ?? null,
      image: product?.images?.[0] ?? null,
      unit: product?.unit ?? null,
      minOfferPrice,
      maxOfferPrice,
      isAvailable,
      addedAt: item.createdAt,
    });

    totalItems += 1;
  }

  const storeGroups = [...groups.values()];

  return {
    _id: wishlist._id,
    stores: storeGroups,
    summary: { totalItems, totalStores: storeGroups.length },
  };
};

// ===================== 1. ADD TO WISHLIST (one-click) =====================
// POST /wishlist/add   body: { productId }
const addToWishlist = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { productId } = addToWishlistSchema.parse(req.body);

    const product = await ProductModel.findOne({
      _id: productId,
      isActive: true,
      isVerified: true,
    })
      .select("storeId")
      .lean();

    if (!product) {
      return res.status(404).json({ success: false, message: "Product not available" });
    }

    const store = await StoreModel.findOne({ _id: product.storeId, isActive: true })
      .select("_id")
      .lean();
    if (!store) {
      return res.status(400).json({ success: false, message: "Store is currently unavailable" });
    }

    const wishlist = await WishlistModel.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId } },
      { upsert: true, new: true },
    );

    const alreadyExists = wishlist.items.some(
      (i) => String(i.productId) === String(productId),
    );

    if (alreadyExists) {
      return res.status(200).json({
        success: true,
        message: "Product already in wishlist",
        wishlist: await serializeWishlist(wishlist),
      });
    }

    wishlist.items.push({ productId, storeId: product.storeId });
    await wishlist.save();

    return res.status(201).json({
      success: true,
      message: "Added to wishlist",
      wishlist: await serializeWishlist(wishlist),
    });
  } catch (error) {
    return handleError(res, error, "Add To Wishlist Error");
  }
};

// ===================== 2. TOGGLE (ek click e add/remove) =====================
// POST /wishlist/toggle   body: { productId }
const toggleWishlist = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { productId } = addToWishlistSchema.parse(req.body);

    let wishlist = await WishlistModel.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId } },
      { upsert: true, new: true },
    );

    const existingItem = wishlist.items.find(
      (i) => String(i.productId) === String(productId),
    );

    if (existingItem) {
      existingItem.deleteOne();
      await wishlist.save();
      return res.status(200).json({
        success: true,
        message: "Removed from wishlist",
        isWishlisted: false,
        wishlist: await serializeWishlist(wishlist),
      });
    }

    const product = await ProductModel.findOne({
      _id: productId,
      isActive: true,
      isVerified: true,
    })
      .select("storeId")
      .lean();
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not available" });
    }

    const store = await StoreModel.findOne({ _id: product.storeId, isActive: true })
      .select("_id")
      .lean();
    if (!store) {
      return res.status(400).json({ success: false, message: "Store is currently unavailable" });
    }

    wishlist.items.push({ productId, storeId: product.storeId });
    await wishlist.save();

    return res.status(201).json({
      success: true,
      message: "Added to wishlist",
      isWishlisted: true,
      wishlist: await serializeWishlist(wishlist),
    });
  } catch (error) {
    return handleError(res, error, "Toggle Wishlist Error");
  }
};

// ===================== 3. GET WISHLIST (store wise) =====================
const getWishlist = async (req, res) => {
  try {
    const wishlist = await WishlistModel.findOne({ userId: getUserId(req) });
    return res.status(200).json({ success: true, wishlist: await serializeWishlist(wishlist) });
  } catch (error) {
    return handleError(res, error, "Get Wishlist Error");
  }
};

// ===================== 4. REMOVE SINGLE ITEM =====================
// DELETE /wishlist/items/:itemId
const removeWishlistItem = async (req, res) => {
  try {
    const { itemId } = req.params;

    if (!mongoose.isValidObjectId(itemId)) {
      return res.status(400).json({ success: false, message: "Invalid item id" });
    }

    const wishlist = await WishlistModel.findOneAndUpdate(
      { userId: getUserId(req) },
      { $pull: { items: { _id: new mongoose.Types.ObjectId(itemId) } } },
      { new: true },
    );

    return res.status(200).json({
      success: true,
      message: "Item removed from wishlist",
      wishlist: await serializeWishlist(wishlist),
    });
  } catch (error) {
    return handleError(res, error, "Remove Wishlist Item Error");
  }
};

// ===================== 5. REMOVE BY PRODUCT ID =====================
// DELETE /wishlist/product/:productId  (product page-e heart icon abar click korle remove korte kaje lage)
const removeByProductId = async (req, res) => {
  try {
    const { productId } = req.params;

    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ success: false, message: "Invalid product id" });
    }

    const wishlist = await WishlistModel.findOneAndUpdate(
      { userId: getUserId(req) },
      { $pull: { items: { productId: new mongoose.Types.ObjectId(productId) } } },
      { new: true },
    );

    return res.status(200).json({
      success: true,
      message: "Item removed from wishlist",
      wishlist: await serializeWishlist(wishlist),
    });
  } catch (error) {
    return handleError(res, error, "Remove Wishlist Item By Product Error");
  }
};

// ===================== 6. REMOVE ALL ITEMS OF ONE STORE =====================
const removeStoreItems = async (req, res) => {
  try {
    const { storeId } = req.params;

    if (!mongoose.isValidObjectId(storeId)) {
      return res.status(400).json({ success: false, message: "Invalid store id" });
    }

    const wishlist = await WishlistModel.findOneAndUpdate(
      { userId: getUserId(req) },
      { $pull: { items: { storeId: new mongoose.Types.ObjectId(storeId) } } },
      { new: true },
    );

    return res.status(200).json({
      success: true,
      message: "Store items removed from wishlist",
      wishlist: await serializeWishlist(wishlist),
    });
  } catch (error) {
    return handleError(res, error, "Remove Store Wishlist Items Error");
  }
};

// ===================== 7. CLEAR WISHLIST =====================
const clearWishlist = async (req, res) => {
  try {
    await WishlistModel.updateOne({ userId: getUserId(req) }, { $set: { items: [] } });
    return res.status(200).json({ success: true, message: "Wishlist cleared" });
  } catch (error) {
    return handleError(res, error, "Clear Wishlist Error");
  }
};

module.exports = {
  addToWishlist,
  toggleWishlist,
  getWishlist,
  removeWishlistItem,
  removeByProductId,
  removeStoreItems,
  clearWishlist,
  serializeWishlist,
};