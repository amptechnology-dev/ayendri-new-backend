const mongoose = require("mongoose");
const CartModel = require("../model/cart.model.js");
const ProductModel = require("../model/product.model.js");
const StoreModel = require("../model/store.model.js");
const {
  addToCartSchema,
  updateCartItemSchema,
  MAX_ITEM_QUANTITY,
  MAX_CART_LINES,
} = require("../schema/cart.schema.js");
const { resolveLineSource } = require("../helper/resolveVariant.js");
// [STOCK] product er stock management flag check
const { isStockManaged } = require("../helper/storeSettings.js");
// [TIER] quantity based pricing
const {
  getUnitPrice,
  findTiers,
  pickTierPrice,
  getNextTier,
} = require("../helper/priceTiers.js");
// [STORE] inactive / unverified store hide
const { AVAILABLE_STORE_FILTER } = require("../helper/storeAvailability.js");
// [QUOTE] price on request
const { hasPrice } = require("../helper/priceQuote.js");
// [GST]
const { getGstMode, calcLineGst } = require("../helper/gst.js");

// ===================== HELPERS =====================

const getUserId = (req) => req.user?._id || req.user?.id;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// [GST] ?state=West Bengal (user er selected delivery address er state)
const getDeliveryState = (req) =>
  typeof req.query?.state === "string" && req.query.state.trim()
    ? req.query.state.trim()
    : null;

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
      message: "Your cart was updated by another request. Please try again.",
    });
  }
  console.error(`${label}:`, error);
  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

// [TIER] quantity dhore tier price snapshot e boshay
// [QUOTE] price na thakle offerPrice / mrp null thakbe
const toSnapshot = (product, source, quantity) => ({
  name: product.name,
  productCode: product.productCode,
  image: source.image,
  unit: product.unit,
  color: source.color,
  size: source.size,
  weight: source.weight,
  height: source.height,
  mrp: hasPrice(source.mrp) ? source.mrp : null,
  offerPrice: (() => {
    const p = getUnitPrice(
      product,
      source.variantId ?? null,
      source.offerPrice,
      quantity,
    );
    return hasPrice(p) ? p : null;
  })(),
});

const newSummary = () => ({
  totalItems: 0,
  totalMrp: 0,
  discount: 0,
  subtotal: 0, // GST er age
  totalCgst: 0,
  totalSgst: 0,
  totalIgst: 0,
  totalGst: 0,
  totalAmount: 0, // payable (GST soho)
  hasUnavailableItems: false,
  hasPriceOnRequestItems: false,
});

const finalizeSummary = (s) => {
  s.totalMrp = round2(s.totalMrp);
  s.subtotal = round2(s.subtotal);
  s.totalCgst = round2(s.totalCgst);
  s.totalSgst = round2(s.totalSgst);
  s.totalIgst = round2(s.totalIgst);
  s.totalGst = round2(s.totalCgst + s.totalSgst + s.totalIgst);
  s.totalAmount = round2(s.totalAmount);
  s.discount = round2(Math.max(0, s.totalMrp - s.subtotal));
  return s;
};

