const mongoose = require("mongoose");
const CartModel = require("../model/cart.model.js");
const OrderModel = require("../model/order.model.js");
const ProductModel = require("../model/product.model.js");
const StoreModel = require("../model/store.model.js");
const {
  cartCheckoutSchema,
  directCheckoutSchema,
  cancelOrderSchema,
  updateOrderStatusSchema,
  updateDeliveryDateSchema,
  submitQuoteSchema,
  respondQuoteSchema,
} = require("../schema/order.schema.js");
const { resolveLineSource } = require("../helper/resolveVariant.js");
const {
  locateStockUnit,
  decrementStockForLine,
  restoreStockForLine,
  logStockChange,
  findUnitStock,
} = require("../helper/stockManager.js");
const {
  notifyNewOrder,
  notifyOrderCancelled,
  notifyUserOrderStatus,
  notifyUserPriceQuote,
  notifyStorePriceResponse,
} = require("../helper/notification.helper.js");
// [STOCK] product er stock management flag check
const { isStockManaged } = require("../helper/storeSettings.js");
// [TIER] quantity based pricing
const { getUnitPrice } = require("../helper/priceTiers.js");
// [STORE] inactive / unverified store hide
const {
  AVAILABLE_STORE_FILTER,
  getAvailableStoreIds,
} = require("../helper/storeAvailability.js");
// [QUOTE] price on request
const {
  hasPrice,
  computeTotals,
  QUOTE_PENDING_STATUSES,
} = require("../helper/priceQuote.js");
const {
  checkStoreDelivery,
  finalizeShipping,
} = require("../helper/deliveryEstimate.js");
// [GST]
const { getGstMode, applyGstToItem } = require("../helper/gst.js");
const { calcWeightKg } = require("../helper/shiprocket.js");
const {
  getStorePolicy,
  resolvePaymentForStore,
} = require("../helper/storePolicy.js");
const { buildParcel } = require("../helper/shiprocket.js");

// ===================== CONSTANTS / HELPERS =====================
const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
];

// frontend er getNextStatuses er sathe mil rakho
const ALLOWED_TRANSITIONS = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

const CUSTOMER_FIELDS = "name phone email";
const MAX_LIMIT = 100;

const DELIVERY_DATE_EDITABLE = ["PENDING", "CONFIRMED", "SHIPPED"];

// [PAYMENT] ONLINE order e payment korar time limit
const PAYMENT_WINDOW_MS = 30 * 60 * 1000;

const toDeliveryDate = (str) => new Date(`${str}T00:00:00.000Z`);

const getUserId = (req) => req.user?._id || req.user?.id;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "null" / "undefined" / "" string ke real null banay
const cleanVariantId = (id) => {
  if (id === undefined || id === null) return null;
  const s = String(id).trim();
  if (!s || s === "null" || s === "undefined") return null;
  return id;
};

const lineHasGst = (g) =>
  !!g && ["cgst", "sgst", "igst"].some((k) => g[k] != null);

const parsePagination = (query) => {
  const pageNum = Math.max(parseInt(query.page) || 1, 1);
  const limitNum = Math.min(
    Math.max(parseInt(query.limit) || 10, 1),
    MAX_LIMIT,
  );
  return { pageNum, limitNum };
};

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
  console.error(`${label}:`, error);
  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

// Ei STORE-user er nijer shob store er id
const getOwnedStoreIds = async (userId) => {
  const stores = await StoreModel.find({ userId }).select("_id").lean();
  return stores.map((s) => s._id);
};

const isStoreOwner = async (storeId, userId) =>
  !!(await StoreModel.exists({ _id: storeId, userId }));

// Atomic status change: sudhu valid "from" status thakle-i update hoy.
// Concurrent request e ekta-i jitbe, tai stock double restore hobe na.
const transitionOrder = async ({
  orderId,
  filter = {},
  status,
  note,
  userId,
  extra = {},
  populateUser = false,
}) => {
  const validFrom = ORDER_STATUSES.filter((s) =>
    ALLOWED_TRANSITIONS[s].includes(status),
  );

  let query = OrderModel.findOneAndUpdate(
    { _id: orderId, ...filter, status: { $in: validFrom } },
    {
      $set: { status, ...extra },
      $push: {
        statusHistory: {
          status,
          changedBy: userId,
          note: note || null,
          at: new Date(),
        },
      },
    },
    { new: true },
  );
  if (populateUser) query = query.populate("userId", CUSTOMER_FIELDS);
  return query.lean();
};

const rollbackLines = (lines) =>
  Promise.all(
    lines.map((l) =>
      restoreStockForLine({
        productId: l.productId,
        variantId: l.variantId,
        sizeVariantId: l.sizeVariantId,
        quantity: l.quantity,
      }),
    ),
  );

// ===================== INTERNAL HELPER =====================

const linesParcel = (lines, productMap) =>
  buildParcel(
    lines
      .map((l) => ({
        product: productMap.get(String(l.productId)),
        variantId: cleanVariantId(l.variantId),
        quantity: l.quantity,
      }))
      .filter((e) => e.product),
  );

