const mongoose = require("mongoose");
const StoreModel = require("../model/store.model.js");
const StoreDeliveryModel = require("../model/storeDelivery.model.js");
const PincodeModel = require("../model/pincode.model.js");
const { saveDeliverySettingsSchema } = require("../schema/delivery.schema.js");
const {
  isValidPincode,
  toMinutes,
  findPincodesInRadius,
  countPincodesInRadius,
  checkStoreDelivery,
  finalizeShipping,
} = require("../helper/deliveryEstimate.js");
const {
  ensurePickupLocation,
  PickupSetupError,
} = require("../helper/pickupLocation.js");
const {
  AVAILABLE_STORE_FILTER,
  sendStoreUnavailable,
} = require("../helper/storeAvailability.js");
const UserModel = require("../model/user.model.js");
const crypto = require("crypto");
const OrderModel = require("../model/order.model.js");
const ProductModel = require("../model/product.model.js");
const shiprocket = require("../helper/shiprocket.js");
const { notifyUserOrderStatus } = require("../helper/notification.helper.js");
const { getStorePolicy } = require("../helper/storePolicy.js");

const parseDate = (v) => {
  if (!v) return null;
  const raw = typeof v === "object" && v.date ? v.date : v; // Shiprocket kokhono {date, timezone} dey
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

const getUserId = (req) => req.user?._id || req.user?.id;
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

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

const isStoreOwner = async (storeId, userId) =>
  !!(await StoreModel.exists({ _id: storeId, userId }));

// ===================== 1. STORE: SAVE / UPDATE DELIVERY SETTINGS =====================
// PUT /api/delivery/settings
// body: { storeId, deliveryType, pincode, radiusKm?, localDeliveryDays?,
//         nationalMinDays?, nationalMaxDays?, handlingDays? }
const saveDeliverySettings = async (req, res) => {
  try {
    const userId = getUserId(req);
    const data = saveDeliverySettingsSchema.parse(req.body);

    if (!mongoose.isValidObjectId(data.storeId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid store id" });
    }

    if (!(await isStoreOwner(data.storeId, userId))) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized for this store" });
    }

    // store er pincode theke lat/lng
    const pin = await PincodeModel.findOne({ pincode: data.pincode })
      .select("location area district state")
      .lean();
    if (!pin) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: [{ field: "pincode", message: "Pincode not found" }],
      });
    }

    const needsLocal =
      data.deliveryType === "LOCAL" || data.deliveryType === "BOTH";
    const needsNational =
      data.deliveryType === "NATIONAL" || data.deliveryType === "BOTH";

    // dispatch time (minute e)
    const handlingUnit = data.handlingUnit || "DAYS";
    const handlingValue = data.handlingValue ?? data.handlingDays ?? 1;
    const handlingMinutes = toMinutes(handlingValue, handlingUnit);

    // distance slab (choto theke boro, minute hishab shoho)
    const localSlabs = needsLocal
      ? [...(data.localSlabs || [])]
          .sort((a, b) => a.upToKm - b.upToKm)
          .map((s) => ({
            upToKm: s.upToKm,
            charge: round2(s.charge),
            etaValue: s.etaValue,
            etaUnit: s.etaUnit,
            etaMinutes: toMinutes(s.etaValue, s.etaUnit),
          }))
      : [];

    // order value rule (choto theke boro)
    const chargeRules = [...(data.chargeRules || [])]
      .sort((a, b) => a.minOrderValue - b.minOrderValue)
      .map((r) => ({
        minOrderValue: r.minOrderValue,
        charge: round2(r.charge),
      }));

    const allowInternational =
      needsNational && data.allowInternational === true;

    const update = {
      deliveryType: data.deliveryType,
      pincode: data.pincode,
      location: pin.location,

      handlingValue,
      handlingUnit,
      handlingMinutes,
      handlingDays: Math.ceil(handlingMinutes / 1440),

      radiusKm: needsLocal ? data.radiusKm : null,
      localSlabs,
      // purono field gulo prothom slab er sathe mil rakhi
      localDeliveryDays: needsLocal
        ? localSlabs.length
          ? Math.ceil(localSlabs[0].etaMinutes / 1440)
          : (data.localDeliveryDays ?? 1)
        : 1,
      localDeliveryCharge: needsLocal
        ? localSlabs.length
          ? localSlabs[0].charge
          : (data.localDeliveryCharge ?? 0)
        : 0,

      chargeRules,

      nationalFallbackCharge: needsNational
        ? (data.nationalFallbackCharge ?? 0)
        : 0,

      allowInternational,
      isActive: true,
    };

    if (needsNational) {
      update.nationalMinDays = data.nationalMinDays;
      update.nationalMaxDays = data.nationalMaxDays;
    }

    if (allowInternational) {
      update.internationalMinDays = data.internationalMinDays ?? 7;
      update.internationalMaxDays = data.internationalMaxDays ?? 14;
      update.internationalFallbackCharge =
        data.internationalFallbackCharge ?? 0;
    }

    const settings = await StoreDeliveryModel.findOneAndUpdate(
      { storeId: data.storeId },
      { $set: update },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    ).lean();

    const servicePincodeCount = needsLocal
      ? await countPincodesInRadius({
          coordinates: settings.location.coordinates,
          radiusKm: settings.radiusKm,
        })
      : 0;

    return res.status(200).json({
      success: true,
      message: "Delivery settings saved",
      settings,
      storeArea: { area: pin.area, district: pin.district, state: pin.state },
      servicePincodeCount,
    });
  } catch (error) {
    return handleError(res, error, "Save Delivery Settings Error");
  }
};

