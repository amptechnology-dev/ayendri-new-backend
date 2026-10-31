const mongoose = require("mongoose");
const { getNextSequence } = require("../helper/counter.js");

const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
];

const PAYMENT_METHODS = ["COD", "ONLINE"];
const PAYMENT_STATUSES = ["PENDING", "INITIATED", "PAID", "FAILED", "REFUNDED"];

// order place er somoy je address theke pickup hobe tar snapshot
const pickupAddressSchema = new mongoose.Schema(
  {
    contactName: String,
    phone: String,
    email: String,
    addressLine: String,
    area: String,
    city: String,
    state: String,
    pincode: String,
    country: { type: String, default: "India" },
  },
  { _id: false },
);

const gstRatesSchema = new mongoose.Schema(
  {
    cgst: { type: Number, default: null },
    sgst: { type: Number, default: null },
    igst: { type: Number, default: null },
  },
  { _id: false },
);

const orderItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: true,
  },
  variantId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  name: { type: String, required: true },
  productCode: { type: String },
  image: { type: String, default: null },
  unit: { type: String },
  color: { type: String, default: null },
  size: { type: String, default: null },
  weight: { type: String, default: null },
  height: { type: String, default: null },
  // price-on-request item e checkout-er somoy null, user quote accept korle fill hoy
  mrp: { type: Number, default: null, min: 0 },
  offerPrice: { type: Number, default: null, min: 0 },
  quantity: { type: Number, required: true, min: 1 },
  lineTotal: { type: Number, default: null, min: 0 },
  priceOnRequest: { type: Boolean, default: false },
  gstRates: { type: gstRatesSchema, default: null }, // product e configured rate
  gstInclusive: { type: Boolean, default: false },
  hsnCode: { type: String, default: null },
  taxableAmount: { type: Number, default: null },
  cgstAmount: { type: Number, default: 0 },
  sgstAmount: { type: Number, default: 0 },
  igstAmount: { type: Number, default: 0 },
  gstAmount: { type: Number, default: 0 },
  lineTotalWithGst: { type: Number, default: null },
  productType: {
    type: String,
    enum: ["PRODUCT", "SERVICE"],
    default: "PRODUCT",
  },
  isReturnable: { type: Boolean, default: false },
  returnDays: { type: Number, default: null },
  isReplaceable: { type: Boolean, default: false },
  replaceDays: { type: Number, default: null },
  isRefundable: { type: Boolean, default: false },
  refundDays: { type: Number, default: null },
});

const deliveryAddressSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    addressLine: { type: String, required: true, trim: true },
    area: { type: String, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    pincode: { type: String, required: true, trim: true },
    country: { type: String, default: "India", trim: true },
  },
  { _id: false },
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: ORDER_STATUSES, required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    note: { type: String, default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

// store er pathano estimated price
const quoteSchema = new mongoose.Schema(
  {
    items: [
      new mongoose.Schema(
        {
          itemId: { type: mongoose.Schema.Types.ObjectId, required: true },
          unitPrice: { type: Number, required: true, min: 0 },
        },
        { _id: false },
      ),
    ],
    total: { type: Number, min: 0 },
    note: { type: String, default: null },
    quotedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    quotedAt: { type: Date },
  },
  { _id: false },
);

const priceHistorySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: ["QUOTED", "ACCEPTED", "REJECTED"],
      required: true,
    },
    byRole: { type: String, enum: ["STORE", "USER"] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    total: { type: Number },
    note: { type: String, default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

// order place er somoy store er delivery setting onujayi estimate + shipping charge
const deliveryInfoSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: ["LOCAL", "NATIONAL", "INTERNATIONAL"] },
    distanceKm: { type: Number, default: null },
    minMinutes: { type: Number },
    maxMinutes: { type: Number },
    minDays: { type: Number },
    maxDays: { type: Number },
    etaLabel: { type: String, default: null }, // "Delivery in 45 minutes"
    estimatedMinDate: { type: Date },
    estimatedMaxDate: { type: Date },
    estimatedMaxAt: { type: Date },
    source: { type: String, enum: ["MANUAL", "SHIPROCKET"], default: "MANUAL" },
    courierId: { type: Number, default: null },
    courierName: { type: String, default: null },
    courierRate: { type: Number, default: null }, // courier ke asol khoroch
    courierEtaDays: { type: Number, default: null }, // courier er nijer ETA (din)

    // [নতুন] store je courier / speed bechechhe
    courierMode: { type: String, enum: ["AIR", "SURFACE"], default: null },
    requestedMaxDays: { type: Number, default: null }, // "koto diner moddhe chai"
    requestedMode: {
      type: String,
      enum: ["ANY", "AIR", "SURFACE"],
      default: "ANY",
    },
    courierSelectedBy: {
      type: String,
      enum: ["AUTO", "STORE"],
      default: "AUTO",
    },

    chargeableWeightKg: { type: Number, default: null },
    shippingCharge: { type: Number, default: 0 }, // customer ke je charge
    baseShippingCharge: { type: Number, default: null }, // order value rule er age
    shippingNote: { type: String, default: null }, // "Within 5 km" / "Free delivery on orders of ₹500 or more"
    country: { type: String, default: null },
    pincode: { type: String, default: null },
  },
  { _id: false },
);