const attemptStoreCheckout = async ({
  userId,
  storeId,
  lines, // [{ productId, variantId (unitId or null), quantity }]
  deliveryAddress,
  note,
  bookingDate, // [BOOKING] "YYYY-MM-DD" (dryRun e lagbe na)
  paymentMethod,
  dryRun = false,
}) => {
  const store = await StoreModel.findOne({
    _id: storeId,
    ...AVAILABLE_STORE_FILTER,
  })
    .select("storeName storeUniqueId state") // [GST] state
    .lean();
  if (!store) {
    return {
      success: false,
      storeId,
      code: "STORE_UNAVAILABLE",
      message: "This store is not present in this application",
    };
  }

  const productIds = [...new Set(lines.map((l) => String(l.productId)))];
  const products = await ProductModel.find({
    _id: { $in: productIds },
    isActive: true,
    isVerified: true,
  });
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  // [PAYMENT] store er payment mode onujayi payment method thik kora
  const policy = await getStorePolicy(storeId);
  const payment = resolvePaymentForStore(policy, paymentMethod);
  if (!payment.ok) {
    return {
      success: false,
      storeId,
      code: payment.code,
      message: payment.message,
    };
  }
  const effectiveMethod = payment.method; // "COD" | "ONLINE"
  const paymentOff = payment.paymentOff;

  const parcel = linesParcel(lines, productMap);
  const delivery = await checkStoreDelivery({
    storeId,
    pincode: deliveryAddress?.pincode,
    country: deliveryAddress?.country,
    parcel,
    cod: effectiveMethod === "COD" && !paymentOff,
    policy,
  });
  if (!delivery.deliverable) {
    return {
      success: false,
      storeId,
      code: "NOT_DELIVERABLE",
      message:
        delivery.message || "This store does not deliver to your address",
    };
  }

  // [GST] store state != delivery state hole IGST, nahole CGST+SGST
  const gstMode = getGstMode(store.state, deliveryAddress?.state);

  const orderItems = [];
  const decrementedLines = [];
  const outOfStockLines = [];

  for (const rawLine of lines) {
    // [FIX] "null" / "undefined" string variantId ke real null kora
    const line = { ...rawLine, variantId: cleanVariantId(rawLine.variantId) };

    const product = productMap.get(String(line.productId));
    if (!product) {
      outOfStockLines.push({
        productId: line.productId,
        variantId: line.variantId,
        reason: "PRODUCT_UNAVAILABLE",
      });
      continue;
    }

    const source = resolveLineSource(product, line.variantId);
    if (!source) {
      outOfStockLines.push({
        productId: line.productId,
        variantId: line.variantId,
        name: product.name,
        reason: "VARIANT_UNAVAILABLE",
      });
      continue;
    }

    // [TIER] quantity onujayi server-side price (client theke kono price nei)
    const unitPrice = getUnitPrice(
      product,
      line.variantId,
      source.offerPrice,
      line.quantity,
    );
    // [QUOTE] price nai -> store estimate dibe
    const priceOnRequest = !hasPrice(unitPrice);

    // [STOCK] stock management ON (hasStockManagement === true) hole-i
    // stock check + minus hoy. OFF hole shudhu order hoy, out-of-stock hobe na.
    if (isStockManaged(product)) {
      const unit = locateStockUnit(product, line.variantId);
      if (!unit) {
        outOfStockLines.push({
          productId: line.productId,
          variantId: line.variantId,
          name: product.name,
          reason: "VARIANT_UNAVAILABLE",
        });
        continue;
      }

      if (dryRun) {
        // preview: stock minus na kore shudhu check
        if (Number(unit.currentStock) < Number(line.quantity)) {
          outOfStockLines.push({
            productId: line.productId,
            variantId: line.variantId,
            name: product.name,
            availableStock: unit.currentStock,
            requestedQuantity: line.quantity,
            reason: "INSUFFICIENT_STOCK",
          });
          continue;
        }
      } else {
        const result = await decrementStockForLine({
          productId: product._id,
          variantId: unit.variantId,
          sizeVariantId: unit.sizeVariantId,
          quantity: line.quantity,
        });

        if (!result.success) {
          outOfStockLines.push({
            productId: line.productId,
            variantId: line.variantId,
            name: product.name,
            availableStock: unit.currentStock,
            requestedQuantity: line.quantity,
            reason: "INSUFFICIENT_STOCK",
          });
          continue;
        }

        // [STOCK] rollback + SALE log shudhu stock managed line er jonno
        decrementedLines.push({
          productId: product._id,
          storeId: product.storeId,
          variantId: unit.variantId,
          sizeVariantId: unit.sizeVariantId,
          quantity: line.quantity,
          productName: product.name,
          variantLabel:
            [source.color, source.size, source.weight, source.height]
              .filter(Boolean)
              .join(" / ") || "Default",
          newStock: findUnitStock(
            result.product,
            unit.variantId,
            unit.sizeVariantId,
          ),
        });
      }
    }

    orderItems.push({
      productId: product._id,
      variantId: line.variantId ?? null,
      name: product.name,
      productCode: product.productCode,
      image: source.image,
      unit: product.unit,
      color: source.color,
      size: source.size,
      weight: source.weight,
      height: source.height,
      priceOnRequest,
      // [GST] size -> color -> product
      gstRates: source.gst,
      gstInclusive: source.gstInclusive === true,
      hsnCode: lineHasGst(source.gst) ? product.hsnCode || null : null,
      mrp: hasPrice(source.mrp)
        ? source.mrp
        : priceOnRequest
          ? null
          : unitPrice,
      offerPrice: priceOnRequest ? null : unitPrice, // [TIER]
      quantity: line.quantity,
      lineTotal: priceOnRequest ? null : round2(unitPrice * line.quantity), // [TIER]
    });
  }

  // ---------- kono line fail korle shob decrement rollback ----------
  if (outOfStockLines.length > 0) {
    await rollbackLines(decrementedLines);
    return { success: false, storeId, code: "OUT_OF_STOCK", outOfStockLines };
  }

  // [GST] proti item e GST calculate, tarpor totals
  const gstItems = orderItems.map((i) => applyGstToItem(i, gstMode));

  // [QUOTE] price-less item totals e dhora hoy na
  const {
    totalItems,
    totalMrp,
    discount,
    subtotal,
    totalTaxable,
    totalCgst,
    totalSgst,
    totalIgst,
    totalGst,
    totalAmount,
  } = computeTotals(gstItems);
  const priceStatus = gstItems.some((i) => i.priceOnRequest)
    ? "AWAITING_QUOTE"
    : "NOT_REQUIRED";

  // [SHIPPING] items payable dhore order value rule (eto taka er upor free ityadi) chalano,
  // tarpor items + shipping = customer er total payable (PayU eta-i nibe)
  const itemsTotal = totalAmount;
  const shippingInfo = finalizeShipping(delivery, itemsTotal); // delivery off hole null
  const shippingCharge = round2(shippingInfo?.shippingCharge || 0);
  const grandTotal = round2(itemsTotal + shippingCharge);

  // ---------- preview: order create / stock minus na kore hishab ferot ----------
  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      storeId,
      preview: {
        totalItems,
        totalMrp,
        discount,
        totalGst,
        itemsTotal,
        shippingCharge,
        grandTotal,
        delivery: shippingInfo,
        deliveryEnabled: policy.hasDelivery,
        paymentMode: policy.paymentMode,
        paymentMethod: effectiveMethod,
        paymentOff,
        priceStatus,
      },
    };
  }

  // [PAYMENT] ONLINE + price already fixed hole 30 min er payment window.
  // Quote lagbe emon order e window shuru hoy user quote accept korle (respondToQuote),
  // nahole quote asar age-i order auto-cancel hoye jabe.
  const paymentExpiresAt =
    effectiveMethod === "ONLINE" && priceStatus === "NOT_REQUIRED"
      ? new Date(Date.now() + PAYMENT_WINDOW_MS)
      : null;

  // ---------- order create fail korle stock ferot dao ----------
  let order;
  try {
    order = await OrderModel.create({
      userId,
      storeId,
      storeName: store.storeName,
      storeUniqueId: store.storeUniqueId,
      items: gstItems,
      totalItems,
      totalMrp,
      discount,
      gstMode,
      subtotal,
      totalTaxable,
      totalCgst,
      totalSgst,
      totalIgst,
      totalGst,
      itemsTotal, // items er payable (GST soho), shipping baad
      shippingCharge,
      deliveryEnabled: policy.hasDelivery,
      totalAmount: grandTotal, // payable (GST + shipping soho)
      priceStatus,
      deliveryAddress,
      deliveryInfo: shippingInfo,
      parcel: policy.hasDelivery ? parcel : null,
      note,
      bookingDate: bookingDate ? toDeliveryDate(bookingDate) : null, // [BOOKING]
      paymentMethod: effectiveMethod,
      paymentOff,
      paymentStatus: "PENDING",
      paymentExpiresAt,
      status: "PENDING",
      statusHistory: [{ status: "PENDING", changedBy: userId, at: new Date() }],
    });
  } catch (err) {
    await rollbackLines(decrementedLines);
    throw err;
  }

  // ---------- order confirm hoyeche, ekhon SALE log koro ----------
  // [STOCK] decrementedLines e shudhu stock managed line ache, tai off product skip hoy
  await Promise.all(
    decrementedLines.map((l) =>
      logStockChange({
        productId: l.productId,
        storeId: l.storeId,
        userId,
        variantId: l.variantId,
        sizeVariantId: l.sizeVariantId,
        productName: l.productName,
        variantLabel: l.variantLabel,
        type: "OUT",
        reason: "SALE",
        previousStock: l.newStock + l.quantity,
        newStock: l.newStock,
      }),
    ),
  );

  return { success: true, storeId, order };
};