// ===================== 2. STORE: GET MY DELIVERY SETTINGS =====================
// GET /api/delivery/settings/:storeId
const getDeliverySettings = async (req, res) => {
  try {
    const { storeId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(storeId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid store id" });
    }
    if (!(await isStoreOwner(storeId, userId))) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized for this store" });
    }

    const settings = await StoreDeliveryModel.findOne({ storeId }).lean();
    // setting na thakle null, frontend "setup korun" dekhabe
    return res.status(200).json({ success: true, settings: settings || null });
  } catch (error) {
    return handleError(res, error, "Get Delivery Settings Error");
  }
};

// ===================== 3. STORE: PREVIEW SERVICEABLE PINCODES =====================
// GET /api/delivery/settings/:storeId/service-pincodes
// radius er moddhe kon kon pincode porche seta store ke dekhano
const previewServicePincodes = async (req, res) => {
  try {
    const { storeId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(storeId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid store id" });
    }
    if (!(await isStoreOwner(storeId, userId))) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized for this store" });
    }

    const settings = await StoreDeliveryModel.findOne({ storeId }).lean();
    if (!settings || !settings.radiusKm) {
      return res.status(404).json({
        success: false,
        message: "Local delivery radius is not set for this store",
      });
    }

    const params = {
      coordinates: settings.location.coordinates,
      radiusKm: settings.radiusKm,
    };
    const [pincodes, total] = await Promise.all([
      findPincodesInRadius({ ...params, limit: 500 }),
      countPincodesInRadius(params),
    ]);

    return res.status(200).json({
      success: true,
      radiusKm: settings.radiusKm,
      total,
      truncated: total > pincodes.length,
      pincodes,
    });
  } catch (error) {
    return handleError(res, error, "Preview Service Pincodes Error");
  }
};