const shipmentEventSchema = new mongoose.Schema(
  {
    status: { type: String, default: null },
    activity: { type: String, default: null },
    location: { type: String, default: null },
    at: { type: Date, default: null },
  },
  { _id: false },
);

// [SHIPROCKET] courier shipment er info
const shipmentSchema = new mongoose.Schema(
  {
    provider: { type: String, default: "SHIPROCKET" },
    shiprocketOrderId: { type: Number, default: null },
    shipmentId: { type: Number, default: null },
    awb: { type: String, default: null },
    courierId: { type: Number, default: null },
    courierName: { type: String, default: null },
    trackingUrl: { type: String, default: null },
    status: { type: String, default: null },

    pickupRequestedAt: { type: Date, default: null },
    pickupScheduledDate: { type: Date, default: null }, // courier kabe pickup nebe
    pickupTokenNumber: { type: String, default: null },
    assignedAt: { type: Date, default: null },

    etd: { type: Date, default: null }, // courier er estimated delivery date
    etdSource: {
      type: String,
      enum: ["ESTIMATE", "COURIER"],
      default: "ESTIMATE",
    },
    appliedWeight: { type: Number, default: null }, // Shiprocket je weight e charge korlo
    courierSwitched: { type: Boolean, default: false }, // quoted courier na pele auto-assign hole true

    events: { type: [shipmentEventSchema], default: [] }, // tracking history (webhook)
    lastEventAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// order place er somoy ki weight/size dhore shipping charge hishab hoyechilo (snapshot)
const parcelItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    name: { type: String, default: null },
    quantity: { type: Number, default: 1 },
    unitWeightKg: { type: Number, default: 0 },
    lineWeightKg: { type: Number, default: 0 },
    length: { type: Number, default: 0 }, // per unit, cm
    breadth: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    usedDefaultWeight: { type: Boolean, default: false },
    usedDefaultDims: { type: Boolean, default: false },
  },
  { _id: false },
);

const parcelSchema = new mongoose.Schema(
  {
    length: { type: Number, default: 0 },
    breadth: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    weight: { type: Number, default: 0 }, // dead weight kg
    volumetricWeight: { type: Number, default: 0 },
    chargeableWeight: { type: Number, default: 0 },
    dimsComplete: { type: Boolean, default: false },
    weightComplete: { type: Boolean, default: false },
    items: { type: [parcelItemSchema], default: [] },
  },
  { _id: false },
);