// ===================== INTERNAL: restore stock for every item of an order =====================
// [PAYMENT] payment.controller (expire cron) o eta use kore, tai export kora ache
const restoreOrderStock = async (order, userId) => {
  await Promise.all(
    order.items.map(async (item) => {
      // [FIX] simple product er jonno currentStock / lowStockThreshold o select kora hoyeche
      const product = await ProductModel.findById(item.productId).select(
        "variants currentStock lowStockThreshold hasStockManagement",
      );
      // [STOCK] product nei ba stock managed na hole restore korar kichu nei
      if (!product || !isStockManaged(product)) return;

      const unit = locateStockUnit(product, cleanVariantId(item.variantId));
      if (!unit) return;

      const restored = await restoreStockForLine({
        productId: item.productId,
        variantId: unit.variantId,
        sizeVariantId: unit.sizeVariantId,
        quantity: item.quantity,
      });

      if (restored) {
        const newStock = findUnitStock(
          restored,
          unit.variantId,
          unit.sizeVariantId,
        );
        await logStockChange({
          productId: item.productId,
          storeId: order.storeId,
          userId,
          variantId: unit.variantId,
          sizeVariantId: unit.sizeVariantId,
          productName: item.name,
          variantLabel:
            [item.color, item.size, item.weight, item.height]
              .filter(Boolean)
              .join(" / ") || "Default",
          type: "IN",
          reason: "OTHER",
          note: `Order ${order.orderNumber} cancelled`,
          previousStock: newStock - item.quantity,
          newStock,
        });
      }
    }),
  );
};

