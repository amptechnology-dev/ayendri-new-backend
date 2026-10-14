const mongoose = require("mongoose");
const ProductModel = require("../model/product.model.js");
const StockLogModel = require("../model/stockLog.model.js");
const {
  flattenStockUnits,
  computeLowStock,
  logStockChange,
  notifyLowStock,
} = require("../helper/stockManager.js");

// ---------- GET /api/stock/overview ----------
// One row per stock-unit (simple product / flat variant / color / sizeVariant)
// Full details soho: product image, name, code, ar variant-er প্রতিটা attribute
// (color, size, weight, height) alada "meta" object-e — frontend chip banate parবে.
const getStockOverview = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const { search = "", lowStockOnly, page = 1, limit = 20 } = req.query;

    const match = { userId: new mongoose.Types.ObjectId(userId) };
    if (search) {
      match.$or = [
        { name: { $regex: search, $options: "i" } },
        { productCode: { $regex: search, $options: "i" } },
      ];
    }
    if (lowStockOnly === "true") match.hasLowStock = true;

    const products = await ProductModel.find(match)
      .select(
        "name productCode images variants mrp offerPrice openingStock currentStock lowStockThreshold hasLowStock hasVariants hasColor unit",
      )
      .sort({ createdAt: -1 })
      .lean();

    const rows = [];
    products.forEach((p) => {
      flattenStockUnits(p).forEach((u) => {
        rows.push({
          productId: p._id,
          productName: p.name,
          productCode: p.productCode,
          unit: p.unit,
          image: p.images?.[0] || null,
          variantId: u.variantId,
          sizeVariantId: u.sizeVariantId,
          variantLabel: u.label,
          variantMeta: u.meta, // { color?, size?, weight?, height? }
          currentStock: u.currentStock,
          lowStockThreshold: u.lowStockThreshold,
          isLow: u.lowStockThreshold > 0 && u.currentStock <= u.lowStockThreshold,
        });
      });
    });

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.max(parseInt(limit) || 20, 1);
    const start = (pageNum - 1) * limitNum;

    return res.status(200).json({
      success: true,
      page: pageNum,
      limit: limitNum,
      totalRows: rows.length,
      totalPages: Math.ceil(rows.length / limitNum),
      rows: rows.slice(start, start + limitNum),
    });
  } catch (error) {
    console.error("Get Stock Overview Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ---------- PATCH /api/stock/update ----------
// body: { productId, variantId?, sizeVariantId?, type: "ADD"|"REDUCE", quantity, note? }
// NOTE: "SET" option remove kora holo — sudhu ADD / REDUCE lagবে.
const updateStock = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const { productId, variantId, sizeVariantId, type, quantity, note } = req.body;

    if (!productId || !mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ success: false, message: "Valid productId is required" });
    }
    if (!["ADD", "REDUCE"].includes(type)) {
      return res.status(400).json({ success: false, message: "type must be ADD or REDUCE" });
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: "quantity must be a number greater than 0" });
    }

    const product = await ProductModel.findOne({ _id: productId, userId });
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    let target = null;
    let label = "Default";

    if (!variantId) {
      target = product;
    } else {
      const variant = product.variants.id(variantId);
      if (!variant) {
        return res.status(404).json({ success: false, message: "Variant not found" });
      }
      if (sizeVariantId) {
        const sizeVariant = variant.sizeVariants.id(sizeVariantId);
        if (!sizeVariant) {
          return res.status(404).json({ success: false, message: "Size variant not found" });
        }
        target = sizeVariant;
        label =
          [variant.color, sizeVariant.size, sizeVariant.weight, sizeVariant.height]
            .filter(Boolean)
            .join(" / ") || "Variant";
      } else {
        target = variant;
        label =
          variant.color ||
          [variant.size, variant.weight, variant.height].filter(Boolean).join(" / ") ||
          "Variant";
      }
    }

    const previousStock = Number(target.currentStock || 0);
    let newStock = previousStock;
    let logType = "IN";
    let reason = "MANUAL_ADD";

    if (type === "ADD") {
      newStock = previousStock + qty;
      logType = "IN";
      reason = "MANUAL_ADD";
    } else {
      // REDUCE
      newStock = Math.max(0, previousStock - qty);
      logType = "OUT";
      reason = "MANUAL_REDUCE";
    }

    target.currentStock = newStock;

    const { hasLowStock, lowUnits } = computeLowStock(product);
    const wasLow = product.hasLowStock;
    product.hasLowStock = hasLowStock;

    await product.save();

    await logStockChange({
      productId: product._id,
      storeId: product.storeId,
      userId,
      variantId: variantId || null,
      sizeVariantId: sizeVariantId || null,
      productName: product.name,
      variantLabel: label,
      type: logType,
      reason,
      note,
      previousStock,
      newStock,
    });

    if (hasLowStock && !wasLow) {
      await notifyLowStock({ product, lowUnits, userId, storeId: product.storeId });
    }

    return res.status(200).json({
      success: true,
      message: "Stock updated successfully",
      data: {
        productId: product._id,
        variantId: variantId || null,
        sizeVariantId: sizeVariantId || null,
        previousStock,
        newStock,
      },
    });
  } catch (error) {
    console.error("Update Stock Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ---------- GET /api/stock/logs/:productId ----------
const getStockLogs = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ success: false, message: "Invalid productId" });
    }
    const logs = await StockLogModel.find({ productId }).sort({ createdAt: -1 }).limit(200).lean();
    return res.status(200).json({ success: true, count: logs.length, logs });
  } catch (error) {
    console.error("Get Stock Logs Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ---------- GET /api/stock/low-stock ----------
const getLowStockProducts = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const products = await ProductModel.find({ userId, hasLowStock: true })
      .select("name productCode images variants currentStock lowStockThreshold unit")
      .lean();

    const rows = [];
    products.forEach((p) => {
      flattenStockUnits(p)
        .filter((u) => u.lowStockThreshold > 0 && u.currentStock <= u.lowStockThreshold)
        .forEach((u) =>
          rows.push({
            productId: p._id,
            productName: p.name,
            productCode: p.productCode,
            unit: p.unit,
            image: p.images?.[0] || null,
            variantId: u.variantId,
            sizeVariantId: u.sizeVariantId,
            variantLabel: u.label,
            variantMeta: u.meta,
            currentStock: u.currentStock,
            lowStockThreshold: u.lowStockThreshold,
          }),
        );
    });

    return res.status(200).json({ success: true, count: rows.length, rows });
  } catch (error) {
    console.error("Get Low Stock Products Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = { getStockOverview, updateStock, getStockLogs, getLowStockProducts };