const checkDelivery = async (req, res) => {
  try {
    const storeUniqueId = String(req.query.storeUniqueId || "").trim();
    const pincode = String(req.query.pincode || "").trim();
    const country = String(req.query.country || "India").trim() || "India";
    const cod = ["1", "true"].includes(
      String(req.query.cod || "").toLowerCase(),
    );

    let itemsTotal = null;
    if (req.query.itemsTotal !== undefined && req.query.itemsTotal !== "") {
      itemsTotal = Number(req.query.itemsTotal);
      if (!Number.isFinite(itemsTotal) || itemsTotal < 0) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid itemsTotal" });
      }
    }

    if (!storeUniqueId) {
      return res
        .status(400)
        .json({ success: false, message: "storeUniqueId is required" });
    }
    if (!pincode) {
      return res
        .status(400)
        .json({ success: false, message: "pincode is required" });
    }

    const store = await StoreModel.findOne({
      storeUniqueId,
      ...AVAILABLE_STORE_FILTER,
    })
      .select("_id")
      .lean();
    if (!store) return sendStoreUnavailable(res);

    // product dile oi product er packaging theke weight + size
    let parcel = null;
    const { productId } = req.query;
    if (productId && mongoose.isValidObjectId(productId)) {
      const product = await ProductModel.findOne({
        _id: productId,
        storeId: store._id,
        isActive: true,
      })
        .select(
          "name packagingDetails variants._id variants.packagingDetails variants.sizeVariants._id variants.sizeVariants.packagingDetails",
        )
        .lean();

      if (product) {
        const rawVariant = String(req.query.variantId || "").trim();
        const variantId =
          !rawVariant || rawVariant === "null" || rawVariant === "undefined"
            ? null
            : rawVariant;
        parcel = shiprocket.buildParcel([
          {
            product,
            variantId,
            quantity: Math.max(1, parseInt(req.query.quantity, 10) || 1),
          },
        ]);
      }
    }

    const policy = await getStorePolicy(store._id);
    const result = await checkStoreDelivery({
      storeId: store._id,
      pincode,
      country,
      parcel,
      cod,
      policy,
    });

    const info =
      result.deliverable && itemsTotal !== null
        ? finalizeShipping(result, itemsTotal)
        : result.info;

    return res.status(200).json({
      success: true,
      deliverable: result.deliverable,
      configured: result.configured,
      message: result.message || null,
      delivery: info,
      parcel: parcel
        ? {
            weight: parcel.weight,
            volumetricWeight: parcel.volumetricWeight,
            chargeableWeight: parcel.chargeableWeight,
            dimsComplete: parcel.dimsComplete,
            weightComplete: parcel.weightComplete,
          }
        : null,
      payment: {
        paymentMode: policy.paymentMode,
        codAvailable: policy.codAllowed,
        onlineAvailable: policy.onlineAllowed,
      },
    });
  } catch (error) {
    return handleError(res, error, "Check Delivery Error");
  }
};

// ===================== 5. PUBLIC: PINCODE LOOKUP =====================
// GET /api/delivery/pincode/:pincode   (form e area/district/state autofill + validate)
const lookupPincode = async (req, res) => {
  try {
    const { pincode } = req.params;
    if (!isValidPincode(pincode)) {
      return res
        .status(400)
        .json({ success: false, message: "Enter a valid 6 digit pincode" });
    }

    const doc = await PincodeModel.findOne({ pincode })
      .select("pincode area district state -_id")
      .lean();
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Pincode not found" });
    }

    return res.status(200).json({ success: true, pincode: doc });
  } catch (error) {
    return handleError(res, error, "Lookup Pincode Error");
  }
};

const getMyPincode = async (req, res) => {
  try {
    const userId = getUserId(req);
    const user = await UserModel.findById(userId).select("addresses").lean();
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const addresses = user.addresses || [];
    const addr = addresses.find((a) => a.isDefault) || addresses[0] || null;

    return res.status(200).json({
      success: true,
      pincode: addr?.pincode || null,
      country: addr?.country || "India",
      state: addr?.state || null,
      address: addr
        ? {
            _id: addr._id,
            label: addr.label,
            area: addr.area,
            city: addr.city,
            state: addr.state,
            pincode: addr.pincode,
            country: addr.country,
          }
        : null,
    });
  } catch (error) {
    return handleError(res, error, "Get My Pincode Error");
  }
};