// ===================== 1. CHECKOUT FROM CART (multi-store) =====================
// POST /api/order/checkout
const checkout = async (req, res) => {
  try {
    const userId = getUserId(req);
    const {
      cartId,
      storeIds,
      deliveryAddress,
      note,
      bookingDate,
      paymentMethod,
    } = cartCheckoutSchema.parse(req.body);

    const cart = await CartModel.findOne({ _id: cartId, userId });
    if (!cart) {
      return res
        .status(404)
        .json({ success: false, message: "Cart not found" });
    }

    let items = cart.items;
    if (Array.isArray(storeIds) && storeIds.length > 0) {
      const storeIdSet = new Set(storeIds.map(String));
      items = items.filter((i) => storeIdSet.has(String(i.storeId)));
    }

    if (items.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No items to checkout" });
    }

    // ---------- store wise group ----------
    const groups = new Map();
    for (const item of items) {
      const key = String(item.storeId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
      });
    }

    const createdOrders = [];
    const failedStores = [];
    const successfulStoreIds = [];

    // ---------- protyek store independently checkout hoy ----------
    for (const [storeId, lines] of groups.entries()) {
      try {
        const result = await attemptStoreCheckout({
          userId,
          storeId,
          lines,
          deliveryAddress,
          note,
          bookingDate, // [BOOKING] shob store er order e same booking date
          paymentMethod,
        });

        if (result.success) {
          createdOrders.push(result.order);
          successfulStoreIds.push(storeId);
        } else {
          failedStores.push({
            storeId,
            message: result.message,
            outOfStockLines: result.outOfStockLines,
          });
        }
      } catch (err) {
        // ekta store e unexpected error hole baki store der jeno atke na jay
        console.error(`Checkout failed for store ${storeId}:`, err);
        failedStores.push({
          storeId,
          message: "Could not place order for this store",
        });
      }
    }

    // ---------- successful store er item gulo cart theke remove ----------
    if (successfulStoreIds.length > 0) {
      await CartModel.updateOne(
        { _id: cartId, userId },
        {
          $pull: {
            items: {
              storeId: {
                $in: successfulStoreIds.map(
                  (id) => new mongoose.Types.ObjectId(id),
                ),
              },
            },
          },
        },
      );
    }

    if (createdOrders.length === 0) {
      return res.status(409).json({
        success: false,
        message: "Checkout failed for all stores",
        failedStores,
      });
    }

    for (const order of createdOrders) {
      notifyNewOrder(order);
      notifyUserOrderStatus(order);
    }

    return res.status(201).json({
      success: true,
      message:
        failedStores.length > 0
          ? "Order placed for some stores; others could not be completed"
          : "Order(s) placed successfully",
      orders: createdOrders,
      failedStores: failedStores.length > 0 ? failedStores : undefined,
    });
  } catch (error) {
    return handleError(res, error, "Checkout Error");
  }
};

// ===================== 2. DIRECT "BUY NOW" CHECKOUT =====================
// POST /api/order/buy-now
const buyNow = async (req, res) => {
  try {
    const userId = getUserId(req);
    const {
      productId,
      variantId,
      quantity,
      deliveryAddress,
      note,
      bookingDate,
      paymentMethod,
    } = directCheckoutSchema.parse(req.body);

    const product = await ProductModel.findOne({
      _id: productId,
      isActive: true,
      isVerified: true,
    });
    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not available" });
    }

    const result = await attemptStoreCheckout({
      userId,
      storeId: product.storeId,
      lines: [{ productId, variantId: cleanVariantId(variantId), quantity }],
      deliveryAddress,
      note,
      bookingDate, // [BOOKING]
      paymentMethod,
    });

    if (!result.success) {
      return res.status(409).json({
        success: false,
        message: result.message || "This item is out of stock",
        outOfStockLines: result.outOfStockLines,
      });
    }

    notifyNewOrder(result.order);
    notifyUserOrderStatus(result.order);

    return res.status(201).json({
      success: true,
      message: "Order placed successfully",
      order: result.order,
    });
  } catch (error) {
    return handleError(res, error, "Buy Now Error");
  }
};

// ===================== INTERNAL: orders grouped by store =====================
// user er order, store wise group. Inactive / unverified store er order baad.
// options: { status, ordersPerStore }
const getOrdersGroupedByStore = async (
  userId,
  { status, ordersPerStore } = {},
) => {
  const availableStoreIds = await getAvailableStoreIds();

  const match = {
    userId: new mongoose.Types.ObjectId(userId),
    storeId: { $in: availableStoreIds },
  };
  if (status) match.status = status;

  const pipeline = [
    { $match: match },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $group: {
        _id: "$storeId",
        storeName: { $first: "$storeName" },
        storeUniqueId: { $first: "$storeUniqueId" },
        totalOrders: { $sum: 1 },
        latestOrderAt: { $max: "$createdAt" },
        orders: { $push: "$$ROOT" },
      },
    },
  ];

  if (ordersPerStore) {
    pipeline.push({
      $addFields: { orders: { $slice: ["$orders", ordersPerStore] } },
    });
  }

  pipeline.push({ $sort: { latestOrderAt: -1 } });

  const grouped = await OrderModel.aggregate(pipeline);

  return grouped.map((g) => ({
    storeId: g._id,
    storeName: g.storeName,
    storeUniqueId: g.storeUniqueId,
    totalOrders: g.totalOrders,
    orders: g.orders,
  }));
};

// ===================== 3. GET MY ORDERS (flat list) =====================
// GET /api/order/my-orders
const getMyOrders = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { status } = req.query;

    if (status && !ORDER_STATUSES.includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status" });
    }

    const match = {
      userId,
      storeId: { $in: await getAvailableStoreIds() },
    };
    if (status) match.status = status;

    const { pageNum, limitNum } = parsePagination(req.query);

    const [orders, totalOrders] = await Promise.all([
      OrderModel.find(match)
        .sort({ createdAt: -1, _id: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      OrderModel.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      page: pageNum,
      limit: limitNum,
      totalOrders,
      totalPages: Math.ceil(totalOrders / limitNum),
      orders,
    });
  } catch (error) {
    return handleError(res, error, "Get My Orders Error");
  }
};

