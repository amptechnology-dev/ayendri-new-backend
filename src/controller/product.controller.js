const mongoose = require("mongoose");
const ProductModel = require("../model/product.model.js");
const UserModel = require("../model/user.model.js");
const StoreModel = require("../model/store.model.js");
const CategoryModel = require("../model/category.model.js");
const {
  createProductSchema,
  updateProductSchema,
} = require("../schema/product.schema.js");
const { parsePickupAddress } = require("../helper/pickupAddress.js");
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
const {
  getDeliverySummary,
  getDeliveryResult,
  buildSummary,
} = require("../helper/deliveryEstimate.js");
// [GST]
const { applyGst, withEffectiveGst } = require("../helper/gst.js");
const shiprocket = require("../helper/shiprocket.js");
const {
  parseProductPolicy,
  getPublicStoreSettings,
} = require("../helper/productPolicy.js");
const { sendPickupContactProductMail } = require("../helper/pickupMail.js");
const BookingSlotModel = require("../model/bookingSlot.model.js");
const {
  getBookingConfig,
  earliestBookingYmdFor,
  nextAvailableBookingYmd,
  upcomingBlockedDates,
  isPastCutoff,
  cutoffLabel,
} = require("../helper/bookingConfig.js");
const {
  issuePhoneOtp,
  verifyPhoneOtpCode,
  clearPhoneOtp,
} = require("../helper/phoneOtp.js");

const PRODUCT_OTP_PURPOSE = "PRODUCT_VERIFY";

const policyErrorResponse = (res, error) =>
  res.status(400).json({
    success: false,
    message: "Validation failed",
    errors: [error],
  });

// jodi age theke pickupErrorResponse import/define kora thake, shetar bodole eta rakho (ei file e chilo na)
const pickupErrorResponse = (res, error) =>
  res.status(400).json({
    success: false,
    message: "Validation failed",
    errors: [
      typeof error === "string"
        ? { field: "pickupAddress", message: error }
        : error,
    ],
  });

// pickup address dile contact email must (mail jabe)
const pickupEmailError = (address) =>
  address && !String(address.email || "").trim()
    ? {
        field: "pickupAddress.email",
        message: "Pickup contact email is required",
      }
    : null;

const PICKUP_FIELDS = [
  "contactName",
  "phone",
  "email",
  "addressLine",
  "area",
  "city",
  "state",
  "pincode",
];
const pickupChanged = (oldA, newA) =>
  PICKUP_FIELDS.some(
    (f) => String(oldA?.[f] || "").trim() !== String(newA?.[f] || "").trim(),
  );

// fire-and-forget: kokhono response block / fail korbe na
const mailPickupContact = async ({ product, address, isUpdate }) => {
  const store = await StoreModel.findById(product.storeId)
    .select("storeName storeUniqueId")
    .lean();
  await sendPickupContactProductMail({ product, store, address, isUpdate });
};

const escapeRegex = (str = "") => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toBool = (v) => String(v).trim().toLowerCase() === "true";

// [BOOKING LIMIT] faka = unlimited (null). Noile 1..10000 whole number
const parseBookingLimit = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { value: null };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10000) {
    return {
      error: {
        field: "dailyBookingLimit",
        message:
          "Daily booking limit must be a whole number between 1 and 10000",
      },
    };
  }
  return { value: n };
};

const ymdAddDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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

    // [CAT TYPE] category oi store er hote hobe AND product type er sathe type mile jete hobe
    const itemType = parsedData.productType || "PRODUCT";
    const category = await CategoryModel.findOne({
      _id: parsedData.categoryId,
      storeId: parsedData.storeId,
      type: itemType,
    });
    if (!category) {
      return res.status(404).json({
        success: false,
        message: `Selected category is not a valid ${itemType.toLowerCase()} category for this store`,
      });
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
    const policyResult = parseProductPolicy(body);
    if (policyResult.error) return policyErrorResponse(res, policyResult.error);
    Object.assign(data, policyResult.policy);
    if (data.productType === "SERVICE") {
      const bl = parseBookingLimit(body.dailyBookingLimit);
      if (bl.error) return policyErrorResponse(res, bl.error);
      data.dailyBookingLimit = bl.value;
    } else {
      data.dailyBookingLimit = null;
    }
    const pickup = parsePickupAddress(body);
    if (pickup.error) return pickupErrorResponse(res, pickup.error);
    const pickupEmailErr = pickupEmailError(pickup.address);
    if (pickupEmailErr) return pickupErrorResponse(res, pickupEmailErr);
    data.fastestDelivery =
      data.productType !== "SERVICE" && toBool(body.fastestDelivery);

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
      isVerified: false, // [CHANGED] OTP diye verify na kora porjonto public e dekhabe na
      hasVariants,
      hasColor,
      ...data,
      pickupAddress: pickup.address,
      hasStockManagement: stockEnabled,
      isMadeForProduct: !stockEnabled,
    });

    // [STOCK] stock off hole low stock flag shobshomoy false
    product.hasLowStock = stockEnabled
      ? computeLowStock(product).hasLowStock
      : false;

    await product.save();

    // [PICKUP MAIL] product save hoye gele pickup contact ke mail (fire-and-forget,
    // mail fail korle product create block / fail hobe na)
    if (pickup.address?.email) {
      mailPickupContact({
        product,
        address: pickup.address,
        isUpdate: false,
      }).catch((e) => console.error("Pickup product mail error:", e.message));
    }

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
      message:
        "Product created. Verify it with OTP from Unverified Products to publish it.",
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

    const showUnverified = req.query.verified === "false";

    if (req.query.verified === "true") matchStage.isVerified = true;
    if (showUnverified) {
      matchStage.$and = [
        { $or: [{ isVerified: false }, { hasPendingUpdate: true }] },
      ];
    }

    if (search) {
      matchStage.$or = [
        { name: { $regex: escapeRegex(search), $options: "i" } },
        { productCode: { $regex: escapeRegex(search), $options: "i" } },
      ];
    }

    const pipeline = [
      { $match: matchStage },

      ...(showUnverified
        ? [
            {
              $replaceRoot: {
                newRoot: {
                  $mergeObjects: [
                    "$$ROOT",
                    { $ifNull: ["$pendingUpdate.updateData", {}] },
                  ],
                },
              },
            },
          ]
        : []),
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
          isMadeForProduct: 1,
          productType: 1,
          fastestDelivery: 1,
          isReturnable: 1,
          returnDays: 1,
          isReplaceable: 1,
          replaceDays: 1,
          isRefundable: 1,
          refundDays: 1,
          minOfferPrice: 1,
          maxOfferPrice: 1,
          deliveryTime: 1,
          isActive: 1,
          isVerified: 1,
          hasPendingUpdate: 1,
          pickupAddress: 1,
          storeId: 1,
          categoryId: 1,
          userId: 1,
          createdAt: 1,
          averageRating: 1,
          totalReviews: 1,
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

const resolveStockForApply = (product, data, stockManaged, meta) => {
  if (!stockManaged) {
    stripStockFields(data);
    return;
  }

  if (!data.hasVariants) {
    if (meta.openingStock !== undefined && meta.openingStock !== null) {
      Object.assign(
        data,
        applyOpeningStockDelta(
          product.openingStock,
          product.currentStock,
          meta.openingStock,
        ),
      );
    } else {
      data.openingStock = product.openingStock;
      data.currentStock = product.currentStock;
    }
    return;
  }

  const existingFlat = [];
  (product.variants || []).forEach((v) => {
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

  (data.variants || []).forEach((v) => {
    if (Array.isArray(v.sizeVariants) && v.sizeVariants.length) {
      v.sizeVariants.forEach(applyToVariant);
    } else {
      applyToVariant(v);
    }
  });
};

// [PENDING] payload ta product e asholei apply kore.
//  - verify korar somoy (markVerified = true)
//  - ekhono unverified product edit korle direct (markVerified = false)
const applyProductUpdate = async (
  product,
  payload,
  userId,
  { markVerified = false } = {},
) => {
  const {
    updateData = {},
    unsetFields = {},
    meta = {},
    pickupMailAddress = null,
  } = payload;

  const data = { ...updateData };
  const stockManaged = isStockManaged(product);

  // verify porjonto onno product ei name nite pare, tai abar check
  if (data.name) {
    const duplicate = await ProductModel.findOne({
      name: {
        $regex: `^${escapeRegex(String(data.name).trim())}$`,
        $options: "i",
      },
      storeId: product.storeId,
      _id: { $ne: product._id },
    }).select("_id");
    if (duplicate) {
      throw Object.assign(new Error("Product name already exists"), {
        statusCode: 400,
      });
    }
  }

  // sudhu notun color image add hoyechilo
  if (meta.colorImageMap) {
    data.variants = (product.variants || []).map((v, idx) => {
      const obj = v.toObject ? v.toObject() : v;
      return {
        ...obj,
        images: [...(obj.images || []), ...(meta.colorImageMap[idx] || [])],
      };
    });
  }

  // [STOCK] ekhon (verify er somoy) current stock er opor delta
  if (meta.isStructural) {
    resolveStockForApply(product, data, stockManaged, meta);
    data.hasLowStock = stockManaged
      ? computeLowStock({ ...product.toObject(), ...data }).hasLowStock
      : false;
  }

  const $set = { ...data, hasPendingUpdate: false };
  if (markVerified) $set.isVerified = true;

  const updatedProduct = await ProductModel.findByIdAndUpdate(
    product._id,
    { $set, $unset: { ...unsetFields, pendingUpdate: "" } },
    { new: true, runValidators: true },
  );

  if (pickupMailAddress?.email) {
    mailPickupContact({
      product: updatedProduct,
      address: pickupMailAddress,
      isUpdate: true,
    }).catch((e) => console.error("Pickup product mail error:", e.message));
  }

  if (meta.isStructural && stockManaged) {
    const beforeUnits = flattenStockUnits(product);
    const afterUnits = flattenStockUnits(updatedProduct);

    await Promise.all(
      afterUnits
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
        .filter(Boolean),
    );

    if (updatedProduct.hasLowStock && !product.hasLowStock) {
      const { lowUnits } = computeLowStock(updatedProduct);
      await notifyLowStock({
        product: updatedProduct,
        lowUnits,
        userId,
        storeId: updatedProduct.storeId,
      });
    }
  }

  return updatedProduct;
};

const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }
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

    // [OTP REMOVED] update e ar OTP lage na. OTP lagbe verify korar somoy

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
    const tierParseError = parseJsonField(body, "priceTiers");
    if (tierParseError) {
      return res.status(400).json({ success: false, message: tierParseError });
    }
    const gstParseError = parseGstField(body);
    if (gstParseError) {
      return res.status(400).json({ success: false, message: gstParseError });
    }

    const parsedData = updateProductSchema.parse(body);

    if (findOfferWithoutMrp(body)) return offerWithoutMrpResponse(res);

    // name change hole SAME STORE e duplicate check
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

    // [CAT TYPE]
    const targetType =
      parsedData.productType || existingProduct.productType || "PRODUCT";
    const typeChanged =
      targetType !== (existingProduct.productType || "PRODUCT");
    const categoryToCheck =
      parsedData.categoryId ||
      (typeChanged ? existingProduct.categoryId : null);

    if (categoryToCheck) {
      const category = await CategoryModel.findOne({
        _id: categoryToCheck,
        storeId: existingProduct.storeId,
        type: targetType,
      });
      if (!category) {
        return res.status(404).json({
          success: false,
          message: `Selected category is not a valid ${targetType.toLowerCase()} category for this store`,
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
    const unsetFields = {};

    // [PENDING] verify er somoy stock hishab korar jonno raw value rakhi
    const meta = {
      isStructural: false,
      openingStock: body.openingStock,
      colorImageMap: null,
    };

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

      const tierError = applyPriceTiers(body, data, hasVariants);
      if (tierError) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: [{ field: "priceTiers", message: tierError }],
        });
      }
      syncTiers(data, body, hasVariants);

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

      // [PENDING] stock + hasLowStock ekhane hishab hoy na, applyProductUpdate e hoy
      updateData = {
        ...updateData,
        ...data,
        images: finalMainImages,
        hasVariants,
        hasColor,
      };

      if (!data.gst) {
        delete updateData.gst;
        unsetFields.gst = "";
      }
      if (!data.hsnCode) {
        delete updateData.hsnCode;
        unsetFields.hsnCode = "";
      }

      meta.isStructural = true;
    } else if (existingProduct.hasColor && req.files?.length) {
      // sudhu notun color image. Existing variants verify er somoy merge hobe
      const colorImageMap = await uploadVariantImages(req.files);
      if (Object.keys(colorImageMap).length) meta.colorImageMap = colorImageMap;
    }

    const policyResult = parseProductPolicy(body, {
      currentType: existingProduct.productType || "PRODUCT",
    });
    if (policyResult.error) return policyErrorResponse(res, policyResult.error);
    if (policyResult.policy) Object.assign(updateData, policyResult.policy);

    const pickup = parsePickupAddress(body);
    if (pickup.error) return pickupErrorResponse(res, pickup.error);
    const pickupEmailErr = pickupEmailError(pickup.address);
    if (pickupEmailErr) return pickupErrorResponse(res, pickupEmailErr);

    let pickupMailAddress = null;
    if (pickup.clear) {
      delete updateData.pickupAddress;
      unsetFields.pickupAddress = "";
    } else if (pickup.address) {
      updateData.pickupAddress = pickup.address;
      if (pickupChanged(existingProduct.pickupAddress, pickup.address)) {
        pickupMailAddress = pickup.address;
      }
    }

    if (body.fastestDelivery !== undefined) {
      updateData.fastestDelivery = toBool(body.fastestDelivery);
    }
    const finalType =
      updateData.productType || existingProduct.productType || "PRODUCT";
    if (finalType === "SERVICE") updateData.fastestDelivery = false;

    if (finalType === "SERVICE") {
      if (body.dailyBookingLimit !== undefined) {
        const bl = parseBookingLimit(body.dailyBookingLimit);
        if (bl.error) return policyErrorResponse(res, bl.error);
        updateData.dailyBookingLimit = bl.value;
      }
    } else {
      updateData.dailyBookingLimit = null;
    }

    delete updateData.hasStockManagement;
    delete updateData.isMadeForProduct;

    // Mixed e rakhle string thakbe, lookup (aggregate) e match korar jonno ObjectId kore nilam
    if (updateData.categoryId) {
      updateData.categoryId = new mongoose.Types.ObjectId(
        String(updateData.categoryId),
      );
    }

    const payload = {
      updateData,
      unsetFields,
      meta,
      pickupMailAddress,
      submittedAt: new Date(),
    };

    // ---- ekhono verify-i hoyni: direct update (already public noy) ----
    if (!existingProduct.isVerified) {
      const updated = await applyProductUpdate(
        existingProduct,
        payload,
        userId,
        {
          markVerified: false,
        },
      );
      return res.status(200).json({
        success: true,
        pending: false,
        message: "Product updated. Verify it with OTP to publish it.",
        data: updated,
      });
    }

    // ---- verified product: live data na chuye pending e rakho ----
    await ProductModel.updateOne(
      { _id: id },
      { $set: { pendingUpdate: payload, hasPendingUpdate: true } },
    );

    return res.status(200).json({
      success: true,
      pending: true,
      message:
        "Changes saved. Verify the product with OTP from Unverified Products to make them live.",
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
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid product id" });
    }
    const userId = req.user?._id || req.user?.id;

    // [SECURITY] shudhu nijer product delete korte parbe
    const product = await ProductModel.findOneAndDelete({ _id: id, userId });
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }
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
      .select("-pickupAddress")
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

const getProductPickupAddress = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }
    const userId = req.user?._id || req.user?.id;
    const product = await ProductModel.findOne({ _id: id, userId })
      .select("pickupAddress +pendingUpdate")
      .lean();
    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    let pickupAddress = product.pickupAddress || null;
    const pending = product.pendingUpdate;
    if (pending) {
      if (pending.unsetFields?.pickupAddress !== undefined) {
        pickupAddress = null;
      } else if (pending.updateData?.pickupAddress) {
        pickupAddress = pending.updateData.pickupAddress;
      }
    }

    return res.status(200).json({ success: true, pickupAddress });
  } catch (error) {
    console.error("Get Pickup Address Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const verifyStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isVerify } = req.body;
    if (!id) {
      return res.status(400).json({ message: "Product ID is required" });
    }
    if (typeof isVerify !== "boolean") {
      return res
        .status(400)
        .json({ success: false, message: "isVerify must be true or false" });
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
  "name productCode images description unit mrp offerPrice variants priceTiers gst gstInclusive hsnCode deliveryTime storeId categoryId createdAt productType fastestDelivery isReturnable returnDays isReplaceable replaceDays isRefundable refundDays pickupAddress averageRating totalReviews";

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
const formatProduct = ({ categoryId, pickupAddress, ...product }) => ({
  ...withEffectiveGst(product),
  categoryId: categoryId?._id ?? null,
  category: categoryId?._id
    ? { _id: categoryId._id, name: categoryId.name }
    : null,
  hasTierPricing: productHasTiers(product),
  minTierPrice: getMinTierPrice(product),
  priceOnRequest: isPriceOnRequestProduct(product),
});

// ---------- [REVIEW] sobcheye beshi rating-er review (tie hole: comment ache > notun) ----------
const pickTopReview = (reviews = []) => {
  if (!reviews.length) return null;
  const hasText = (r) => !!String(r.comment || "").trim();

  return reviews.reduce((best, r) => {
    if (!best) return r;
    if (r.rating > best.rating) return r;
    if (r.rating === best.rating) {
      if (hasText(r) && !hasText(best)) return r;
      if (
        hasText(r) === hasText(best) &&
        new Date(r.createdAt) > new Date(best.createdAt)
      ) {
        return r;
      }
    }
    return best;
  }, null);
};

// products er moddhe thaka shob "reviews" array bad diye shudhu maxReview + averageRating + totalReviews rakhe
const attachTopReviews = async (products) => {
  const tops = products.map((p) => pickTopReview(p.reviews));

  const userIds = [
    ...new Set(tops.filter((t) => t?.userId).map((t) => String(t.userId))),
  ];
  const users = userIds.length
    ? await UserModel.find({ _id: { $in: userIds } })
        .select("name picture")
        .lean()
    : [];
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  return products.map((p, i) => {
    const { reviews, ...rest } = p;
    const t = tops[i];
    const u = t ? userMap.get(String(t.userId)) : null;

    return {
      ...rest,
      averageRating: p.averageRating || 0,
      totalReviews: p.totalReviews || 0,
      maxReview: t
        ? {
            _id: t._id,
            rating: t.rating,
            comment: t.comment || "",
            image: t.image || null,
            createdAt: t.createdAt,
            reply: t.reply || null,
            user: u ? { _id: u._id, name: u.name, picture: u.picture } : null,
          }
        : null,
    };
  });
};

// listing e dekhanor jonno product er sobcheye kom offer price (variant / size / simple)
const getListingPrice = (p) => {
  const prices = [];
  const push = (v) => {
    if (v !== undefined && v !== null && Number.isFinite(Number(v))) {
      prices.push(Number(v));
    }
  };
  (p.variants || []).forEach((v) => {
    if (Array.isArray(v.sizeVariants) && v.sizeVariants.length) {
      v.sizeVariants.forEach((sv) => push(sv.offerPrice));
    } else {
      push(v.offerPrice);
    }
  });
  if (!prices.length) push(p.offerPrice);
  return prices.length ? Math.min(...prices) : null;
};

// product detail e: selected variant / size er price, na thakle listing price
const unitPriceFor = (p, variantId) => {
  if (variantId) {
    const id = String(variantId);
    for (const v of p.variants || []) {
      if (String(v._id) === id && v.offerPrice != null) {
        return Number(v.offerPrice);
      }
      for (const sv of v.sizeVariants || []) {
        if (String(sv._id) === id && sv.offerPrice != null) {
          return Number(sv.offerPrice);
        }
      }
    }
  }
  return getListingPrice(p);
};

const productTypeOf = (p) =>
  p?.productType === "SERVICE" ? "SERVICE" : "PRODUCT";

const buildDeliveryPicker = async ({ storeId, pincode, country, products }) => {
  // [PICKUP] same pickup pincode + fastest flag combination ekbar-i hishab hoy
  const cache = new Map();
  const resultFor = (pickupPincode, fastest) => {
    const ck = `${pickupPincode || ""}|${fastest ? 1 : 0}`;
    if (!cache.has(ck)) {
      cache.set(
        ck,
        getDeliveryResult({
          storeId,
          pincode,
          country,
          fastest,
          pickupPincode: pickupPincode || undefined,
        }),
      );
    }
    return cache.get(ck);
  };

  const baseRes = await resultFor("", false);
  const base = buildSummary(baseRes);

  const perProduct = new Map();
  await Promise.all(
    products.map(async (p) => {
      perProduct.set(
        String(p._id),
        await resultFor(
          p?.productType === "SERVICE" ? "" : p?.pickupAddress?.pincode,
          p?.fastestDelivery === true,
        ),
      );
    }),
  );

  const pick = (p) =>
    buildSummary(perProduct.get(String(p?._id)) || baseRes, {
      itemsTotal: p ? getListingPrice(p) : null,
      productType: productTypeOf(p),
    });

  return { base, pick };
};

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
  else if (query.sortBy === "rating") {
    sort = { averageRating: -1, totalReviews: -1, _id: -1 };
  } else sort = { ...(SORT_MAP[query.sortBy] || SORT_MAP.newest), _id: -1 };

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
              isMadeForProduct: 1,
              hasStockManagement: 1,
              productType: 1,
              fastestDelivery: 1, // [FAST]
              isReturnable: 1,
              returnDays: 1,
              isReplaceable: 1,
              replaceDays: 1,
              isRefundable: 1,
              refundDays: 1,
              minOfferPrice: 1,
              deliveryTime: 1,
              storeId: 1,
              categoryId: { _id: 1, name: 1 },
              createdAt: 1,
              // [REVIEW] attachTopReviews e reviews array bad diye maxReview banay
              averageRating: 1,
              totalReviews: 1,
              reviews: 1,
            },
          },
        ],
        totalCount: [{ $count: "count" }],
      },
    },
  );

  const [result] = await ProductModel.aggregate(pipeline);
  const rawProducts = result?.data || [];
  const totalProducts = result?.totalCount?.[0]?.count || 0;
  const totalPages = Math.ceil(totalProducts / limit);

  // [REVIEW] maxReview + rating
  const products = await attachTopReviews(rawProducts);

  // [FAST] normal + (dorkar hole) fastest delivery
  const { base: delivery, pick } = await buildDeliveryPicker({
    storeId: store._id,
    pincode: query.pincode,
    country: query.country,
    products,
  });

  const storeSettings = await getPublicStoreSettings(store._id);

  return {
    page,
    limit,
    totalPages,
    totalProducts,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
    delivery,
    products: products.map((p) => ({ ...formatProduct(p), delivery: pick(p) })),
  };
};

