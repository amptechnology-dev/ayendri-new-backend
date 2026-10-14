const mongoose = require("mongoose");
const BannerModel = require("../model/banner.model.js");
const UserModel = require("../model/user.model.js");
const StoreModel = require("../model/store.model.js");
const CategoryModel = require("../model/category.model.js");
const ProductModel = require("../model/product.model.js");
const {
  createBannerSchema,
  updateBannerSchema,
} = require("../schema/banner.schema.js");
const { uploadBannerMedia } = require("../helper/productImages.js");
const { notifyUsersNewOffer } = require("../helper/notification.helper.js");
const {
  isStoreAvailable,
  getAvailableStoreIds,
  sendStoreUnavailable,
} = require("../helper/storeAvailability.js");

const getUserId = (req) => req.user?._id || req.user?.id;

const escapeRegex = (str = "") => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const uniqueIds = (ids = []) => [...new Set(ids.map(String))];

const handleError = (res, error, label) => {
  console.error(`${label}:`, error);

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

  if (error.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: Object.values(error.errors).map((e) => ({
        field: e.path,
        message: e.message,
      })),
    });
  }

  if (error.statusCode) {
    return res
      .status(error.statusCode)
      .json({ success: false, message: error.message });
  }

  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

// shob category ei store er kina check (onno store er category dewa jabe na)
const categoriesBelongToStore = async (categoryIds, storeId) => {
  const count = await CategoryModel.countDocuments({
    _id: { $in: categoryIds },
    storeId,
  });
  return count === categoryIds.length;
};

// product ta ei store er kina check, ar category dile product oi category gulor kono ekta te kina
// error message return kore, sob thik thakle null
const validateProductLink = async ({ productId, categoryIds, storeId }) => {
  if (!productId) return null;

  const product = await ProductModel.findOne({ _id: productId, storeId })
    .select("categoryId")
    .lean();
  if (!product) return "Product not found for this store";

  if (
    categoryIds?.length &&
    !categoryIds.map(String).includes(String(product.categoryId))
  ) {
    return "Selected product does not belong to the selected categories";
  }
  return null;
};

const BANNER_POPULATE = [
  { path: "storeId", select: "storeName storeUniqueId" },
  { path: "categoryIds", select: "name" },
  { path: "productId", select: "name productCode images" },
];

// ===================== STORE (authenticated) =====================

// form er product dropdown er jonno: ei store er product (category dile shudhu oi category gulor)
// query: storeId, categoryIds (comma separated)
const getProductOptions = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { storeId } = req.query;
    const categoryIds = String(req.query.categoryIds || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!mongoose.isValidObjectId(storeId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid store id" });
    }
    if (categoryIds.some((id) => !mongoose.isValidObjectId(id))) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid category id" });
    }

    const ownsStore = await StoreModel.exists({ _id: storeId, userId });
    if (!ownsStore) {
      return res.status(403).json({
        success: false,
        message: "Store not found or not owned by you",
      });
    }

    const filter = { storeId };
    if (categoryIds.length) filter.categoryId = { $in: categoryIds };

    const products = await ProductModel.find(filter)
      .select("name productCode categoryId")
      .sort({ name: 1 })
      .limit(500)
      .lean();

    return res.status(200).json({ success: true, products });
  } catch (error) {
    return handleError(res, error, "Get Product Options Error");
  }
};