// ===================== 4. GET MY ORDERS GROUPED BY STORE =====================
// GET /api/order/my-orders/by-store
const getMyOrdersByStore = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { status } = req.query;

    if (status && !ORDER_STATUSES.includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status" });
    }

    const stores = await getOrdersGroupedByStore(userId, { status });

    return res.status(200).json({
      success: true,
      count: stores.length,
      stores,
    });
  } catch (error) {
    return handleError(res, error, "Get My Orders By Store Error");
  }
};

// ===================== 5. GET SINGLE ORDER (user side) =====================
// GET /api/order/my-orders/:orderId
const getMyOrderById = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!mongoose.isValidObjectId(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order id" });
    }

    const order = await OrderModel.findOne({
      _id: orderId,
      userId: getUserId(req),
    }).lean();
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    return res.status(200).json({ success: true, order });
  } catch (error) {
    return handleError(res, error, "Get My Order By Id Error");
  }
};

// ===================== 6. CANCEL ORDER (user side) — stock restore hoy =====================
// PATCH /api/order/my-orders/:orderId/cancel   body: { reason? }
const cancelMyOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order id" });
    }

    const { reason } = cancelOrderSchema.parse(req.body);

    const existing = await OrderModel.findOne({ _id: orderId, userId })
      .select("status paymentStatus")
      .lean();
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (!ALLOWED_TRANSITIONS[existing.status].includes("CANCELLED")) {
      return res.status(400).json({
        success: false,
        message: `Order cannot be cancelled once it is ${existing.status}`,
      });
    }

    // [PAYMENT] online paid order cancel korle refund lagbe, refund flow na thaka porjonto block
    if (existing.paymentStatus === "PAID") {
      return res.status(400).json({
        success: false,
        message:
          "Paid order cannot be cancelled online. Contact the store for refund.",
      });
    }

    // atomic claim: ekta request-i jitbe, tai stock ekbar-i restore hobe
    // [PAYMENT] filter e paymentStatus: $ne PAID, jeno ei majhe payment complete hole cancel na hoy
    const order = await transitionOrder({
      orderId,
      filter: { userId, paymentStatus: { $ne: "PAID" } },
      status: "CANCELLED",
      note: reason,
      userId,
      extra: { cancelReason: reason || null, cancelledBy: "USER" },
    });

    if (!order) {
      return res.status(409).json({
        success: false,
        message: "Order status has just changed, please refresh",
      });
    }

    notifyOrderCancelled(order);
    notifyUserOrderStatus(order);
    await restoreOrderStock(order, userId);

    return res.status(200).json({
      success: true,
      message: "Order cancelled and stock restored",
      order,
    });
  } catch (error) {
    return handleError(res, error, "Cancel My Order Error");
  }
};

// ===================== 6b. USER: ACCEPT / REJECT PRICE ESTIMATE =====================
// PATCH /api/order/my-orders/:orderId/quote
// body: { action: "ACCEPT" | "REJECT", reason? }
const respondToQuote = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order id" });
    }

    const { action, reason } = respondQuoteSchema.parse(req.body);

    const existing = await OrderModel.findOne({ _id: orderId, userId }).lean();
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (
      existing.status !== "PENDING" ||
      existing.priceStatus !== "QUOTED" ||
      !existing.quote
    ) {
      return res.status(400).json({
        success: false,
        message: "There is no price estimate waiting for your response",
      });
    }

    const now = new Date();
    let update;

    if (action === "ACCEPT") {
      const priceMap = new Map(
        existing.quote.items.map((q) => [String(q.itemId), q.unitPrice]),
      );

      // quote-er price item e fixed hoy, tarpor [GST] calculate
      const items = existing.items.map((i) => {
        if (!i.priceOnRequest) return i;
        const unit = priceMap.get(String(i._id));
        return applyGstToItem(
          {
            ...i,
            mrp: unit,
            offerPrice: unit,
            lineTotal: round2(unit * i.quantity),
          },
          existing.gstMode,
        );
      });

      if (items.some((i) => !hasPrice(i.offerPrice))) {
        return res.status(409).json({
          success: false,
          message:
            "Price estimate is incomplete, please ask the store to resend",
        });
      }

      const totals = computeTotals(items);
      const grandTotal = round2(
        totals.grandTotal + Number(existing.shippingCharge || 0),
      );
      update = {
        $set: {
          items,
          totalMrp: totals.totalMrp,
          discount: totals.discount,
          subtotal: totals.subtotal,
          totalTaxable: totals.totalTaxable,
          totalCgst: totals.totalCgst,
          totalSgst: totals.totalSgst,
          totalIgst: totals.totalIgst,
          totalGst: totals.totalGst,
          totalAmount: totals.grandTotal,
          priceStatus: "CONFIRMED",
          // [PAYMENT] ONLINE order e quote accept er por theke 30 min payment window shuru
          ...(existing.paymentMethod === "ONLINE"
            ? { paymentExpiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS) }
            : {}),
        },
        $push: {
          priceHistory: {
            action: "ACCEPTED",
            byRole: "USER",
            by: userId,
            total: totals.grandTotal,
            at: now,
          },
        },
      };
    } else {
      // reject: quote muche jay, item price abar blank
      update = {
        $set: { priceStatus: "AWAITING_QUOTE", quote: null },
        $push: {
          priceHistory: {
            action: "REJECTED",
            byRole: "USER",
            by: userId,
            total: existing.quote.total,
            note: reason || null,
            at: now,
          },
        },
      };
    }

    // quotedAt match: store ei majhe quote bodle dile purono quote accept hobe na
    const order = await OrderModel.findOneAndUpdate(
      {
        _id: orderId,
        userId,
        status: "PENDING",
        priceStatus: "QUOTED",
        "quote.quotedAt": existing.quote.quotedAt,
      },
      update,
      { new: true },
    ).lean();

    if (!order) {
      return res.status(409).json({
        success: false,
        message: "The estimate has just changed, please refresh",
      });
    }

    notifyStorePriceResponse(order, action === "ACCEPT");

    return res.status(200).json({
      success: true,
      message:
        action === "ACCEPT"
          ? "Price accepted. Your order total is now fixed."
          : "Price declined. The store will send a new estimate.",
      order,
    });
  } catch (error) {
    return handleError(res, error, "Respond To Quote Error");
  }
};