// cart ke store wise group kore live product+variant data shoho response banay.
// inactive / unverified store er item default e hide hoy
// (hideUnavailableStores = false dile dekhabe, unavailable flag shoho)
// [GST] deliveryState na dile CGST+SGST dhore estimate dekhay (gstEstimated: true)
const serializeCart = async (
  cart,
  { hideUnavailableStores = true, deliveryState = null } = {},
) => {
  if (!cart || cart.items.length === 0) {
    return {
      _id: cart?._id ?? null,
      stores: [],
      summary: { ...newSummary(), totalStores: 0 },
    };
  }

  const productIds = [...new Set(cart.items.map((i) => String(i.productId)))];
  const storeIds = [...new Set(cart.items.map((i) => String(i.storeId)))];

  const [products, stores] = await Promise.all([
    ProductModel.find({ _id: { $in: productIds } })
      // [STOCK] hasStockManagement select e add kora hoyeche (lean e na thakle flag ashto na)
      // [TIER] priceTiers select e add
      // [GST] gst + gstInclusive (variants er bhetore nested gst automatic ashe)
      .select(
        "name productCode images unit variants priceTiers mrp offerPrice currentStock hasStockManagement isActive isVerified gst gstInclusive",
      )
      .lean(),
    StoreModel.find({ _id: { $in: storeIds } })
      .select("storeName storeUniqueId images isActive isVerify state")
      .lean(),
  ]);

  const productMap = new Map(products.map((p) => [String(p._id), p]));
  const storeMap = new Map(stores.map((s) => [String(s._id), s]));

  const overall = newSummary();
  const groups = new Map();

  for (const item of cart.items) {
    const storeKey = String(item.storeId);
    const store = storeMap.get(storeKey);
    const storeAvailable = Boolean(store?.isActive && store?.isVerify);

    // store inactive / unverified / delete hoye gele cart list e dekhabe na
    if (hideUnavailableStores && !storeAvailable) continue;

    // [GST] store state vs delivery state
    const gstMode = getGstMode(store?.state, deliveryState);

    if (!groups.has(storeKey)) {
      groups.set(storeKey, {
        store: {
          _id: item.storeId,
          storeName: store?.storeName ?? item.storeName ?? null,
          storeUniqueId: store?.storeUniqueId ?? null,
          image: store?.images?.[0] ?? null,
          isActive: storeAvailable,
        },
        gstMode,
        gstEstimated: !deliveryState,
        items: [],
        summary: newSummary(),
      });
    }
    const group = groups.get(storeKey);

    const liveProduct = productMap.get(String(item.productId));
    const liveSource = liveProduct
      ? resolveLineSource(liveProduct, item.variantId)
      : null;

    // [STOCK] stock management off hole stock check hobe na
    const trackStock = isStockManaged(liveProduct);
    const inStock = !trackStock || Boolean(liveSource && liveSource.stock > 0);
    const isAvailable = Boolean(
      liveProduct?.isActive &&
        liveProduct?.isVerified &&
        liveSource &&
        storeAvailable &&
        inStock,
    );

    // [STOCK] quantity cap shudhu stock managed product e
    const exceedsStock =
      isAvailable && trackStock && liveSource.stock < item.quantity;
    const cappedQuantity = exceedsStock ? liveSource.stock : item.quantity;

    // [TIER] price quantity er upor depend kore, tai cappedQuantity age
    const tiers = liveProduct ? findTiers(liveProduct, item.variantId) : [];

    const mrp = isAvailable ? liveSource.mrp : item.mrp;
    const offerPrice = isAvailable
      ? pickTierPrice(tiers, cappedQuantity, liveSource.offerPrice)
      : item.offerPrice;

    // [QUOTE] price nai -> order er por store estimate dibe, total e dhora hoy na
    const priceOnRequest = !hasPrice(offerPrice);
    const lineTotal = priceOnRequest
      ? null
      : round2(offerPrice * cappedQuantity);

    // [GST] live product er GST diye line GST (unavailable / price-on-request item e GST nai)
    const gstRates = isAvailable ? liveSource.gst : null;
    const gstInclusive = isAvailable && liveSource.gstInclusive === true;
    const g =
      isAvailable && !priceOnRequest
        ? calcLineGst({
            lineTotal,
            gst: gstRates,
            inclusive: gstInclusive,
            mode: gstMode,
          })
        : calcLineGst({ lineTotal: null });

    for (const s of [group.summary, overall]) {
      if (isAvailable) {
        s.totalItems += cappedQuantity;
        if (priceOnRequest) {
          s.hasPriceOnRequestItems = true;
        } else {
          s.totalMrp += (hasPrice(mrp) ? mrp : offerPrice) * cappedQuantity;
          s.subtotal += lineTotal;
          s.totalCgst += g.cgstAmount;
          s.totalSgst += g.sgstAmount;
          s.totalIgst += g.igstAmount;
          s.totalAmount += g.lineTotalWithGst;
        }
      } else {
        s.hasUnavailableItems = true;
      }
    }

    group.items.push({
      _id: item._id,
      productId: item.productId,
      variantId: item.variantId,
      name: isAvailable ? liveProduct.name : item.name,
      productCode: isAvailable ? liveProduct.productCode : item.productCode,
      image: isAvailable ? liveSource.image : (item.image ?? null),
      unit: isAvailable ? liveProduct.unit : item.unit,
      color: isAvailable ? liveSource.color : item.color,
      size: isAvailable ? liveSource.size : item.size,
      weight: isAvailable ? liveSource.weight : item.weight,
      height: isAvailable ? liveSource.height : item.height,
      quantity: item.quantity,
      mrp: hasPrice(mrp) ? mrp : null,
      offerPrice: priceOnRequest ? null : offerPrice,
      lineTotal, // GST er age (inclusive hole GST soho)
      priceOnRequest,
      // [GST]
      gstRates, // {cgst, sgst, igst} configured %
      gstInclusive,
      taxableAmount: g.taxableAmount,
      cgstAmount: g.cgstAmount,
      sgstAmount: g.sgstAmount,
      igstAmount: g.igstAmount,
      gstAmount: g.gstAmount,
      lineTotalWithGst: g.lineTotalWithGst,
      isAvailable,
      priceChanged: isAvailable && offerPrice !== item.offerPrice,
      // [TIER] user app e tier list + "aro X ta nile Y price" hint
      priceTiers: isAvailable ? tiers : [],
      nextTier: isAvailable ? getNextTier(tiers, cappedQuantity) : null,
      // [STOCK] stock managed na hole stock null, frontend stockManaged dekhbe
      stock: !trackStock ? null : isAvailable ? liveSource.stock : 0,
      stockManaged: trackStock,
      quantityExceedsStock: exceedsStock,
    });
  }

  const storeGroups = [...groups.values()].map((g) => ({
    ...g,
    summary: finalizeSummary(g.summary),
  }));

  return {
    _id: cart._id,
    stores: storeGroups,
    summary: { ...finalizeSummary(overall), totalStores: storeGroups.length },
  };
};