// PayU payment attempt history (ekta order e multiple retry hote pare)
const paymentAttemptSchema = new mongoose.Schema(
  {
    txnid: { type: String, required: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ["INITIATED", "SUCCESS", "FAILED"],
      default: "INITIATED",
    },
    mihpayid: { type: String, default: null }, // PayU payment id
    mode: { type: String, default: null }, // UPI / CC / NB
    bankRefNum: { type: String, default: null },
    errorMessage: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { _id: false },
);

const orderPickupSchema = new mongoose.Schema(
  {
    contactName: String,
    phone: String,
    email: String,
    addressLine: String,
    area: String,
    city: String,
    state: String,
    pincode: String,
    country: { type: String, default: "India" },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, unique: true },

    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Cart",
      default: null,
    },
    checkoutId: { type: mongoose.Schema.Types.ObjectId, default: null },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },

    storeName: { type: String },
    storeUniqueId: { type: String },

    items: {
      type: [orderItemSchema],
      validate: [(v) => v.length > 0, "Order must have at least one item"],
    },

    totalItems: { type: Number, required: true, min: 1 },
    totalMrp: { type: Number, required: true, min: 0 },
    discount: { type: Number, required: true, min: 0 },
    gstMode: { type: String, enum: ["INTRA", "INTER"], default: "INTRA" },
    subtotal: { type: Number, default: 0, min: 0 }, // GST er age item total
    totalTaxable: { type: Number, default: 0, min: 0 },
    totalCgst: { type: Number, default: 0, min: 0 },
    totalSgst: { type: Number, default: 0, min: 0 },
    totalIgst: { type: Number, default: 0, min: 0 },
    totalGst: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },

    deliveryAddress: { type: deliveryAddressSchema, required: true },
    note: { type: String, default: null },
    bookingDate: { type: Date, default: null },
    hasService: { type: Boolean, default: false },
    bookingSlotProductIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
    },
    refundedAmount: { type: Number, default: 0, min: 0 },
    expectedDeliveryDate: { type: Date, default: null },
    deliveryInfo: { type: deliveryInfoSchema, default: null },
    shippingCharge: { type: Number, default: 0, min: 0 },
    itemsTotal: { type: Number, default: null, min: 0 },
    deliveryEnabled: { type: Boolean, default: true },
    paymentOff: { type: Boolean, default: false },
    shipment: { type: shipmentSchema, default: null },
    parcel: { type: parcelSchema, default: null },
    pickupAddress: { type: pickupAddressSchema, default: null, select: false },
    // ---------- payment ----------
    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: "COD" },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "PENDING",
    },
    paymentAttempts: { type: [paymentAttemptSchema], default: [] },
    paidAt: { type: Date, default: null },
    // ONLINE unpaid order auto-cancel er jonno
    paymentExpiresAt: { type: Date, default: null },

    status: { type: String, enum: ORDER_STATUSES, default: "PENDING" },
    statusHistory: [statusHistorySchema],

    // price-on-request flow
    priceStatus: {
      type: String,
      enum: ["NOT_REQUIRED", "AWAITING_QUOTE", "QUOTED", "CONFIRMED"],
      default: "NOT_REQUIRED",
    },
    quote: { type: quoteSchema, default: null },
    priceHistory: { type: [priceHistorySchema], default: [] },

    cancelReason: { type: String, default: null },
    cancelledBy: { type: String, enum: ["USER", "STORE"], default: null },
  },
  { timestamps: true },
);

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ userId: 1, storeId: 1, createdAt: -1 });
orderSchema.index({ storeId: 1, status: 1, createdAt: -1 });
orderSchema.index({ storeId: 1, priceStatus: 1, createdAt: -1 });
orderSchema.index({ checkoutId: 1 });
orderSchema.index({ "shipment.awb": 1 });
// payment lookup (callback e txnid diye order khuje pawa)
orderSchema.index({ "paymentAttempts.txnid": 1 });
// expire cron query
orderSchema.index({ paymentStatus: 1, paymentExpiresAt: 1 });

orderSchema.pre("save", async function () {
  if (this.isNew && !this.orderNumber) {
    const seq = await getNextSequence("orderNumber");
    this.orderNumber = `ORD${String(seq).padStart(6, "0")}`;
  }
});

const OrderModel = mongoose.model("Order", orderSchema);

module.exports = OrderModel;