// ===================== 7. STORE SIDE: GET STORE ORDERS =====================
// GET /api/order/store-orders?page&limit&status&search&storeId
const getStoreOrders = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { storeId, status } = req.query;
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    if (status && !ORDER_STATUSES.includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status" });
    }

    // ---------- shudhu nijer store er order ----------
    const ownedStoreIds = await getOwnedStoreIds(userId);
    const match = {};

    if (storeId) {
      if (!mongoose.isValidObjectId(storeId)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid store id" });
      }
      if (!ownedStoreIds.some((id) => String(id) === String(storeId))) {
        return res
          .status(403)
          .json({ success: false, message: "Not authorized for this store" });
      }
      match.storeId = storeId;
    } else {
      match.storeId = { $in: ownedStoreIds };
    }

    if (status) match.status = status;

    // ---------- search: order # / customer name, phone, email / delivery name, phone ----------
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      const UserModel = mongoose.model("User");
      const users = await UserModel.find({
        $or: [{ name: rx }, { phone: rx }, { email: rx }],
      })
        .select("_id")
        .limit(200)
        .lean();

      match.$or = [
        { orderNumber: rx },
        { "deliveryAddress.fullName": rx },
        { "deliveryAddress.phone": rx },
        ...(users.length ? [{ userId: { $in: users.map((u) => u._id) } }] : []),
      ];
    }

    const { pageNum, limitNum } = parsePagination(req.query);

    const [orders, totalOrders] = await Promise.all([
      OrderModel.find(match)
        .populate("userId", CUSTOMER_FIELDS)
        .sort({ createdAt: -1, _id: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      OrderModel.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      page: pageNum,
      limit: limitNum,
      totalOrders,
      totalPages: Math.ceil(totalOrders / limitNum),
      orders,
    });
  } catch (error) {
    return handleError(res, error, "Get Store Orders Error");
  }
};

// ===================== 8. STORE SIDE: GET SINGLE ORDER =====================
// GET /api/order/store-orders/:orderId
const getStoreOrderById = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order id" });
    }

    const order = await OrderModel.findById(orderId)
      .populate("userId", CUSTOMER_FIELDS)
      .lean();
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (!(await isStoreOwner(order.storeId, userId))) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized to view this order" });
    }

    return res.status(200).json({ success: true, order });
  } catch (error) {
    return handleError(res, error, "Get Store Order By Id Error");
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order id" });
    }

    const { status, note, expectedDeliveryDate } =
      updateOrderStatusSchema.parse(req.body);

    const existing = await OrderModel.findById(orderId)
      .select(
        "storeId status expectedDeliveryDate priceStatus paymentMethod paymentStatus deliveryEnabled",
      )
      .lean();
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (!(await isStoreOwner(existing.storeId, userId))) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to update this order",
      });
    }

    if (!ALLOWED_TRANSITIONS[existing.status].includes(status)) {
      return res.status(400).json({
        success: false,
        message:
          ALLOWED_TRANSITIONS[existing.status].length === 0
            ? `Order status cannot be changed once it is ${existing.status}`
            : `Cannot change status from ${existing.status} to ${status}`,
      });
    }

    // [PAYMENT] payment complete hole order cancel kora jabe na
    if (status === "CANCELLED" && existing.paymentStatus === "PAID") {
      return res.status(400).json({
        success: false,
        message:
          "Payment has been completed, so this order can no longer be cancelled",
      });
    }

    // [QUOTE] price estimate user accept na korle confirm kora jabe na
    if (
      status === "CONFIRMED" &&
      QUOTE_PENDING_STATUSES.includes(existing.priceStatus)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Price estimate must be accepted by the customer before confirming this order",
      });
    }

    // [PAYMENT] ONLINE order e payment complete na hole confirm kora jabe na
    if (
      status === "CONFIRMED" &&
      existing.paymentMethod === "ONLINE" &&
      existing.paymentStatus !== "PAID"
    ) {
      return res.status(400).json({
        success: false,
        message: "Customer has not completed the online payment yet",
      });
    }

    const extra = {};
    if (status === "CANCELLED") {
      extra.cancelReason = note || null;
      extra.cancelledBy = "STORE";
    }
    if (status === "DELIVERED") {
      // [PAYMENT] COD: delivery te taka pawa jay. ONLINE already paid
      if (existing.paymentMethod === "COD") {
        extra.paymentStatus = "PAID";
        extra.paidAt = new Date();
      }
    }
    if (status === "SHIPPED") {
      // [DELIVERY] delivery off store e date lagbe na. Baki store e shipped korar age date lagbe
      if (
        existing.deliveryEnabled !== false &&
        !expectedDeliveryDate &&
        !existing.expectedDeliveryDate
      ) {
        return res.status(400).json({
          success: false,
          message: "Expected delivery date is required before shipping",
          errors: [
            {
              field: "expectedDeliveryDate",
              message: "Expected delivery date is required before shipping",
            },
          ],
        });
      }
      if (expectedDeliveryDate) {
        extra.expectedDeliveryDate = toDeliveryDate(expectedDeliveryDate);
      }
    }

    // transition er atomic filter
    let filter = {};
    if (status === "CONFIRMED") {
      // [QUOTE] race guard: ei majhe user quote reject korle confirm hobe na
      filter = { priceStatus: { $nin: QUOTE_PENDING_STATUSES } };
      // [PAYMENT] ONLINE hole PAID thakte hobe (COD er jonno kono restriction nei)
      if (existing.paymentMethod === "ONLINE") {
        filter.paymentStatus = "PAID";
      }
    }
    if (status === "CANCELLED") {
      // [PAYMENT] race guard: ei majhe payment PAID hoye gele cancel hobe na
      filter = { paymentStatus: { $ne: "PAID" } };
    }

    const order = await transitionOrder({
      orderId,
      filter,
      status,
      note,
      userId,
      extra,
      populateUser: true, // frontend merge e customer jeno na hariye jay
    });

    if (!order) {
      return res.status(409).json({
        success: false,
        message: "Order status has just changed, please refresh",
      });
    }

    notifyUserOrderStatus(order);

    if (status === "CANCELLED") {
      await restoreOrderStock(order, userId);
    }

    return res.status(200).json({
      success: true,
      message: "Order status updated",
      order,
    });
  } catch (error) {
    return handleError(res, error, "Update Order Status Error");
  }
};

