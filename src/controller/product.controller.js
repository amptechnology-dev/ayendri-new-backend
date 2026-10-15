const mongoose = require("mongoose");
const ProductModel = require("../model/product.model.js");
const UserModel = require("../model/user.model.js");
const StoreModel = require("../model/store.model.js");
const CategoryModel = require("../model/category.model.js");
const {
  createProductSchema,
  updateProductSchema,
} = require("../schema/product.schema.js");
const { uploadToR2 } = require("../helper/upload.js");
const sendProductVerifyEmail = require("../helper/sendProductVerifyEmail.js");
const { validateProduct } = require("../helper/validateProduct.js");
const {
  uploadSimpleImages,
  uploadVariantImages,
} = require("../helper/productImages.js");
const {
  flattenStockUnits,
  computeLowStock,
  logStockChange,
  notifyLowStock,
} = require("../helper/stockManager.js");
// [STOCK] store type / product flag helper
const {
  getStoreBusinessType,
  resolveProductStockManaged,
  isStockManaged,
} = require("../helper/storeSettings.js");
// [TIER] quantity based pricing
const {
  applyPriceTiers,
  productHasTiers,
  getMinTierPrice,
} = require("../helper/priceTiers.js");
// [STORE] inactive / unverified store hide
const {
  AVAILABLE_STORE_FILTER,
  sendStoreUnavailable,
} = require("../helper/storeAvailability.js");
// [QUOTE] price on request
const {
  findOfferWithoutMrp,
  isPriceOnRequestProduct,
} = require("../helper/priceQuote.js");
const { getDeliverySummary } = require("../helper/deliveryEstimate.js");
// [GST]
const { applyGst, withEffectiveGst } = require("../helper/gst.js");
const shiprocket = require("../helper/shiprocket.js");

const escapeRegex = (str = "") => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// [STOCK] stock management off hole stock field gulo shob level e 0 thakbe
const zeroStock = (obj) => {
  obj.openingStock = 0;
  obj.currentStock = 0;
  obj.lowStockThreshold = 0;
};

// [STOCK] product + variant + sizeVariant, tin level e stock 0 kore dey
const stripStockFields = (data) => {
  zeroStock(data);
  (data.variants || []).forEach((v) => {
    zeroStock(v);
    (v.sizeVariants || []).forEach(zeroStock);
  });
};

// [QUOTE] offer price ache kintu MRP nai -> error response
const offerWithoutMrpResponse = (res) =>
  res.status(400).json({
    success: false,
    message: "Validation failed",
    errors: [
      {
        field: "offerPrice",
        message: "Enter MRP, or clear Offer Price to keep price on request",
      },
    ],
  });