const createBanner = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const parsedData = createBannerSchema.parse(req.body);

    const user = await UserModel.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    if (user.role !== "STORE") {
      return res
        .status(403)
        .json({ success: false, message: "Only STORE can create banner" });
    }

    // storeId login user er nijer store kina check
    const store = await StoreModel.findOne({ _id: parsedData.storeId, userId });
    if (!store) {
      return res.status(404).json({
        success: false,
        message: "Store not found or not owned by you",
      });
    }

    // categoryIds optional, dile shob gulo oi store er category hote hobe
    const categoryIds = uniqueIds(parsedData.categoryIds);
    if (categoryIds.length) {
      const valid = await categoriesBelongToStore(
        categoryIds,
        parsedData.storeId,
      );
      if (!valid) {
        return res.status(400).json({
          success: false,
          message: "One or more categories not found for this store",
        });
      }
    }

    // productId optional, dile oi store er product hote hobe
    const linkError = await validateProductLink({
      productId: parsedData.productId,
      categoryIds,
      storeId: parsedData.storeId,
    });
    if (linkError) {
      return res.status(400).json({ success: false, message: linkError });
    }

    const media = await uploadBannerMedia(req.files);
    if (!media) {
      return res
        .status(400)
        .json({ success: false, message: "Banner image or video is required" });
    }

    const banner = await BannerModel.create({
      name: parsedData.name,
      storeId: parsedData.storeId,
      categoryIds,
      productId: parsedData.productId || null,
      offerBanner: parsedData.offerBanner ?? false,
      image: media.url,
      mediaType: media.mediaType,
      userId,
    });

    // offer banner hole role USER der notification (fire-and-forget, response block korbe na)
    if (banner.offerBanner && banner.isActive) {
      notifyUsersNewOffer(banner);
    }

    return res.status(201).json({
      success: true,
      message: "Banner created successfully",
      data: banner,
    });
  } catch (error) {
    return handleError(res, error, "Create Banner Error");
  }
};

const getAllBanners = async (req, res) => {
  try {
    const userId = getUserId(req);

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
    const search = String(req.query.search || "").trim();

    const match = { userId };
    if (search) {
      match.name = { $regex: escapeRegex(search), $options: "i" };
    }

    const skip = (page - 1) * limit;

    const [banners, totalBanners] = await Promise.all([
      BannerModel.find(match)
        .populate(BANNER_POPULATE)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      BannerModel.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      page,
      limit,
      totalPages: Math.ceil(totalBanners / limit),
      totalBanners,
      banners,
    });
  } catch (error) {
    return handleError(res, error, "Get All Banners Error");
  }
};

const getSingleBanner = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid banner id" });
    }

    const banner = await BannerModel.findOne({ _id: id, userId }).populate(
      BANNER_POPULATE,
    );

    if (!banner) {
      return res
        .status(404)
        .json({ success: false, message: "Banner not found" });
    }

    return res.status(200).json({ success: true, banner });
  } catch (error) {
    return handleError(res, error, "Get Single Banner Error");
  }
};

const updateBanner = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid banner id" });
    }

    const user = await UserModel.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    if (user.role !== "STORE") {
      return res
        .status(403)
        .json({ success: false, message: "Only STORE can update banner" });
    }

    const existingBanner = await BannerModel.findOne({ _id: id, userId });
    if (!existingBanner) {
      return res
        .status(404)
        .json({ success: false, message: "Banner not found" });
    }

    const parsedData = updateBannerSchema.parse(req.body);
    // update e store change kora jabe na
    const { storeId, ...safeData } = parsedData;

    // undefined = change nai, tai shudhu pathano field gulo-i set hobe
    const updateFields = {};
    if (safeData.name !== undefined) updateFields.name = safeData.name;
    if (safeData.offerBanner !== undefined) {
      updateFields.offerBanner = safeData.offerBanner;
    }
    if (safeData.productId !== undefined) {
      updateFields.productId = safeData.productId; // null = remove
    }

    // categoryIds: undefined = change nai, [] = shob remove, [..] = set (store check shoho)
    if (safeData.categoryIds !== undefined) {
      const newCategoryIds = uniqueIds(safeData.categoryIds);
      if (newCategoryIds.length) {
        const valid = await categoriesBelongToStore(
          newCategoryIds,
          existingBanner.storeId,
        );
        if (!valid) {
          return res.status(400).json({
            success: false,
            message: "One or more categories not found for this store",
          });
        }
      }
      updateFields.categoryIds = newCategoryIds;
    }

    // product ba category change hole, final (effective) combination ta valid kina check
    const effectiveProductId =
      safeData.productId === undefined
        ? existingBanner.productId
        : safeData.productId;
    const effectiveCategoryIds =
      updateFields.categoryIds ?? existingBanner.categoryIds.map(String);

    if (
      effectiveProductId &&
      (safeData.productId !== undefined || safeData.categoryIds !== undefined)
    ) {
      const linkError = await validateProductLink({
        productId: effectiveProductId,
        categoryIds: effectiveCategoryIds,
        storeId: existingBanner.storeId,
      });
      if (linkError) {
        return res.status(400).json({ success: false, message: linkError });
      }
    }

    // notun media dile replace, na dile purono ta thakbe
    const media = await uploadBannerMedia(req.files);
    if (media) {
      updateFields.image = media.url;
      updateFields.mediaType = media.mediaType;
    }

    const updatedBanner = await BannerModel.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { returnDocument: "after", runValidators: true },
    );

    // offer banner false -> true hole-i notification (shadharon edit e abar jabe na)
    const turnedOffer =
      updateFields.offerBanner === true && !existingBanner.offerBanner;
    if (turnedOffer && updatedBanner?.isActive) {
      notifyUsersNewOffer(updatedBanner);
    }

    return res.status(200).json({
      success: true,
      message: "Banner updated successfully",
      data: updatedBanner,
    });
  } catch (error) {
    return handleError(res, error, "Update Banner Error");
  }
};