const SHIPMENT_ALLOWED_STATUS = ["CONFIRMED", "SHIPPED"];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const trackingUrlFor = (awb) => `https://shiprocket.co/tracking/${awb}`;
const fmtOrderDate = (d) =>
  new Date(new Date(d).getTime() + IST_OFFSET_MS)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");

const createShiprocketShipment = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = getUserId(req);

    if (!mongoose.isValidObjectId(orderId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order id" });
    }

    const order = await OrderModel.findById(orderId).lean();
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (!(await isStoreOwner(order.storeId, userId))) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to update this order",
      });
    }

    if (!SHIPMENT_ALLOWED_STATUS.includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: "Courier shipment can be created only for a confirmed order",
      });
    }

    if (order.deliveryInfo?.mode === "INTERNATIONAL") {
      return res.status(400).json({
        success: false,
        message:
          "International shipments are not created automatically yet. Create it from the Shiprocket panel (customs documents are required)",
      });
    }

    if (order.deliveryInfo?.mode !== "NATIONAL") {
      return res.status(400).json({
        success: false,
        message: "Courier shipment is only for national delivery orders",
      });
    }

    if (!shiprocket.isConfigured()) {
      return res.status(503).json({
        success: false,
        message: "Courier service is not configured",
      });
    }

    let shipment = order.shipment || null;

    if (shipment?.awb && shipment?.pickupRequestedAt) {
      return res.status(409).json({
        success: false,
        message: "Courier shipment is already created for this order",
      });
    }

    const persist = async () => {
      await OrderModel.updateOne({ _id: orderId }, { $set: { shipment } });
    };

    // ---------- Step A: Shiprocket e order create ----------
    if (!shipment?.shipmentId) {
      let parcel = order.parcel?.weight ? order.parcel : null;

      const productIds = [
        ...new Set(order.items.map((i) => String(i.productId))),
      ];

      const [owner, customer, products] = await Promise.all([
        UserModel.findById(userId).select("name email").lean(),
        UserModel.findById(order.userId).select("email").lean(),
        parcel
          ? Promise.resolve([])
          : ProductModel.find({ _id: { $in: productIds } })
              .select(
                "name packagingDetails variants._id variants.packagingDetails variants.sizeVariants._id variants.sizeVariants.packagingDetails",
              )
              .lean(),
      ]);

      // [PICKUP] store er nijer pickup address (Shiprocket e na thakle auto-create hoy)
      const pickupLocation = await ensurePickupLocation({
        storeId: order.storeId,
        ownerName: owner?.name,
        ownerEmail: owner?.email,
      });

      if (!parcel) {
        // purono order (parcel snapshot nei): ekhon product theke hishab
        const productMap = new Map(products.map((p) => [String(p._id), p]));
        parcel = shiprocket.buildParcel(
          order.items
            .map((item) => ({
              product: productMap.get(String(item.productId)),
              variantId: item.variantId,
              quantity: item.quantity,
            }))
            .filter((e) => e.product),
        );
        await OrderModel.updateOne({ _id: orderId }, { $set: { parcel } });
      }

      const courierPaymentMethod =
        order.paymentMethod === "COD" && !order.paymentOff ? "COD" : "Prepaid";

      const addr = order.deliveryAddress;
      const payload = {
        order_id: order.orderNumber,
        order_date: fmtOrderDate(order.createdAt),
        pickup_location: pickupLocation,
        billing_customer_name: addr.fullName,
        billing_last_name: "",
        billing_address: addr.addressLine,
        billing_address_2: addr.area || "",
        billing_city: addr.city,
        billing_pincode: addr.pincode,
        billing_state: addr.state,
        billing_country: addr.country || "India",
        billing_email: customer?.email || "",
        billing_phone: addr.phone,
        shipping_is_billing: true,
        order_items: order.items.map((item) => ({
          name: item.name,
          sku: item.productCode || String(item.productId),
          units: item.quantity,
          selling_price: item.offerPrice,
          discount: "",
          tax: "",
          hsn: "",
        })),
        payment_method: courierPaymentMethod,
        sub_total:
          order.itemsTotal ??
          Math.max(0, order.totalAmount - (order.shippingCharge || 0)),
        shipping_charges: order.shippingCharge || 0,
        length: parcel.length || 10,
        breadth: parcel.breadth || 10,
        height: parcel.height || 10,
        weight: parcel.weight,
      };

      const created = await shiprocket.createAdhocOrder(payload);
      if (!created?.shipment_id) {
        throw new shiprocket.ShiprocketError(
          created?.message || "Courier service did not return a shipment id",
          { data: created },
        );
      }

      shipment = {
        provider: "SHIPROCKET",
        shiprocketOrderId: created.order_id ?? null,
        shipmentId: created.shipment_id,
        awb: null,
        courierId: order.deliveryInfo?.courierId ?? null,
        courierName: order.deliveryInfo?.courierName ?? null,
        trackingUrl: null,
        status: "CREATED",
        pickupRequestedAt: null,
        pickupScheduledDate: null,
        pickupTokenNumber: null,
        etd: order.deliveryInfo?.estimatedMaxDate ?? null,
        etdSource: "ESTIMATE",
        appliedWeight: null,
        courierSwitched: false,
        events: [],
        lastEventAt: null,
        createdAt: new Date(),
      };
      await persist();
    }

    // ---------- Step B: AWB assign ----------
    if (!shipment.awb) {
      const extract = (r) => {
        const d = r?.response?.data || {};
        return {
          awb: d.awb_code || r?.awb_code,
          data: d,
          message: d.message || r?.message,
        };
      };

      let awbRes = await shiprocket
        .assignAwb({
          shipmentId: shipment.shipmentId,
          courierId: shipment.courierId,
        })
        .catch((err) => {
          // error লুকিয়ে না ফেলে log করো, debug সহজ হবে
          console.error("AWB assign (quoted courier) failed:", err.message);
          return null;
        });
      let ex = extract(awbRes);
      let switched = false;

      // quoted courier ekhon available na hole Shiprocket ke nije courier thik korte dai
      if (!ex.awb && shipment.courierId) {
        awbRes = await shiprocket.assignAwb({
          shipmentId: shipment.shipmentId,
        });
        ex = extract(awbRes);
        switched = true;
      }

      if (!ex.awb) {
        throw new shiprocket.ShiprocketError(
          ex.message ||
            "AWB could not be assigned. Check the courier wallet balance",
          { data: awbRes },
        );
      }

      shipment = {
        ...shipment,
        awb: String(ex.awb),
        courierId: ex.data.courier_company_id ?? shipment.courierId,
        courierName: ex.data.courier_name ?? shipment.courierName,
        trackingUrl: trackingUrlFor(ex.awb),
        appliedWeight: Number(ex.data.applied_weight) || null,
        assignedAt: parseDate(ex.data.assigned_date_time) || new Date(),
        pickupScheduledDate:
          parseDate(ex.data.pickup_scheduled_date) ||
          shipment.pickupScheduledDate,
        courierSwitched: switched,
        status: "AWB_ASSIGNED",
      };
      await persist();
    }

    // ---------- Step C: pickup request ----------
    let pickupError = null;
    if (!shipment.pickupRequestedAt) {
      try {
        const pr = await shiprocket.generatePickup(shipment.shipmentId);
        const p = pr?.response || pr || {};
        shipment = {
          ...shipment,
          pickupRequestedAt: new Date(),
          pickupScheduledDate:
            parseDate(p.pickup_scheduled_date) || shipment.pickupScheduledDate,
          pickupTokenNumber:
            p.pickup_token_number != null
              ? String(p.pickup_token_number)
              : null,
          status: "PICKUP_SCHEDULED",
        };
      } catch (err) {
        if (/already/i.test(err.message || "")) {
          shipment = { ...shipment, pickupRequestedAt: new Date() };
        } else {
          pickupError = err.message;
        }
      }
    }

    const set = { shipment };
    if (!order.expectedDeliveryDate && order.deliveryInfo?.estimatedMaxDate) {
      set.expectedDeliveryDate = order.deliveryInfo.estimatedMaxDate;
    }
    await OrderModel.updateOne({ _id: orderId }, { $set: set });

    const updated = await OrderModel.findById(orderId)
      .populate("userId", "name phone email")
      .lean();

    return res.status(200).json({
      success: true,
      message: pickupError
        ? "Shipment created, but pickup request failed. Try again"
        : "Courier shipment created and pickup requested",
      pickupRequested: !pickupError,
      pickupError,
      order: updated,
    });
  } catch (error) {
    if (error.name === "PickupSetupError") {
      return res.status(400).json({ success: false, message: error.message });
    }
    if (error.name === "ShiprocketError") {
      console.error("Create Shiprocket Shipment Error:", error.message);
      return res.status(502).json({
        success: false,
        message: `Courier service error: ${error.message}. You can try again`,
      });
    }
    return handleError(res, error, "Create Shiprocket Shipment Error");
  }
};