const getStoreCategories = async (req, res) => {
  try {
    const { storeUniqueId } = req.params;

    const store = await getPublicStore(storeUniqueId);
    if (!store) return sendStoreUnavailable(res);

    const match = { storeId: store._id, isActive: true };

    // [CAT TYPE] optional ?type=PRODUCT|SERVICE
    const type = String(req.query.type || "")
      .trim()
      .toUpperCase();
    if (type) {
      if (!["PRODUCT", "SERVICE"].includes(type)) {
        return res
          .status(400)
          .json({ success: false, message: "type must be PRODUCT or SERVICE" });
      }
      match.type = type;
    }

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
          type: 1, // [CAT TYPE]
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

    // [GST] [FAST] PRODUCT_LIST_FIELDS e gst, gstInclusive, fastestDelivery, averageRating, totalReviews ache
    // [REVIEW] reviews populate lagbe na, attachTopReviews nijei user ane
    let products = await ProductModel.find(match)
      .select(
        `${PRODUCT_LIST_FIELDS} stock hasVariants hasColor hasStockManagement isMadeForProduct reviews`,
      )
      .populate("categoryId", "name")
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

    // [REVIEW] reviews array bad, maxReview + averageRating + totalReviews add
    products = await attachTopReviews(products);

    // [FAST] normal + (dorkar hole) fastest delivery
    const { base: delivery, pick } = await buildDeliveryPicker({
      storeId: store._id,
      pincode: req.query.pincode,
      country: req.query.country,
      products,
    });

    products = products.map((p) => {
      const prices = getOfferPrices(p);
      const minOfferPrice = prices.length ? Math.min(...prices) : null;

      return {
        ...formatProduct(p), // [GST] + [REVIEW] averageRating, totalReviews, maxReview
        minOfferPrice,
        delivery: pick(p), // [FAST]
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
    } else if (sortBy === "rating") {
      // [REVIEW] sobcheye beshi rating age
      products.sort(
        (a, b) =>
          b.averageRating - a.averageRating || b.totalReviews - a.totalReviews,
      );
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

    // "-userId -__v -reviews" exclude kore. [REVIEW] reviews alada API theke ashe,
    // averageRating + totalReviews ekhane thakbe
    const product = await ProductModel.findOne({
      _id: productId,
      storeId: store._id,
      isActive: true,
      isVerified: true,
    })
      .select("-userId -__v -reviews")
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
    const variantId =
      !rawVariant || rawVariant === "null" || rawVariant === "undefined"
        ? null
        : rawVariant;
    const quantity = Math.max(1, parseInt(req.query.quantity, 10) || 1);

    const parcel = shiprocket.buildParcel([{ product, variantId, quantity }]);

    // [NEW] order value = selected variant er price x quantity
    const unit = unitPriceFor(product, variantId);
    const itemsTotal =
      unit !== null ? Math.round(unit * quantity * 100) / 100 : null;

    const [related, productDelivery, storeSettings] = await Promise.all([
      // related products er jonno (default weight), [FAST] proti product er flag onujayi
      buildDeliveryPicker({
        storeId: store._id,
        pincode: req.query.pincode,
        country: req.query.country,
        products: relatedRaw,
      }),
      // [FAST] ei product e fastestDelivery on thakle fastest courier
      getDeliverySummary({
        storeId: store._id,
        pincode: req.query.pincode,
        country: req.query.country,
        parcel,
        fastest: product.fastestDelivery === true,
        itemsTotal,
        productType: productTypeOf(product),
        pickupPincode:
          product.productType === "SERVICE"
            ? undefined
            : product.pickupAddress?.pincode, // [PICKUP]
      }),
      getPublicStoreSettings(store._id),
    ]);

    const relatedProducts = relatedRaw.map((p) => ({
      ...formatProduct({
        ...p,
        categoryId: categoryId ? { _id: categoryId } : null,
      }),
      delivery: related.pick(p),
    }));

    return res.status(200).json({
      success: true,
      store,
      storeSettings,
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

const getBookingAvailability = async (req, res) => {
  try {
    const { storeUniqueId, productId } = req.params;

    if (!mongoose.isValidObjectId(productId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }

    const store = await getPublicStore(storeUniqueId);
    if (!store) return sendStoreUnavailable(res);

    const product = await ProductModel.findOne({
      _id: productId,
      storeId: store._id,
      isActive: true,
      isVerified: true,
      productType: "SERVICE",
    })
      .select("name dailyBookingLimit")
      .lean();

    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Service not found" });
    }

    // [BOOKING] store er cutoff + blocked date
    const cfg = await getBookingConfig(store._id);
    const blocked = new Set(cfg.blockedDates);
    const rawEarliest = earliestBookingYmdFor(cfg);

    const fromQ = String(req.query.from || "");
    const from =
      /^\d{4}-\d{2}-\d{2}$/.test(fromQ) && fromQ >= rawEarliest
        ? fromQ
        : rawEarliest;
    const count = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 60);

    // blocked date skip kore bookable date list (blocked date response e ashbe na)
    const dates = [];
    let cursor = from;
    for (let i = 0; i < 400 && dates.length < count; i++) {
      if (!blocked.has(cursor)) dates.push(cursor);
      cursor = ymdAddDays(cursor, 1);
    }

    const meta = {
      earliestBookingDate: nextAvailableBookingYmd(cfg),
      todayClosed: isPastCutoff(cfg),
      cutoffTime: cfg.cutoffTime,
      cutoffLabel: cutoffLabel(cfg.cutoffTime),
      blockedDates: upcomingBlockedDates(cfg), // calendar e disable korar jonno (chaile mobile ignore korte pare)
      availableDates: dates,
    };

    const limit = product.dailyBookingLimit;
    if (!limit) {
      return res.status(200).json({
        success: true,
        limited: false,
        dailyBookingLimit: null,
        days: [],
        ...meta,
      });
    }

    const slots = await BookingSlotModel.find({
      productId: product._id,
      date: { $in: dates },
    })
      .select("date count")
      .lean();
    const countMap = new Map(slots.map((s) => [s.date, s.count]));

    return res.status(200).json({
      success: true,
      limited: true,
      dailyBookingLimit: limit,
      ...meta,
      days: dates.map((date) => {
        const booked = countMap.get(date) || 0;
        const remaining = Math.max(0, limit - booked);
        return { date, booked, remaining, full: remaining === 0 };
      }),
    });
  } catch (error) {
    console.error("Get Booking Availability Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

// POST /api/product/send-otp
const sendProductOtp = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const user = await UserModel.findById(userId);
    if (!user || user.role !== "STORE") {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    if (!user.phone) {
      return res.status(400).json({
        success: false,
        message: "No mobile number found for this account",
      });
    }

    const result = await issuePhoneOtp(user.phone, PRODUCT_OTP_PURPOSE);
    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message,
        retryAfter: result.retryAfter,
      });
    }

    return res
      .status(200)
      .json({ success: true, message: "OTP sent to your mobile number" });
  } catch (error) {
    console.error("Send product OTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to send OTP. Please try again later.",
    });
  }
};

const verifyProducts = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const user = await UserModel.findById(userId);
    if (!user || user.role !== "STORE") {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const { productIds, otp } = req.body;
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Select at least one product" });
    }
    if (productIds.length > 200) {
      return res.status(400).json({
        success: false,
        message: "You can verify at most 200 products at once",
      });
    }
    if (!productIds.every((id) => mongoose.isValidObjectId(id))) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }
    if (!String(otp || "").trim()) {
      return res
        .status(400)
        .json({ success: false, message: "OTP is required" });
    }

    const check = await verifyPhoneOtpCode(
      user.phone,
      PRODUCT_OTP_PURPOSE,
      String(otp).trim(),
    );
    if (!check.ok) {
      return res
        .status(check.status || 400)
        .json({ success: false, message: check.message || "Invalid OTP" });
    }

    // [SECURITY] nijer product: notun unverified + pending update thaka
    const products = await ProductModel.find({
      _id: { $in: productIds },
      userId,
      $or: [{ isVerified: false }, { hasPendingUpdate: true }],
    }).select("+pendingUpdate");

    if (!products.length) {
      return res.status(404).json({
        success: false,
        message: "No unverified products found to verify",
      });
    }

    const done = []; // {name, storeId} email er jonno
    const plainIds = []; // pending chhilo na, shudhu isVerified true hobe
    const failed = [];

    for (const p of products) {
      if (p.hasPendingUpdate && p.pendingUpdate) {
        try {
          const updated = await applyProductUpdate(p, p.pendingUpdate, userId, {
            markVerified: true,
          });
          done.push({ name: updated.name, storeId: updated.storeId });
        } catch (e) {
          console.error("Apply pending update error:", p._id, e.message);
          failed.push({ _id: p._id, name: p.name, message: e.message });
        }
      } else {
        plainIds.push(p._id);
        done.push({ name: p.name, storeId: p.storeId });
      }
    }

    if (plainIds.length) {
      await ProductModel.updateMany(
        { _id: { $in: plainIds }, userId },
        { $set: { isVerified: true } },
      );
    }
    await clearPhoneOtp(user.phone, PRODUCT_OTP_PURPOSE);

    // verify email (fire-and-forget)
    (async () => {
      try {
        if (!user.email || !done.length) return;
        const stores = await StoreModel.find({
          _id: { $in: [...new Set(done.map((p) => String(p.storeId)))] },
        })
          .select("storeName storeUniqueId")
          .lean();
        const storeMap = new Map(stores.map((s) => [String(s._id), s]));
        for (const p of done) {
          const s = storeMap.get(String(p.storeId));
          if (!s) continue;
          await sendProductVerifyEmail(
            user.email,
            p.name,
            s.storeName,
            s.storeUniqueId,
          ).catch((e) =>
            console.error("Product verify mail error:", e.message),
          );
        }
      } catch (e) {
        console.error("Product verify mail error:", e.message);
      }
    })();

    if (!done.length) {
      return res.status(400).json({
        success: false,
        message: failed[0]?.message || "Verification failed",
        failed,
      });
    }

    return res.status(200).json({
      success: true,
      message: `${done.length} product${done.length > 1 ? "s" : ""} verified successfully${
        failed.length ? `, ${failed.length} failed` : ""
      }`,
      verifiedCount: done.length,
      failed,
    });
  } catch (error) {
    console.error("Verify products error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const getProductForEdit = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }
    const userId = req.user?._id || req.user?.id;

    const doc = await ProductModel.findOne({ _id: id, userId })
      .select("-pickupAddress -reviews +pendingUpdate")
      .lean();
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    const { pendingUpdate, ...live } = doc;
    let product = live;
    if (pendingUpdate?.updateData) {
      product = { ...live, ...pendingUpdate.updateData };
      Object.keys(pendingUpdate.unsetFields || {}).forEach((k) => {
        delete product[k];
      });
    }

    return res.status(200).json({
      success: true,
      hasPendingUpdate: !!pendingUpdate,
      product,
    });
  } catch (error) {
    console.error("Get Product For Edit Error:", error);
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
  getProductPickupAddress,
  getBookingAvailability,
  sendProductOtp,
  verifyProducts,
  getProductForEdit,
};