// ===================== 1. ADD TO CART =====================
const addToCart = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { productId, variantId, quantity } = addToCartSchema.parse(req.body);

    const product = await ProductModel.findOne({
      _id: productId,
      isActive: true,
      isVerified: true,
    }).lean();
    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not available" });
    }

    const source = resolveLineSource(product, variantId);
    if (!source) {
      const hasVariants =
        Array.isArray(product.variants) && product.variants.length > 0;
      return res.status(400).json({
        success: false,
        message: hasVariants
          ? "Please select a valid size/weight/color option"
          : "This product is not available right now",
      });
    }

    // [STOCK] stock check shudhu stock managed product e (cart e reserve hoy na)
    const trackStock = isStockManaged(product);

    if (trackStock && source.stock <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "This item is out of stock" });
    }

    const store = await StoreModel.findOne({
      _id: product.storeId,
      ...AVAILABLE_STORE_FILTER,
    })
      .select("storeName")
      .lean();
    if (!store) {
      return res.status(400).json({
        success: false,
        message: "This store is not present in this application",
      });
    }

    const cart = await CartModel.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId } },
      { upsert: true, new: true },
    );

    // same product + SAME variant (ba duitai simple hole) -> ek line
    const existing = cart.items.find(
      (i) =>
        String(i.productId) === String(product._id) &&
        String(i.variantId ?? "") === String(source.variantId ?? ""),
    );

    const newQuantity = (existing?.quantity ?? 0) + quantity;

    if (newQuantity > MAX_ITEM_QUANTITY) {
      return res.status(400).json({
        success: false,
        message: `You can add at most ${MAX_ITEM_QUANTITY} units of a single item`,
      });
    }

    // [STOCK] available stock er cheye beshi cart e rakhte debo na (shudhu stock managed e)
    if (trackStock && newQuantity > source.stock) {
      return res.status(400).json({
        success: false,
        message:
          source.stock > 0
            ? `Only ${source.stock} unit(s) left in stock`
            : "This item is out of stock",
      });
    }

    if (!existing && cart.items.length >= MAX_CART_LINES) {
      return res.status(400).json({
        success: false,
        message: `Your cart can hold at most ${MAX_CART_LINES} different items`,
      });
    }

    // [TIER] final quantity (newQuantity) onujayi price
    const snapshot = toSnapshot(product, source, newQuantity);

    if (existing) {
      existing.set({
        ...snapshot,
        storeName: store.storeName,
        quantity: newQuantity,
      });
    } else {
      cart.items.push({
        productId: product._id,
        variantId: source.variantId,
        storeId: product.storeId,
        storeName: store.storeName,
        quantity,
        ...snapshot,
      });
    }

    await cart.save();

    return res.status(200).json({
      success: true,
      message: "Added to cart",
      cart: await serializeCart(cart, { deliveryState: getDeliveryState(req) }),
    });
  } catch (error) {
    return handleError(res, error, "Add To Cart Error");
  }
};