// ===================== 10. SET / EDIT EXPECTED DELIVERY DATE (store side) =====================
// PATCH /api/order/store-orders/:orderId/delivery-date   body: { expectedDeliveryDate: "YYYY-MM-DD" }
const updateDeliveryDate = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order id" });
    }

    const { expectedDeliveryDate } = updateDeliveryDateSchema.parse(req.body);

    const existing = await OrderModel.findById(orderId)
      .select("storeId status")
      .lean();
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (!(await isStoreOwner(existing.storeId, userId))) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to update this order",
      });
    }

    if (!DELIVERY_DATE_EDITABLE.includes(existing.status)) {
      return res.status(400).json({
        success: false,
        message: `Delivery date cannot be changed once order is ${existing.status}`,
      });
    }

    // status filter diye atomic: ei majhe DELIVERED/CANCELLED hoye gele update hobe na
    const order = await OrderModel.findOneAndUpdate(
      { _id: orderId, status: { $in: DELIVERY_DATE_EDITABLE } },
      { $set: { expectedDeliveryDate: toDeliveryDate(expectedDeliveryDate) } },
      { new: true },
    )
      .populate("userId", CUSTOMER_FIELDS)
      .lean();

    if (!order) {
      return res.status(409).json({
        success: false,
        message: "Order status has just changed, please refresh",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Expected delivery date updated",
      order,
    });
  } catch (error) {
    return handleError(res, error, "Update Delivery Date Error");
  }
};

// ===================== 11. STORE: SEND PRICE ESTIMATE =====================
// PATCH /api/order/store-orders/:orderId/quote
// body: { items: [{ itemId, unitPrice }], note? }
const submitQuote = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order id" });
    }

    const { items: quoteItems, note } = submitQuoteSchema.parse(req.body);

    const existing = await OrderModel.findById(orderId)
      .select("storeId status priceStatus items gstMode shippingCharge")
      .lean();
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (!(await isStoreOwner(existing.storeId, userId))) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to update this order",
      });
    }

    if (existing.status !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: `Price cannot be set once order is ${existing.status}`,
      });
    }

    if (!QUOTE_PENDING_STATUSES.includes(existing.priceStatus)) {
      return res.status(400).json({
        success: false,
        message: "This order does not need a price estimate",
      });
    }

    // jei item gulo-r price nai, shob gulo-r price lagbe (extra / duplicate / missing noy)
    const neededIds = new Set(
      existing.items.filter((i) => i.priceOnRequest).map((i) => String(i._id)),
    );
    const sentIds = quoteItems.map((q) => String(q.itemId));
    if (
      new Set(sentIds).size !== sentIds.length ||
      sentIds.length !== neededIds.size ||
      !sentIds.every((id) => neededIds.has(id))
    ) {
      return res.status(400).json({
        success: false,
        message: "Please enter a price for every item that needs an estimate",
      });
    }

    const priceMap = new Map(
      quoteItems.map((q) => [String(q.itemId), round2(q.unitPrice)]),
    );

    // [GST] estimate total e GST soho (accept korle ei total-i final hobe)
    const simulated = existing.items.map((i) => {
      const unit = i.priceOnRequest
        ? priceMap.get(String(i._id))
        : i.offerPrice;
      return applyGstToItem(
        { ...i, offerPrice: unit, lineTotal: round2(unit * i.quantity) },
        existing.gstMode,
      );
    });
    const total = round2(
      computeTotals(simulated).totalAmount +
        Number(existing.shippingCharge || 0),
    );

    const quotedAt = new Date();

    // atomic: ei majhe cancel / confirm hoye gele update hobe na
    const order = await OrderModel.findOneAndUpdate(
      {
        _id: orderId,
        status: "PENDING",
        priceStatus: { $in: QUOTE_PENDING_STATUSES },
      },
      {
        $set: {
          priceStatus: "QUOTED",
          quote: {
            items: quoteItems.map((q) => ({
              itemId: q.itemId,
              unitPrice: priceMap.get(String(q.itemId)),
            })),
            total,
            note: note || null,
            quotedBy: userId,
            quotedAt,
          },
        },
        $push: {
          priceHistory: {
            action: "QUOTED",
            byRole: "STORE",
            by: userId,
            total,
            note: note || null,
            at: quotedAt,
          },
        },
      },
      { new: true },
    )
      .populate("userId", CUSTOMER_FIELDS)
      .lean();

    if (!order) {
      return res.status(409).json({
        success: false,
        message: "Order status has just changed, please refresh",
      });
    }

    notifyUserPriceQuote(order);

    return res.status(200).json({
      success: true,
      message: "Price estimate sent to the customer",
      order,
    });
  } catch (error) {
    return handleError(res, error, "Submit Quote Error");
  }
};

