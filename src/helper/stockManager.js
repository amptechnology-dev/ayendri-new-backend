const mongoose = require("mongoose");
const StockLogModel = require("../model/stockLog.model.js");
const ProductModel = require("../model/product.model.js");

// Tries to use your existing Notification model. If the path or the
// schema shape is different in your project, adjust the require path
// and the fields passed into NotificationModel.create() below.
let NotificationModel = null;
try {
  NotificationModel = require("../model/notification.model.js");
} catch (e) {
  NotificationModel = null;
}

const flattenStockUnits = (product) => {
  const units = [];
  const variants = Array.isArray(product.variants) ? product.variants : [];

  const buildMeta = ({ color, size, weight, height } = {}) => {
    const meta = {};
    if (color) meta.color = color;
    if (size) meta.size = size;
    if (weight) meta.weight = weight;
    if (height) meta.height = height;
    return meta;
  };

  if (variants.length === 0) {
    units.push({
      variantId: null,
      sizeVariantId: null,
      label: "Default",
      meta: {},
      currentStock: Number(product.currentStock || 0),
      lowStockThreshold: Number(product.lowStockThreshold || 0),
    });
    return units;
  }

  variants.forEach((v) => {
    const sizeVariants = Array.isArray(v.sizeVariants) ? v.sizeVariants : [];
    if (sizeVariants.length > 0) {
      sizeVariants.forEach((sv) => {
        const meta = buildMeta({
          color: v.color,
          size: sv.size,
          weight: sv.weight,
          height: sv.height,
        });
        const label =
          [v.color, sv.size, sv.weight, sv.height]
            .filter(Boolean)
            .join(" / ") || "Variant";
        units.push({
          variantId: v._id,
          sizeVariantId: sv._id,
          label,
          meta,
          currentStock: Number(sv.currentStock || 0),
          lowStockThreshold: Number(sv.lowStockThreshold || 0),
        });
      });
    } else {
      const meta = buildMeta({
        color: v.color,
        size: v.size,
        weight: v.weight,
        height: v.height,
      });
      const label =
        v.color ||
        [v.size, v.weight, v.height].filter(Boolean).join(" / ") ||
        "Variant";
      units.push({
        variantId: v._id,
        sizeVariantId: null,
        label,
        meta,
        currentStock: Number(v.currentStock || 0),
        lowStockThreshold: Number(v.lowStockThreshold || 0),
      });
    }
  });

  return units;
};

// threshold 0 => alert off for that unit
const isUnitLow = (unit) =>
  unit.lowStockThreshold > 0 && unit.currentStock <= unit.lowStockThreshold;

const computeLowStock = (product) => {
  const units = flattenStockUnits(product);
  const lowUnits = units.filter(isUnitLow);
  return { hasLowStock: lowUnits.length > 0, lowUnits };
};

// ---------- Stock log ----------
const logStockChange = async ({
  productId,
  storeId,
  userId,
  variantId = null,
  sizeVariantId = null,
  productName,
  variantLabel = "Default",
  type,
  reason = "OTHER",
  note = "",
  previousStock,
  newStock,
}) => {
  try {
    await StockLogModel.create({
      productId,
      storeId,
      userId,
      variantId,
      sizeVariantId,
      productName,
      variantLabel,
      type,
      reason,
      note,
      quantityChanged: newStock - previousStock,
      previousStock,
      newStock,
    });
  } catch (err) {
    console.error("Stock log create failed:", err.message);
  }
};

// ---------- Low stock notification ----------
// Adjust field names (userId/storeId/title/message/type/meta) to match
// your real Notification schema.
const notifyLowStock = async ({ product, lowUnits, userId, storeId }) => {
  if (!NotificationModel || !lowUnits.length) return;
  try {
    const summary = lowUnits
      .slice(0, 3)
      .map((u) => `${u.label} (${u.currentStock} left)`)
      .join(", ");

    await NotificationModel.create({
      userId,
      storeId,
      title: "Low stock alert",
      message: `${product.name}: ${summary}${lowUnits.length > 3 ? "…" : ""}`,
      type: "LOW_STOCK",
      meta: {
        productId: product._id,
        productCode: product.productCode,
        lowUnits: lowUnits.map((u) => ({
          variantId: u.variantId,
          sizeVariantId: u.sizeVariantId,
          label: u.label,
          currentStock: u.currentStock,
          lowStockThreshold: u.lowStockThreshold,
        })),
      },
      isRead: false,
    });
  } catch (err) {
    console.error("Low stock notification failed:", err.message);
  }
};