// ---------- Reusable aggregation stage: flatten offerPrice from variants + nested sizeVariants ----------
const buildOfferPriceStages = () => [
  {
    $addFields: {
      allOfferPrices: {
        $reduce: {
          input: { $ifNull: ["$variants", []] },
          initialValue: [],
          in: {
            $concatArrays: [
              "$$value",
              {
                $cond: [
                  {
                    $gt: [
                      { $size: { $ifNull: ["$$this.sizeVariants", []] } },
                      0,
                    ],
                  },
                  "$$this.sizeVariants.offerPrice",
                  {
                    $cond: [
                      { $ne: [{ $ifNull: ["$$this.offerPrice", null] }, null] },
                      ["$$this.offerPrice"],
                      [],
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  },
  {
    $addFields: {
      minOfferPrice: {
        $cond: [
          { $gt: [{ $size: "$allOfferPrices" }, 0] },
          { $min: "$allOfferPrices" },
          "$offerPrice",
        ],
      },
      maxOfferPrice: {
        $cond: [
          { $gt: [{ $size: "$allOfferPrices" }, 0] },
          { $max: "$allOfferPrices" },
          "$offerPrice",
        ],
      },
    },
  },
];

// [TIER] form-data te string hoye ashle JSON parse kore
const parseJsonField = (body, key) => {
  if (typeof body[key] === "string") {
    try {
      body[key] = JSON.parse(body[key]);
    } catch {
      return `Invalid ${key} format`;
    }
  }
  return null;
};

// [GST] FormData te gst JSON string hoye ashe. Zod parse er age object banate hobe,
// nahole zod object schema string e fail korbe. Khali string hole key-ta-i bad.
const parseGstField = (body) => {
  if (body.gst === "") {
    delete body.gst;
    return null;
  }
  return parseJsonField(body, "gst");
};

// [TIER] raw tier list -> clean numbers (minQty chain: first = 1, next = prev.maxQty + 1)
const normalizeTierList = (tiers) => {
  if (!Array.isArray(tiers)) return [];
  const out = [];
  tiers.forEach((t, i) => {
    const prev = out[i - 1];
    const minQty =
      i === 0
        ? 1
        : prev && prev.maxQty !== null
          ? prev.maxQty + 1
          : Number(t?.minQty);
    const hasMax =
      t?.maxQty !== undefined && t?.maxQty !== null && t?.maxQty !== "";
    out.push({
      minQty,
      maxQty: hasMax ? Number(t.maxQty) : null,
      price: Number(t?.price),
    });
  });
  return out;
};

// [TIER] applyPriceTiers er por chalano hoy. Jate update e tier kokhono silently
// purono thake na (empty array, simple <-> variant switch, validateProduct e drop hoye jawa).
//  - simple product : data.priceTiers = body er tiers (empty hole [])
//  - variant product: top-level priceTiers = [], variant / sizeVariant e body theke tiers
const syncTiers = (data, body, hasVariants) => {
  if (!hasVariants) {
    if (data.priceTiers === undefined) {
      data.priceTiers = normalizeTierList(body.priceTiers);
    }
    return;
  }

  data.priceTiers = [];
  const src = Array.isArray(body.variants) ? body.variants : [];

  (data.variants || []).forEach((v, i) => {
    const s = src[i] || {};
    const hasSizes = Array.isArray(v.sizeVariants) && v.sizeVariants.length > 0;

    if (v.priceTiers === undefined) {
      v.priceTiers = hasSizes ? [] : normalizeTierList(s.priceTiers);
    }
    (v.sizeVariants || []).forEach((sv, j) => {
      if (sv.priceTiers === undefined) {
        sv.priceTiers = normalizeTierList(s.sizeVariants?.[j]?.priceTiers);
      }
    });
  });
};

// [STORE TYPE] stock mandatory product e opening stock dewa hoyeche kina
const isBlank = (v) => v === undefined || v === null || v === "";

const isOpeningStockMissing = (body, hasVariants) => {
  if (!hasVariants) return isBlank(body.openingStock);
  return (body.variants || []).some((v) => {
    const sizes = Array.isArray(v.sizeVariants) ? v.sizeVariants : [];
    return sizes.length
      ? sizes.some((sv) => isBlank(sv.openingStock))
      : isBlank(v.openingStock);
  });
};

// [HSN] 4 / 6 / 8 digit
const HSN_REGEX = /^(\d{4}|\d{6}|\d{8})$/;

// [HSN] product / color / size, je kono level e GST rate thakle true
const hasAnyGst = (data) => {
  const has = (g) =>
    !!g &&
    ["cgst", "sgst", "igst"].some((k) => g[k] !== undefined && g[k] !== null);

  return (
    has(data.gst) ||
    (data.variants || []).some(
      (v) => has(v.gst) || (v.sizeVariants || []).some((s) => has(s.gst)),
    )
  );
};

// [HSN] GST thakle HSN required + validate, GST na thakle HSN bad.
// error message return kore, thik thakle null
const applyHsn = (body, data) => {
  const raw =
    typeof body.hsnCode === "string" ? body.hsnCode.replace(/\s+/g, "") : "";

  if (!hasAnyGst(data)) {
    data.hsnCode = undefined;
    return null;
  }
  if (!raw) return "HSN code is required when GST is applied";
  if (!HSN_REGEX.test(raw)) return "HSN code must be 4, 6 or 8 digits";

  data.hsnCode = raw;
  return null;
};

const hsnErrorResponse = (res, message) =>
  res.status(400).json({
    success: false,
    message: "Validation failed",
    errors: [{ field: "hsnCode", message }],
  });

const createProduct = async (req, res) => {
  try {
    const body = { ...req.body };
    if (typeof body.variants === "string") {
      try {
        body.variants = JSON.parse(body.variants);
      } catch {
        return res
          .status(400)
          .json({ success: false, message: "Invalid variants format" });
      }
    }
    if (typeof body.packagingDetails === "string") {
      try {
        body.packagingDetails = JSON.parse(body.packagingDetails);
      } catch {
        return res
          .status(400)
          .json({ success: false, message: "Invalid packagingDetails format" });
      }
    }
    // [TIER]
    const tierParseError = parseJsonField(body, "priceTiers");
    if (tierParseError) {
      return res.status(400).json({ success: false, message: tierParseError });
    }
    // [GST] zod parse er age gst string -> object
    const gstParseError = parseGstField(body);
    if (gstParseError) {
      return res.status(400).json({ success: false, message: gstParseError });
    }

    const parsedData = createProductSchema.parse(body);

    // [QUOTE] offer price dile MRP lagbe. MRP khali + offer khali = "price on request"
    if (findOfferWithoutMrp(body)) return offerWithoutMrpResponse(res);

    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
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
        .json({ success: false, message: "Only STORE can create product" });
    }

    const store = await StoreModel.findById(parsedData.storeId);
    if (!store) return sendStoreUnavailable(res);

    const category = await CategoryModel.findOne({
      _id: parsedData.categoryId,
      storeId: parsedData.storeId,
    });
    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found for this store" });
    }

    // ---------- Same store-e same name-er product age theke ache kina check ----------
    const existingByName = await ProductModel.findOne({
      name: {
        $regex: `^${escapeRegex(parsedData.name.trim())}$`,
        $options: "i",
      },
      storeId: parsedData.storeId,
    });
    if (existingByName) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: [
          {
            field: "name",
            message: "Product name already exists in this store",
          },
        ],
      });
    }

    const { errors, data, hasVariants, hasColor } = validateProduct(body, {
      files: req.files,
    });
    if (errors.length) {
      return res
        .status(400)
        .json({ success: false, message: "Validation failed", errors });
    }

    // [TIER] quantity based price tiers validate + attach
    const tierError = applyPriceTiers(body, data, hasVariants);
    if (tierError) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: [{ field: "priceTiers", message: tierError }],
      });
    }
    // [TIER] tier gulo shobshomoy data te thakbe
    syncTiers(data, body, hasVariants);

    // [GST] product / color / size level GST + gstInclusive validate + attach
    const gstError = applyGst(body, data, hasVariants);
    if (gstError) {
      return res.status(400).json({
        success: false,
        message: gstError,
        errors: [{ field: "gst", message: gstError }],
      });
    }
    const hsnError = applyHsn(body, data);
    if (hsnError) return hsnErrorResponse(res, hsnError);

    // [STORE TYPE] store type + product er made-for-product flag theke decide hobe ei product e stock thakbe kina
    const businessType = await getStoreBusinessType(parsedData.storeId);
    const askedMadeForProduct =
      String(body.isMadeForProduct).trim().toLowerCase() === "true";
    const stockEnabled = resolveProductStockManaged(
      businessType,
      askedMadeForProduct,
    );

    // [STORE TYPE] stock mandatory hole opening stock dite hobe
    if (stockEnabled && isOpeningStockMissing(body, hasVariants)) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: [
          { field: "openingStock", message: "Opening stock is required" },
        ],
      });
    }

    data.images = await uploadSimpleImages(req.files);

    if (hasColor) {
      const colorImageMap = await uploadVariantImages(req.files);
      data.variants = (data.variants || []).map((colorVariant, idx) => ({
        ...colorVariant,
        images: [...(colorVariant.images || []), ...(colorImageMap[idx] || [])],
      }));
    }

    // [STOCK] stock off hole main product + shob variant + sizeVariant e stock 0
    if (!stockEnabled) stripStockFields(data);

    const product = new ProductModel({
      name: parsedData.name,
      description: parsedData.description,
      unit: parsedData.unit,
      storeId: parsedData.storeId,
      categoryId: parsedData.categoryId,
      userId,
      isVerified: true,
      hasVariants,
      hasColor,
      ...data, // [GST] data.gst + data.gstInclusive eikhane diye jay
      // [STOCK] data er por rakhlam jate validateProduct er kono value eta override na kore
      hasStockManagement: stockEnabled,
      isMadeForProduct: !stockEnabled,
    });

    // [STOCK] stock off hole low stock flag shobshomoy false
    product.hasLowStock = stockEnabled
      ? computeLowStock(product).hasLowStock
      : false;

    await product.save();

    // [STOCK] opening stock log shudhu stock managed product er jonno
    if (stockEnabled) {
      const openingUnits = flattenStockUnits(product);
      await Promise.all(
        openingUnits.map((u) =>
          logStockChange({
            productId: product._id,
            storeId: product.storeId,
            userId,
            variantId: u.variantId,
            sizeVariantId: u.sizeVariantId,
            productName: product.name,
            variantLabel: u.label,
            type: "OPENING",
            reason: "PRODUCT_CREATE",
            previousStock: 0,
            newStock: u.currentStock,
          }),
        ),
      );
    }

    return res.status(201).json({
      success: true,
      message: "Product created successfully",
      data: product,
    });
  } catch (error) {
    console.log(error);
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
      const errors = Object.values(error.errors).map((e) => ({
        field: e.path,
        message: e.message,
      }));
      return res
        .status(400)
        .json({ success: false, message: "Validation failed", errors });
    }
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Product with this name already exists",
      });
    }
    // uploadPreparedFile er statusCode error (video convert fail etc.)
    if (error.statusCode) {
      return res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
    }
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const getAllProducts = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    let page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";

    const matchStage = {
      userId: new mongoose.Types.ObjectId(userId),
    };

    if (search) {
      matchStage.$or = [
        { name: { $regex: escapeRegex(search), $options: "i" } },
        { productCode: { $regex: escapeRegex(search), $options: "i" } },
      ];
    }

    const pipeline = [
      { $match: matchStage },

      {
        $lookup: {
          from: "stores",
          localField: "storeId",
          foreignField: "_id",
          as: "store",
        },
      },
      { $unwind: { path: "$store", preserveNullAndEmptyArrays: true } },

      {
        $lookup: {
          from: "categories",
          localField: "categoryId",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },

      ...buildOfferPriceStages(),

      {
        $project: {
          name: 1,
          productCode: 1,
          images: 1,
          description: 1,
          unit: 1,
          variants: 1,
          priceTiers: 1,
          mrp: 1,
          offerPrice: 1,
          gst: 1,
          gstInclusive: 1,
          hsnCode: 1,
          stock: 1,
          hasVariants: 1,
          hasColor: 1,
          hasStockManagement: 1,
          isMadeForProduct: 1, // [STORE TYPE]
          minOfferPrice: 1,
          maxOfferPrice: 1,
          deliveryTime: 1,
          isActive: 1,
          isVerified: 1,
          storeId: 1,
          categoryId: 1,
          userId: 1,
          createdAt: 1,
          store: {
            _id: "$store._id",
            storeName: "$store.storeName",
            storeUniqueId: "$store.storeUniqueId",
            contactNo: "$store.contactNo",
            whatsappNo: "$store.whatsappNo",
            email: "$store.email",
            isActive: "$store.isActive",
            isVerify: "$store.isVerify",
          },
          category: {
            _id: "$category._id",
            name: "$category.name",
          },
        },
      },

      { $sort: { createdAt: -1 } },

      {
        $facet: {
          data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          totalCount: [{ $count: "count" }],
        },
      },
    ];

    const result = await ProductModel.aggregate(pipeline);

    const products = result[0]?.data || [];
    const totalProducts = result[0]?.totalCount[0]?.count || 0;
    const totalPages = Math.ceil(totalProducts / limit);

    return res.status(200).json({
      success: true,
      page,
      limit,
      totalPages,
      totalProducts,
      products: products.map(withEffectiveGst), // [GST]
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const applyOpeningStockDelta = (
  existingOpeningStock,
  existingCurrentStock,
  newOpeningStock,
) => {
  const oldOpening = Number(existingOpeningStock || 0);
  const oldCurrent = Number(existingCurrentStock || 0);
  const newOpening = Number(newOpeningStock);
  const delta = newOpening - oldOpening; // + hole restock, - hole reduce
  return {
    openingStock: newOpening,
    currentStock: Math.max(0, oldCurrent + delta),
  };
};

const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
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
        .json({ success: false, message: "Only STORE can update product" });
    }

    const existingProduct = await ProductModel.findOne({ _id: id, userId });
    if (!existingProduct) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    // [STOCK] ei product e stock management on kina (product er nijer snapshot flag)
    const stockManaged = isStockManaged(existingProduct);

    const body = { ...req.body };
    if (typeof body.variants === "string") {
      try {
        body.variants = JSON.parse(body.variants);
      } catch {
        return res
          .status(400)
          .json({ success: false, message: "Invalid variants format" });
      }
    }
    if (typeof body.packagingDetails === "string") {
      try {
        body.packagingDetails = JSON.parse(body.packagingDetails);
      } catch {
        return res
          .status(400)
          .json({ success: false, message: "Invalid packagingDetails format" });
      }
    }
    // [TIER]
    const tierParseError = parseJsonField(body, "priceTiers");
    if (tierParseError) {
      return res.status(400).json({ success: false, message: tierParseError });
    }
    // [GST] zod parse er age gst string -> object
    const gstParseError = parseGstField(body);
    if (gstParseError) {
      return res.status(400).json({ success: false, message: gstParseError });
    }

    const parsedData = updateProductSchema.parse(body);

    // [QUOTE] offer price dile MRP lagbe. MRP khali + offer khali = "price on request"
    if (findOfferWithoutMrp(body)) return offerWithoutMrpResponse(res);

    // sudhu name change hole, ar SAME STORE-er moddhe duplicate check
    if (parsedData.name) {
      const trimmedName = parsedData.name.trim();
      const nameChanged =
        trimmedName.toLowerCase() !==
        (existingProduct.name || "").trim().toLowerCase();

      if (nameChanged) {
        const duplicate = await ProductModel.findOne({
          name: { $regex: `^${escapeRegex(trimmedName)}$`, $options: "i" },
          storeId: existingProduct.storeId,
          _id: { $ne: id },
        });
        if (duplicate) {
          return res.status(400).json({
            success: false,
            message: "Validation failed",
            errors: [{ field: "name", message: "Product name already exists" }],
          });
        }
      }
    }

    if (parsedData.categoryId) {
      const category = await CategoryModel.findOne({
        _id: parsedData.categoryId,
        storeId: existingProduct.storeId,
      });
      if (!category) {
        return res.status(404).json({
          success: false,
          message: "Category not found for this store",
        });
      }
    }

    // ---------- MAIN PRODUCT IMAGE ----------
    const existingMainImages = body.images
      ? Array.isArray(body.images)
        ? body.images
        : [body.images]
      : [];
    const newMainImages = await uploadSimpleImages(req.files);
    const finalMainImages = [...existingMainImages, ...newMainImages];

    let updateData = { ...parsedData, images: finalMainImages };

    // [GST] product-level GST khali kore dile purono GST muchte $unset lagbe
    // ($set e undefined dile mongoose seta bad dey, tai purono value theke jay)
    const unsetFields = {};

    // variants/pricing/stock/tier somporkito kono field ashle notun kore structure decide hobe
    const isStructuralUpdate =
      body.variants !== undefined ||
      body.mrp !== undefined ||
      body.offerPrice !== undefined ||
      body.openingStock !== undefined ||
      body.priceTiers !== undefined;

    if (isStructuralUpdate) {
      const { errors, data, hasVariants, hasColor } = validateProduct(body, {
        files: req.files,
        existingMainImages,
      });
      if (errors.length) {
        return res
          .status(400)
          .json({ success: false, message: "Validation failed", errors });
      }

      // [TIER] quantity based price tiers validate + attach
      const tierError = applyPriceTiers(body, data, hasVariants);
      if (tierError) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: [{ field: "priceTiers", message: tierError }],
        });
      }
      // [TIER] tier gulo shobshomoy data te thakbe (empty hole purono tier muche jabe)
      syncTiers(data, body, hasVariants);

      // [GST] product / color / size level GST + gstInclusive validate + attach
      const gstError = applyGst(body, data, hasVariants);
      if (gstError) {
        return res.status(400).json({
          success: false,
          message: gstError,
          errors: [{ field: "gst", message: gstError }],
        });
      }

      const hsnError = applyHsn(body, data);
      if (hsnError) return hsnErrorResponse(res, hsnError);

      if (hasColor) {
        const colorImageMap = await uploadVariantImages(req.files);
        data.variants = (data.variants || []).map((colorVariant, idx) => ({
          ...colorVariant,
          images: [
            ...(colorVariant.images || []),
            ...(colorImageMap[idx] || []),
          ],
        }));
      }

      // ---------- Stock ----------
      if (!stockManaged) {
        // [STOCK] stock management off: main product + variant + sizeVariant e stock 0,
        // frontend theke ja-i ashuk stock field save hobe na
        stripStockFields(data);
      } else if (!hasVariants) {
        // simple product
        if (body.openingStock !== undefined) {
          Object.assign(
            data,
            applyOpeningStockDelta(
              existingProduct.openingStock,
              existingProduct.currentStock,
              body.openingStock,
            ),
          );
        } else {
          // openingStock notun kore deyni -> purono stock retain
          data.openingStock = existingProduct.openingStock;
          data.currentStock = existingProduct.currentStock;
        }
      } else {
        // variant/color level e - proti variant-er jonno existing match kore delta lagano
        const existingFlat = [];
        (existingProduct.variants || []).forEach((v) => {
          if (Array.isArray(v.sizeVariants) && v.sizeVariants.length) {
            v.sizeVariants.forEach((sv) => existingFlat.push(sv));
          } else {
            existingFlat.push(v);
          }
        });

        let flatIdx = 0;
        const applyToVariant = (variant) => {
          const prev = existingFlat[flatIdx];
          flatIdx += 1;
          if (prev && variant.openingStock !== undefined) {
            Object.assign(
              variant,
              applyOpeningStockDelta(
                prev.openingStock,
                prev.currentStock,
                variant.openingStock,
              ),
            );
          } else if (prev) {
            variant.openingStock = prev.openingStock;
            variant.currentStock = prev.currentStock;
          }
        };

        data.variants.forEach((v) => {
          if (Array.isArray(v.sizeVariants) && v.sizeVariants.length) {
            v.sizeVariants.forEach(applyToVariant);
          } else {
            applyToVariant(v);
          }
        });
      }

      // [QUOTE] data te mrp / offerPrice null thakle (price on request) purono price muche jabe
      updateData = {
        ...updateData,
        ...data,
        images: finalMainImages,
        hasVariants,
        hasColor,
      };

      // [GST] product-level gst khali hole $set theke bad diye $unset koro
      if (!data.gst) {
        delete updateData.gst;
        unsetFields.gst = "";
      }

      // [HSN] GST na thakle purono HSN muchte $unset (undefined $set e purono value theke jay)
      if (!data.hsnCode) {
        delete updateData.hsnCode;
        unsetFields.hsnCode = "";
      }

      // [STOCK] low stock flag shudhu stock managed product er jonno
      if (stockManaged) {
        const tempForFlagCheck = {
          ...existingProduct.toObject(),
          ...updateData,
        };
        updateData.hasLowStock = computeLowStock(tempForFlagCheck).hasLowStock;
      } else {
        updateData.hasLowStock = false;
      }
    } else if (existingProduct.hasColor && req.files?.length) {
      // sudhu notun color-image add hocche, pricing/stock change hocche na
      const colorImageMap = await uploadVariantImages(req.files);
      if (Object.keys(colorImageMap).length) {
        updateData.variants = (existingProduct.variants || []).map((v, idx) => {
          const obj = v.toObject ? v.toObject() : v;
          return {
            ...obj,
            images: [...(obj.images || []), ...(colorImageMap[idx] || [])],
          };
        });
      }
    }

    // [STOCK] hasStockManagement snapshot create er por kokhono change hobe na
    delete updateData.hasStockManagement;
    // [STORE TYPE] made-for-product flag o create er por change hobe na
    delete updateData.isMadeForProduct;

    const updatedProduct = await ProductModel.findByIdAndUpdate(
      id,
      {
        $set: updateData,
        // [GST]
        ...(Object.keys(unsetFields).length ? { $unset: unsetFields } : {}),
      },
      { new: true, runValidators: true },
    );

    // ---------- log stock deltas + notify if newly low ----------
    // [STOCK] shudhu stock managed product er jonno
    if (isStructuralUpdate && stockManaged) {
      const beforeUnits = flattenStockUnits(existingProduct);
      const afterUnits = flattenStockUnits(updatedProduct);

      const logPromises = afterUnits
        .map((unit, idx) => {
          const before = beforeUnits[idx];
          if (!before || before.currentStock === unit.currentStock) return null;
          return logStockChange({
            productId: updatedProduct._id,
            storeId: updatedProduct.storeId,
            userId,
            variantId: unit.variantId,
            sizeVariantId: unit.sizeVariantId,
            productName: updatedProduct.name,
            variantLabel: unit.label,
            type: unit.currentStock > before.currentStock ? "IN" : "OUT",
            reason: "PRODUCT_UPDATE",
            previousStock: before.currentStock,
            newStock: unit.currentStock,
          });
        })
        .filter(Boolean);
      await Promise.all(logPromises);

      if (updatedProduct.hasLowStock && !existingProduct.hasLowStock) {
        const { lowUnits } = computeLowStock(updatedProduct);
        await notifyLowStock({
          product: updatedProduct,
          lowUnits,
          userId,
          storeId: updatedProduct.storeId,
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Product updated successfully",
      data: updatedProduct,
    });
  } catch (error) {
    console.log(error);
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
      const errors = Object.values(error.errors).map((e) => ({
        field: e.path,
        message: e.message,
      }));
      return res
        .status(400)
        .json({ success: false, message: "Validation failed", errors });
    }
    // uploadPreparedFile er statusCode error (video convert fail etc.)
    if (error.statusCode) {
      return res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
    }
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await ProductModel.findById(id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }
    await ProductModel.findByIdAndDelete(id);
    return res.status(200).json({ message: "Product deleted permanently" });
  } catch (error) {
    console.error("Delete Product Error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const getSingleProduct = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }

    const product = await ProductModel.findOne({ _id: id, isActive: true })
      .populate(
        "storeId",
        "storeName storeUniqueId contactNo whatsappNo email isActive isVerify",
      )
      .populate("categoryId", "name");

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    if (!product.storeId?.isActive || !product.storeId?.isVerify) {
      return sendStoreUnavailable(res);
    }

    // [GST] gst (normalized) + gstInclusive + variant/size e effectiveGst
    return res.status(200).json({
      message: "Product get successfully",
      product: withEffectiveGst(product),
    });
  } catch (error) {
    console.error("Get Single Product Error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const verifyStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isVerify } = req.body;
    if (!id) {
      return res.status(400).json({ message: "Product ID is required" });
    }

    const product = await ProductModel.findById(id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    product.isVerified = isVerify;
    await product.save();

    const store = await StoreModel.findById(product.storeId);
    const user = await UserModel.findById(product.userId);

    if (isVerify && user?.email && store) {
      await sendProductVerifyEmail(
        user.email,
        product.name,
        store.storeName,
        store.storeUniqueId,
      );
    }

    return res.json({
      success: true,
      message:
        "Product is " +
        (isVerify ? "verified" : "not verified") +
        " successfully",
    });
  } catch (error) {
    console.error("Verify error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const allProductWithStore = async (req, res) => {
  try {
    const products = await ProductModel.aggregate([
      { $match: {} },

      {
        $lookup: {
          from: "stores",
          localField: "storeId",
          foreignField: "_id",
          as: "store",
        },
      },
      { $unwind: { path: "$store", preserveNullAndEmptyArrays: true } },

      {
        $lookup: {
          from: "categories",
          localField: "categoryId",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },

      ...buildOfferPriceStages(),

      {
        $project: {
          name: 1,
          productCode: 1,
          images: 1,
          description: 1,
          unit: 1,
          variants: 1,
          priceTiers: 1,
          gst: 1, // [GST]
          gstInclusive: 1, // [GST]
          hsnCode: 1,
          minOfferPrice: 1,
          maxOfferPrice: 1,
          deliveryTime: 1,

          isActive: 1,
          isVerified: 1,

          storeId: 1,
          categoryId: 1,
          userId: 1,

          createdAt: 1,
          updatedAt: 1,

          store: {
            _id: "$store._id",
            storeName: "$store.storeName",
            storeUniqueId: "$store.storeUniqueId",
            contactNo: "$store.contactNo",
            whatsappNo: "$store.whatsappNo",
            email: "$store.email",
            website: "$store.website",
            isActive: "$store.isActive",
            isVerify: "$store.isVerify",
          },
          category: {
            _id: "$category._id",
            name: "$category.name",
          },
        },
      },

      { $sort: { createdAt: -1 } },
    ]);

    return res.json({ success: true, count: products.length, products });
  } catch (error) {
    console.error("Dropdown Products Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

// ...............Public controller for product................

const PUBLIC_STORE_FIELDS =
  "storeName storeType storeUniqueId images address lat long contactNo whatsappNo supportNo email description timingByDay isFeatured";

const PRODUCT_LIST_FIELDS =
  "name productCode images description unit mrp offerPrice variants priceTiers gst gstInclusive hsnCode deliveryTime storeId categoryId createdAt";

const SORT_MAP = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  name_asc: { name: 1 },
  name_desc: { name: -1 },
};

const getPagination = (query) => {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit) || 12, 1), 50);
  return { page, limit, skip: (page - 1) * limit };
};

const toPositiveNumber = (value) => {
  if (value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
};

const getPublicStore = (storeUniqueId) =>
  StoreModel.findOne({ storeUniqueId, ...AVAILABLE_STORE_FILTER })
    .select(PUBLIC_STORE_FIELDS)
    .lean();

// [TIER] hasTierPricing + minTierPrice jog kora hoyeche (user app er jonno)
// [QUOTE] priceOnRequest flag
// [GST] withEffectiveGst: gst (normalized), gstInclusive, variant/size e effectiveGst.
// Eikhane rakhar karone getStoreProducts, getStoreProductsByCategory, getStoreSingleProduct
// (related products shoho) shob jaygay automatic GST info jabe.
const formatProduct = ({ categoryId, ...product }) => ({
  ...withEffectiveGst(product),
  categoryId: categoryId?._id ?? null,
  category: categoryId?._id
    ? { _id: categoryId._id, name: categoryId.name }
    : null,
  hasTierPricing: productHasTiers(product),
  minTierPrice: getMinTierPrice(product),
  priceOnRequest: isPriceOnRequestProduct(product),
});

const fetchStoreProducts = async (store, query, categoryId) => {
  const { page, limit, skip } = getPagination(query);

  const match = {
    storeId: store._id,
    isActive: true,
    isVerified: true,
  };

  if (categoryId) {
    match.categoryId = new mongoose.Types.ObjectId(categoryId);
  }

  const search = (query.search || "").trim();
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    match.$or = [{ name: regex }, { productCode: regex }];
  }

  const minPrice = toPositiveNumber(query.minPrice);
  const maxPrice = toPositiveNumber(query.maxPrice);

  const pipeline = [{ $match: match }];

  pipeline.push(...buildOfferPriceStages());

  if (minPrice !== null || maxPrice !== null) {
    pipeline.push({
      $match: {
        $expr:
          minPrice !== null && maxPrice !== null
            ? {
                $and: [
                  { $gte: ["$maxOfferPrice", minPrice] },
                  { $lte: ["$minOfferPrice", maxPrice] },
                ],
              }
            : minPrice !== null
              ? { $gte: ["$maxOfferPrice", minPrice] }
              : { $lte: ["$minOfferPrice", maxPrice] },
      },
    });
  }

  let sort;
  if (query.sortBy === "price_asc") sort = { minOfferPrice: 1, _id: -1 };
  else if (query.sortBy === "price_desc") sort = { minOfferPrice: -1, _id: -1 };
  else sort = { ...(SORT_MAP[query.sortBy] || SORT_MAP.newest), _id: -1 };

  pipeline.push(
    { $sort: sort },
    {
      $facet: {
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $lookup: {
              from: "categories",
              localField: "categoryId",
              foreignField: "_id",
              as: "categoryId",
            },
          },
          {
            $unwind: { path: "$categoryId", preserveNullAndEmptyArrays: true },
          },
          {
            $project: {
              name: 1,
              productCode: 1,
              images: 1,
              description: 1,
              unit: 1,
              variants: 1,
              priceTiers: 1,
              mrp: 1,
              offerPrice: 1,
              gst: 1,
              gstInclusive: 1,
              hsnCode: 1,
              stock: 1,
              hasVariants: 1,
              hasColor: 1,
              hasStockManagement: 1,
              minOfferPrice: 1,
              deliveryTime: 1,
              storeId: 1,
              categoryId: { _id: 1, name: 1 },
              createdAt: 1,
            },
          },
        ],
        totalCount: [{ $count: "count" }],
      },
    },
  );

  const [result] = await ProductModel.aggregate(pipeline);
  const products = result?.data || [];
  const totalProducts = result?.totalCount?.[0]?.count || 0;
  const totalPages = Math.ceil(totalProducts / limit);

  const delivery = await getDeliverySummary({
    storeId: store._id,
    pincode: query.pincode,
    country: query.country,
  });

  return {
    page,
    limit,
    totalPages,
    totalProducts,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
    delivery,
    products: products.map((p) => ({ ...formatProduct(p), delivery })),
  };
};

const getStoreCategories = async (req, res) => {
  try {
    const { storeUniqueId } = req.params;

    const store = await getPublicStore(storeUniqueId);
    if (!store) return sendStoreUnavailable(res);

    const match = { storeId: store._id, isActive: true };

    const search = (req.query.search || "").trim();
    if (search) {
      match.name = { $regex: escapeRegex(search), $options: "i" };
    }

    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: "products",
          let: { catId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$categoryId", "$$catId"] },
                isActive: true,
                isVerified: true,
              },
            },
            { $count: "count" },
          ],
          as: "productStats",
        },
      },
      {
        $addFields: {
          productCount: {
            $ifNull: [{ $arrayElemAt: ["$productStats.count", 0] }, 0],
          },
        },
      },
      {
        $project: {
          name: 1,
          description: 1,
          image: 1,
          icon: 1,
          productCount: 1,
          createdAt: 1,
        },
      },
    ];

    if (req.query.includeEmpty !== "true") {
      pipeline.push({ $match: { productCount: { $gt: 0 } } });
    }

    pipeline.push({ $sort: { name: 1 } });

    const categories = await CategoryModel.aggregate(pipeline);

    return res.status(200).json({
      success: true,
      store,
      count: categories.length,
      categories,
    });
  } catch (error) {
    console.error("Get Store Categories Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const getStoreProducts = async (req, res) => {
  try {
    const { storeUniqueId } = req.params;
    const { categoryId } = req.query;

    if (categoryId && !mongoose.isValidObjectId(categoryId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid category id" });
    }

    const store = await getPublicStore(storeUniqueId);
    if (!store) return sendStoreUnavailable(res);

    const match = {
      storeId: store._id,
      isActive: true,
      isVerified: true,
    };

    if (categoryId) {
      match.categoryId = new mongoose.Types.ObjectId(categoryId);
    }

    const search = (req.query.search || "").trim();
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      match.$or = [{ name: regex }, { productCode: regex }];
    }

    // [GST] PRODUCT_LIST_FIELDS e already gst gstInclusive ache
    let products = await ProductModel.find(match)
      .select(
        `${PRODUCT_LIST_FIELDS} stock hasVariants hasColor hasStockManagement reviews averageRating totalReviews`,
      )
      .populate("categoryId", "name")
      .populate({ path: "reviews.userId", select: "name picture" })
      .lean();

    const getOfferPrices = (p) => {
      const prices = [];
      (p.variants || []).forEach((v) => {
        if (Array.isArray(v.sizeVariants) && v.sizeVariants.length) {
          v.sizeVariants.forEach((sv) => {
            if (sv.offerPrice !== undefined && sv.offerPrice !== null)
              prices.push(sv.offerPrice);
          });
        } else if (v.offerPrice !== undefined && v.offerPrice !== null) {
          prices.push(v.offerPrice);
        }
      });
      if (
        !prices.length &&
        p.offerPrice !== undefined &&
        p.offerPrice !== null
      ) {
        prices.push(p.offerPrice);
      }
      return prices;
    };

    const minPrice = toPositiveNumber(req.query.minPrice);
    const maxPrice = toPositiveNumber(req.query.maxPrice);
    if (minPrice !== null || maxPrice !== null) {
      products = products.filter((p) => {
        const prices = getOfferPrices(p);
        if (!prices.length) return false;
        return prices.some(
          (price) =>
            (minPrice === null || price >= minPrice) &&
            (maxPrice === null || price <= maxPrice),
        );
      });
    }

    const delivery = await getDeliverySummary({
      storeId: store._id,
      pincode: req.query.pincode,
      country: req.query.country,
    });

    products = products.map((p) => {
      const prices = getOfferPrices(p);
      const minOfferPrice = prices.length ? Math.min(...prices) : null;

      const reviews = p.reviews || [];
      const maxReview =
        reviews.length > 0
          ? [...reviews].sort((a, b) => b.rating - a.rating)[0]
          : null;

      return {
        ...formatProduct(p), // [GST] formatProduct er bhetor theke GST ashe
        minOfferPrice,
        reviews,
        maxReview,
        delivery,
      };
    });

    const sortBy = req.query.sortBy;
    if (sortBy === "price_asc") {
      products.sort((a, b) => (a.minOfferPrice ?? 0) - (b.minOfferPrice ?? 0));
    } else if (sortBy === "price_desc") {
      products.sort((a, b) => (b.minOfferPrice ?? 0) - (a.minOfferPrice ?? 0));
    } else if (sortBy === "name_asc") {
      products.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === "name_desc") {
      products.sort((a, b) => b.name.localeCompare(a.name));
    } else if (sortBy === "oldest") {
      products.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    } else {
      products.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    return res.status(200).json({
      success: true,
      store,
      count: products.length,
      delivery,
      products,
    });
  } catch (error) {
    console.error("Get Store Products Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const getStoreProductsByCategory = async (req, res) => {
  try {
    const { storeUniqueId, categoryId } = req.params;

    if (!mongoose.isValidObjectId(categoryId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid category id" });
    }

    const store = await getPublicStore(storeUniqueId);
    if (!store) return sendStoreUnavailable(res);

    const category = await CategoryModel.findOne({
      _id: categoryId,
      storeId: store._id,
      isActive: true,
    })
      .select("name description")
      .lean();

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found for this store",
      });
    }

    const result = await fetchStoreProducts(store, req.query, category._id);

    return res.status(200).json({ success: true, store, category, ...result });
  } catch (error) {
    console.error("Get Store Products By Category Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const getStoreSingleProduct = async (req, res) => {
  try {
    const { storeUniqueId, productId } = req.params;

    if (!mongoose.isValidObjectId(productId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }

    const store = await getPublicStore(storeUniqueId);
    if (!store) return sendStoreUnavailable(res);

    // [GST] "-userId -__v" exclude kore, tai gst gstInclusive automatic ashe
    const product = await ProductModel.findOne({
      _id: productId,
      storeId: store._id,
      isActive: true,
      isVerified: true,
    })
      .select("-userId -__v")
      .populate("categoryId", "name")
      .lean();

    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    const categoryId = product.categoryId?._id;
    const relatedRaw = categoryId
      ? await ProductModel.find({
          storeId: store._id,
          categoryId,
          _id: { $ne: product._id },
          isActive: true,
          isVerified: true,
        })
          .select(PRODUCT_LIST_FIELDS)
          .sort({ createdAt: -1 })
          .limit(8)
          .lean()
      : [];

    const rawVariant = String(req.query.variantId || "").trim();
    const parcel = shiprocket.buildParcel([
      {
        product,
        variantId:
          !rawVariant || rawVariant === "null" || rawVariant === "undefined"
            ? null
            : rawVariant,
        quantity: Math.max(1, parseInt(req.query.quantity, 10) || 1),
      },
    ]);

    const [delivery, productDelivery] = await Promise.all([
      // related products er jonno (default weight)
      getDeliverySummary({
        storeId: store._id,
        pincode: req.query.pincode,
        country: req.query.country,
      }),
      getDeliverySummary({
        storeId: store._id,
        pincode: req.query.pincode,
        country: req.query.country,
        parcel,
      }),
    ]);

    const relatedProducts = relatedRaw.map((p) => ({
      ...formatProduct({
        ...p,
        categoryId: categoryId ? { _id: categoryId } : null,
      }),
      delivery,
    }));

    return res.status(200).json({
      success: true,
      store,
      delivery: productDelivery,
      product: { ...formatProduct(product), delivery: productDelivery },
      relatedProducts,
    });
  } catch (error) {
    console.error("Get Store Single Product Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  createProduct,
  getAllProducts,
  getSingleProduct,
  updateProduct,
  deleteProduct,
  allProductWithStore,
  verifyStatus,
  getStoreCategories,
  getStoreProducts,
  getStoreProductsByCategory,
  getStoreSingleProduct,
};