const previewStore = async ({
  userId,
  storeId,
  lines,
  deliveryAddress,
  paymentMethod,
}) => {
  const [store, policy] = await Promise.all([
    StoreModel.findById(storeId).select("storeName storeUniqueId").lean(),
    getStorePolicy(storeId),
  ]);

  const base = {
    storeId,
    storeName: store?.storeName || null,
    storeUniqueId: store?.storeUniqueId || null,
    paymentMode: policy.paymentMode,
    codAvailable: policy.codAllowed,
    onlineAvailable: policy.onlineAllowed,
    deliveryEnabled: policy.hasDelivery,
  };

  const result = await attemptStoreCheckout({
    userId,
    storeId,
    lines,
    deliveryAddress,
    note: null,
    paymentMethod,
    dryRun: true,
  });

  if (!result.success) {
    return {
      ...base,
      ok: false,
      code: result.code || "BLOCKED",
      message: result.message || "Some items are not available",
      outOfStockLines: result.outOfStockLines,
      itemsTotal: 0,
      shippingCharge: 0,
      grandTotal: 0,
      delivery: null,
    };
  }

  const p = result.preview;
  return {
    ...base,
    ok: true,
    paymentMethod: p.paymentMethod,
    paymentOff: p.paymentOff,
    priceStatus: p.priceStatus,
    totalItems: p.totalItems,
    itemsTotal: p.itemsTotal,
    shippingCharge: p.shippingCharge,
    grandTotal: p.grandTotal,
    delivery: p.delivery,
  };
};

const checkoutPreview = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { cartId, storeIds, productId, variantId, quantity } = req.body || {};
    const paymentMethod = req.body?.paymentMethod === "COD" ? "COD" : "ONLINE";

    const addr = req.body?.deliveryAddress || {};
    const deliveryAddress = {
      pincode: String(addr.pincode ?? req.body?.pincode ?? "").trim(),
      state: addr.state ?? req.body?.state ?? "",
      country:
        String(addr.country ?? req.body?.country ?? "India").trim() || "India",
    };

    // ---------- store wise lines (checkout / buyNow er moto) ----------
    const groups = new Map();

    if (cartId) {
      if (!mongoose.isValidObjectId(cartId)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid cart id" });
      }
      const cart = await CartModel.findOne({ _id: cartId, userId });
      if (!cart) {
        return res
          .status(404)
          .json({ success: false, message: "Cart not found" });
      }

      let items = cart.items;
      if (Array.isArray(storeIds) && storeIds.length > 0) {
        const set = new Set(storeIds.map(String));
        items = items.filter((i) => set.has(String(i.storeId)));
      }
      for (const item of items) {
        const key = String(item.storeId);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
        });
      }
    } else if (productId) {
      if (!mongoose.isValidObjectId(productId)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid product id" });
      }
      const product = await ProductModel.findOne({
        _id: productId,
        isActive: true,
        isVerified: true,
      })
        .select("storeId")
        .lean();
      if (!product) {
        return res
          .status(404)
          .json({ success: false, message: "Product not available" });
      }
      groups.set(String(product.storeId), [
        {
          productId,
          variantId: cleanVariantId(variantId),
          quantity: Math.max(1, Number(quantity) || 1),
        },
      ]);
    } else {
      return res.status(400).json({
        success: false,
        message: "cartId or productId is required",
      });
    }

    if (groups.size === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No items to checkout" });
    }

    const stores = [];
    for (const [storeId, lines] of groups.entries()) {
      stores.push(
        await previewStore({
          userId,
          storeId,
          lines,
          deliveryAddress,
          paymentMethod,
        }),
      );
    }

    const okStores = stores.filter((s) => s.ok);
    const sum = (key) =>
      round2(okStores.reduce((total, s) => total + Number(s[key] || 0), 0));

    return res.status(200).json({
      success: true,
      paymentMethod,
      itemsTotal: sum("itemsTotal"),
      totalShipping: sum("shippingCharge"),
      grandTotal: sum("grandTotal"),
      // kono store e COD na thakle pura checkout e COD dekhano jabe na
      codAvailable: stores.every((s) => s.codAvailable),
      // shob store e payment OFF hole payment step-i lagbe na
      paymentRequired: stores.some((s) => s.onlineAvailable),
      stores,
    });
  } catch (error) {
    return handleError(res, error, "Checkout Preview Error");
  }
};

module.exports = {
  checkout,
  buyNow,
  getMyOrders,
  getMyOrdersByStore,
  getOrdersGroupedByStore,
  getMyOrderById,
  cancelMyOrder,
  respondToQuote,
  getStoreOrders,
  getStoreOrderById,
  updateOrderStatus,
  updateDeliveryDate,
  submitQuote,
  restoreOrderStock,
  checkoutPreview,
};