const locateStockUnit = (product, unitId) => {
  if (!unitId) {
    return {
      variantId: null,
      sizeVariantId: null,
      currentStock: Number(product.currentStock || 0),
      lowStockThreshold: Number(product.lowStockThreshold || 0),
    };
  }

  const variants = Array.isArray(product.variants) ? product.variants : [];

  // 1) age nested sizeVariants-er moddhe khonjo (color + size combo)
  for (const v of variants) {
    const sizeVariants = Array.isArray(v.sizeVariants) ? v.sizeVariants : [];
    const sv = sizeVariants.find((s) => String(s._id) === String(unitId));
    if (sv) {
      return {
        variantId: v._id,
        sizeVariantId: sv._id,
        currentStock: Number(sv.currentStock || 0),
        lowStockThreshold: Number(sv.lowStockThreshold || 0),
      };
    }
  }

  // 2) top-level flat/color variant (no nested sizes)
  const v = variants.find((v) => String(v._id) === String(unitId));
  if (v) {
    return {
      variantId: v._id,
      sizeVariantId: null,
      currentStock: Number(v.currentStock || 0),
      lowStockThreshold: Number(v.lowStockThreshold || 0),
    };
  }

  return null; // id-r sathe kono unit match kore nai — invalid variantId
};

// ---------- ATOMIC stock decrement for one order line ----------
// MongoDB-level condition (currentStock >= quantity) diye atomically check + decrement
// kore, tai duijon user ekshathe order dile race condition hoy na — ekjon succeed
// korbe, arekjon INSUFFICIENT_STOCK pabe.
const decrementStockForLine = async ({
  productId,
  variantId,
  sizeVariantId,
  quantity,
}) => {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { success: false, reason: "INVALID_QUANTITY" };
  }

  let updated;

  if (!variantId) {
    updated = await ProductModel.findOneAndUpdate(
      { _id: productId, currentStock: { $gte: qty } },
      { $inc: { currentStock: -qty } },
      { new: true },
    );
  } else if (!sizeVariantId) {
    updated = await ProductModel.findOneAndUpdate(
      {
        _id: productId,
        variants: {
          $elemMatch: { _id: variantId, currentStock: { $gte: qty } },
        },
      },
      { $inc: { "variants.$.currentStock": -qty } },
      { new: true },
    );
  } else {
    // [FIX] stock condition query filter e rakha hoyeche ($elemMatch),
    // jate stock kom hole document match-i na kore -> INSUFFICIENT_STOCK
    updated = await ProductModel.findOneAndUpdate(
      {
        _id: productId,
        variants: {
          $elemMatch: {
            _id: variantId,
            sizeVariants: {
              $elemMatch: { _id: sizeVariantId, currentStock: { $gte: qty } },
            },
          },
        },
      },
      { $inc: { "variants.$[v].sizeVariants.$[sv].currentStock": -qty } },
      {
        new: true,
        arrayFilters: [{ "v._id": variantId }, { "sv._id": sizeVariantId }],
      },
    );
  }

  if (!updated) {
    return { success: false, reason: "INSUFFICIENT_STOCK" };
  }

  const { hasLowStock } = computeLowStock(updated);
  if (updated.hasLowStock !== hasLowStock) {
    updated.hasLowStock = hasLowStock;
    await updated.save();
  }

  return { success: true, product: updated };
};

// ---------- Restore stock (order cancel / rollback-e use hoy) ----------
const restoreStockForLine = async ({
  productId,
  variantId,
  sizeVariantId,
  quantity,
}) => {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) return null;

  let updated;

  if (!variantId) {
    updated = await ProductModel.findOneAndUpdate(
      { _id: productId },
      { $inc: { currentStock: qty } },
      { new: true },
    );
  } else if (!sizeVariantId) {
    updated = await ProductModel.findOneAndUpdate(
      { _id: productId, "variants._id": variantId },
      { $inc: { "variants.$.currentStock": qty } },
      { new: true },
    );
  } else {
    updated = await ProductModel.findOneAndUpdate(
      { _id: productId, "variants._id": variantId },
      { $inc: { "variants.$[v].sizeVariants.$[sv].currentStock": qty } },
      {
        new: true,
        arrayFilters: [{ "v._id": variantId }, { "sv._id": sizeVariantId }],
      },
    );
  }

  if (updated) {
    const { hasLowStock } = computeLowStock(updated);
    if (updated.hasLowStock !== hasLowStock) {
      updated.hasLowStock = hasLowStock;
      await updated.save();
    }
  }

  return updated;
};

// ---------- Find one flattened unit's currentStock (log-e previousStock-er jonno) ----------
const findUnitStock = (product, variantId, sizeVariantId) => {
  const units = flattenStockUnits(product);
  const match = units.find(
    (u) =>
      String(u.variantId || "") === String(variantId || "") &&
      String(u.sizeVariantId || "") === String(sizeVariantId || ""),
  );
  return match ? match.currentStock : null;
};

module.exports = {
  flattenStockUnits,
  computeLowStock,
  logStockChange,
  notifyLowStock,
  locateStockUnit,
  decrementStockForLine,
  restoreStockForLine,
  findUnitStock,
};