const deleteBanner = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid banner id" });
    }

    const banner = await BannerModel.findOneAndDelete({ _id: id, userId });
    if (!banner) {
      return res
        .status(404)
        .json({ success: false, message: "Banner not found" });
    }

    return res
      .status(200)
      .json({ success: true, message: "Banner deleted permanently" });
  } catch (error) {
    return handleError(res, error, "Delete Banner Error");
  }
};

// ===================== PUBLIC =====================
const publicGetAllBanners = async (req, res) => {
  try {
    const availableStoreIds = await getAvailableStoreIds();

    const banners = await BannerModel.find({
      isActive: true,
      offerBanner: { $ne: true },
      storeId: { $in: availableStoreIds },
    })
      .populate(BANNER_POPULATE)
      .sort({ createdAt: -1 })
      .select("-userId -__v")
      .lean();

    return res.status(200).json({
      success: true,
      count: banners.length,
      banners,
    });
  } catch (error) {
    return handleError(res, error, "Public Get Banners Error");
  }
};

const publicGetOfferBanners = async (req, res) => {
  try {
    const { storeId, categoryId } = req.query;

    if (storeId && !mongoose.isValidObjectId(storeId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid store id" });
    }
    if (categoryId && !mongoose.isValidObjectId(categoryId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid category id" });
    }

    const filter = { isActive: true, offerBanner: true };

    if (storeId) {
      if (!(await isStoreAvailable(storeId))) {
        return sendStoreUnavailable(res);
      }
      filter.storeId = storeId;
    } else {
      filter.storeId = { $in: await getAvailableStoreIds() };
    }

    if (categoryId) filter.categoryIds = categoryId;

    const banners = await BannerModel.find(filter)
      .populate(BANNER_POPULATE)
      .sort({ createdAt: -1 })
      .limit(100)
      .select("-userId -__v");

    return res.status(200).json({
      success: true,
      count: banners.length,
      banners,
    });
  } catch (error) {
    return handleError(res, error, "Public Get Offer Banners Error");
  }
};

const publicGetBannersByCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { storeId, includeGeneral } = req.query;

    if (!mongoose.isValidObjectId(categoryId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid category id" });
    }
    if (storeId && !mongoose.isValidObjectId(storeId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid store id" });
    }

    const filter = { isActive: true };

    if (storeId) {
      if (!(await isStoreAvailable(storeId))) {
        return sendStoreUnavailable(res);
      }
      filter.storeId = storeId;
    } else {
      filter.storeId = { $in: await getAvailableStoreIds() };
    }

    // includeGeneral=true hole category-less (categoryIds khali) banner o ashbe
    if (includeGeneral === "true") {
      filter.$or = [{ categoryIds: categoryId }, { categoryIds: { $size: 0 } }];
    } else {
      filter.categoryIds = categoryId;
    }

    const banners = await BannerModel.find(filter)
      .populate(BANNER_POPULATE)
      .sort({ createdAt: -1 })
      .select("-userId -__v");

    return res.status(200).json({
      success: true,
      count: banners.length,
      banners,
    });
  } catch (error) {
    return handleError(res, error, "Public Get Banners By Category Error");
  }
};

module.exports = {
  getProductOptions,
  createBanner,
  getAllBanners,
  getSingleBanner,
  updateBanner,
  deleteBanner,
  publicGetAllBanners,
  publicGetOfferBanners,
  publicGetBannersByCategory,
};