// ===================== 2. GET CART (store wise) =====================
// GET /api/cart?state=West Bengal
const getCart = async (req, res) => {
  try {
    const cart = await CartModel.findOne({ userId: getUserId(req) });
    return res.status(200).json({
      success: true,
      cart: await serializeCart(cart, { deliveryState: getDeliveryState(req) }),
    });
  } catch (error) {
    return handleError(res, error, "Get Cart Error");
  }
};

// ===================== 3. UPDATE ITEM QUANTITY =====================
const updateCartItem = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { itemId } = req.params;

    if (!mongoose.isValidObjectId(itemId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid item id" });
    }

    const { quantity } = updateCartItemSchema.parse(req.body);

    const cart = await CartModel.findOne({ userId });
    const item = cart?.items.id(itemId);
    if (!item) {
      return res
        .status(404)
        .json({ success: false, message: "Cart item not found" });
    }

    const product = await ProductModel.findOne({
      _id: item.productId,
      isActive: true,
      isVerified: true,
    }).lean();

    const source = product ? resolveLineSource(product, item.variantId) : null;

    if (!source) {
      return res.status(400).json({
        success: false,
        message:
          "This product is no longer available. Please remove it from your cart.",
      });
    }

    // [STOCK] stock check shudhu stock managed product e
    if (isStockManaged(product) && quantity > source.stock) {
      return res.status(400).json({
        success: false,
        message:
          source.stock > 0
            ? `Only ${source.stock} unit(s) left in stock`
            : "This item is out of stock",
      });
    }

    // [TIER] notun quantity onujayi price
    item.set({ ...toSnapshot(product, source, quantity), quantity });
    await cart.save();

    return res.status(200).json({
      success: true,
      message: "Cart updated",
      cart: await serializeCart(cart, { deliveryState: getDeliveryState(req) }),
    });
  } catch (error) {
    return handleError(res, error, "Update Cart Item Error");
  }
};

// ===================== 4. REMOVE ITEM =====================
const removeCartItem = async (req, res) => {
  try {
    const { itemId } = req.params;

    if (!mongoose.isValidObjectId(itemId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid item id" });
    }

    const cart = await CartModel.findOneAndUpdate(
      { userId: getUserId(req) },
      { $pull: { items: { _id: new mongoose.Types.ObjectId(itemId) } } },
      { new: true },
    );

    return res.status(200).json({
      success: true,
      message: "Item removed from cart",
      cart: await serializeCart(cart, { deliveryState: getDeliveryState(req) }),
    });
  } catch (error) {
    return handleError(res, error, "Remove Cart Item Error");
  }
};

// ===================== 5. REMOVE ALL ITEMS OF ONE STORE =====================
const removeStoreItems = async (req, res) => {
  try {
    const { storeId } = req.params;

    if (!mongoose.isValidObjectId(storeId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid store id" });
    }

    const cart = await CartModel.findOneAndUpdate(
      { userId: getUserId(req) },
      { $pull: { items: { storeId: new mongoose.Types.ObjectId(storeId) } } },
      { new: true },
    );

    return res.status(200).json({
      success: true,
      message: "Store items removed from cart",
      cart: await serializeCart(cart, { deliveryState: getDeliveryState(req) }),
    });
  } catch (error) {
    return handleError(res, error, "Remove Store Items Error");
  }
};

// ===================== 6. CLEAR CART =====================
const clearCart = async (req, res) => {
  try {
    await CartModel.updateOne(
      { userId: getUserId(req) },
      { $set: { items: [] } },
    );
    return res.status(200).json({ success: true, message: "Cart cleared" });
  } catch (error) {
    return handleError(res, error, "Clear Cart Error");
  }
};

module.exports = {
  addToCart,
  getCart,
  updateCartItem,
  removeCartItem,
  removeStoreItems,
  clearCart,
  serializeCart,
};