// ===================== 8. WEBHOOK: courier tracking update =====================
// POST /api/delivery/courier-webhook   (header: x-api-key = SHIPROCKET_WEBHOOK_TOKEN)
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const courierWebhook = async (req, res) => {
  try {
    const secret = process.env.SHIPROCKET_WEBHOOK_TOKEN;
    if (!secret || !safeEqual(req.headers["x-api-key"], secret)) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const body = req.body || {};
    const awb = String(body.awb || body.awb_code || "").trim();
    const rawStatus = String(
      body.current_status || body.shipment_status || "",
    ).trim();

    if (!awb || !rawStatus) {
      return res.status(200).json({ success: true, ignored: true });
    }

    const order = await OrderModel.findOne({ "shipment.awb": awb })
      .select("status paymentMethod")
      .lean();
    if (!order) {
      return res.status(200).json({ success: true, ignored: true });
    }

    const set = {
      "shipment.status": rawStatus,
      "shipment.lastEventAt": parseDate(body.current_timestamp) || new Date(),
    };

    if (body.courier_name)
      set["shipment.courierName"] = String(body.courier_name);

    // courier er nijer ETD (customer ke dekhano estimate er cheye nirbhorjogyo)
    const etd = parseDate(body.etd);
    if (etd) {
      set["shipment.etd"] = etd;
      set["shipment.etdSource"] = "COURIER";
    }

    // tracking history (replace, tai duplicate webhook e double hoy na)
    if (Array.isArray(body.scans) && body.scans.length > 0) {
      set["shipment.events"] = body.scans
        .map((s) => ({
          status: s["sr-status-label"] || s.status || null,
          activity: s.activity || null,
          location: s.location || null,
          at: parseDate(s.date),
        }))
        .sort((a, b) => (a.at?.getTime() || 0) - (b.at?.getTime() || 0))
        .slice(-30);
    }

    await OrderModel.updateOne({ _id: order._id }, { $set: set });

    if (rawStatus.toUpperCase() === "DELIVERED" && order.status === "SHIPPED") {
      const extra =
        order.paymentMethod === "COD"
          ? { paymentStatus: "PAID", paidAt: new Date() }
          : {};

      const updated = await OrderModel.findOneAndUpdate(
        { _id: order._id, status: "SHIPPED" },
        {
          $set: { status: "DELIVERED", ...extra },
          $push: {
            statusHistory: {
              status: "DELIVERED",
              note: "Delivered by courier",
              at: new Date(),
            },
          },
        },
        { new: true },
      ).lean();

      if (updated) notifyUserOrderStatus(updated);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    return handleError(res, error, "Courier Webhook Error");
  }
};

module.exports = {
  saveDeliverySettings,
  getDeliverySettings,
  previewServicePincodes,
  checkDelivery,
  lookupPincode,
  getMyPincode,
  createShiprocketShipment,
  courierWebhook,
};
