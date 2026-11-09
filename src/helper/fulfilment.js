const OrderModel = require("../model/order.model.js");
const ProductModel = require("../model/product.model.js");
const StoreModel = require("../model/store.model.js");
const UserModel = require("../model/user.model.js");
const shiprocket = require("./shiprocket.js");
const {
  ensurePickupLocation,
  ensureAddressPickupLocation,
} = require("./pickupLocation.js");
const { sendPickupContactShipmentMail } = require("./pickupMail.js");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const LOCK_MS = 5 * 60 * 1000;
const MAX_TRIES = 30;

const parseDate = (v) => {
  if (!v) return null;
  const raw = typeof v === "object" && v.date ? v.date : v;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};
const trackingUrlFor = (awb) => `https://shiprocket.co/tracking/${awb}`;
const fmtOrderDate = (d) =>
  new Date(new Date(d).getTime() + IST_OFFSET_MS)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");

// order ei majhe cancel / change hoye gele true
const isStillConfirmed = async (orderId) => {
  const fresh = await OrderModel.findById(orderId).select("status").lean();
  return fresh?.status === "CONFIRMED";
};

// job cholar majhe order cancel hoye gele jototuku courier e toiri hoyeche seta cancel kore
const abortIfCancelled = async (orderId, shipment) => {
  if (shipment?.awb || shipment?.shiprocketOrderId) {
    await shiprocket
      .cancelShipment({
        awb: shipment.awb,
        shiprocketOrderId: shipment.shiprocketOrderId,
      })
      .catch((e) => console.error("Late courier cancel failed:", e.message));
  }
  await OrderModel.updateOne(
    { _id: orderId },
    { $set: { shipLockUntil: null, shipError: null } },
  );
  return { started: false, cancelled: true };
};

// shipment shuru korar shob shortho mille-i ei filter match kore
const dueFilter = (now = new Date()) => ({
  status: "CONFIRMED",
  autoShip: true,
  shipmentDone: { $ne: true },
  shipTries: { $lt: MAX_TRIES },
  shipStartDate: { $lte: now },
  priceStatus: { $in: ["NOT_REQUIRED", "CONFIRMED"] },
  $and: [
    {
      $or: [
        { paymentMethod: "COD" },
        { paymentOff: true },
        { paymentStatus: "PAID" },
      ],
    },
    { $or: [{ shipLockUntil: null }, { shipLockUntil: { $lte: now } }] },
  ],
});

// Idempotent: ekbar e ekta-i chalabe (lock), ager step sesh thakle skip kore
const startFulfilment = async (orderId) => {
  const order = await OrderModel.findOneAndUpdate(
    { _id: orderId, ...dueFilter() },
    {
      $set: { shipLockUntil: new Date(Date.now() + LOCK_MS) },
      $inc: { shipTries: 1 },
    },
    { new: true },
  )
    .select("+pickupAddress")
    .lean();

  if (!order) return { started: false };

  try {
    if (!shiprocket.isConfigured()) {
      throw new Error("Courier service is not configured");
    }

    const store = await StoreModel.findById(order.storeId)
      .select("userId")
      .lean();
    const ownerId = store?.userId;

    let shipment = order.shipment || null;
    const persist = () =>
      OrderModel.updateOne({ _id: order._id }, { $set: { shipment } });

    // ---------- Step A: Shiprocket e order create ----------
    if (!shipment?.shipmentId) {
      if (!(await isStillConfirmed(order._id))) {
        return await abortIfCancelled(order._id, shipment);
      }

      let parcel = order.parcel?.weight ? order.parcel : null;
      const productIds = [
        ...new Set(order.items.map((i) => String(i.productId))),
      ];

      const [owner, customer, products] = await Promise.all([
        UserModel.findById(ownerId).select("name email").lean(),
        UserModel.findById(order.userId).select("email").lean(),
        parcel
          ? Promise.resolve([])
          : ProductModel.find({ _id: { $in: productIds } })
              .select(
                "name packagingDetails variants._id variants.packagingDetails variants.sizeVariants._id variants.sizeVariants.packagingDetails",
              )
              .lean(),
      ]);

      const pickupLocation = order.pickupAddress?.pincode
        ? await ensureAddressPickupLocation(order.pickupAddress, {
            ownerEmail: owner?.email,
            ownerName: owner?.name,
          })
        : await ensurePickupLocation({
            storeId: order.storeId,
            ownerName: owner?.name,
            ownerEmail: owner?.email,
          });

      if (!parcel) {
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
        await OrderModel.updateOne({ _id: order._id }, { $set: { parcel } });
      }

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
        payment_method:
          order.paymentMethod === "COD" && !order.paymentOff
            ? "COD"
            : "Prepaid",
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
        throw new Error(
          created?.message || "Courier service did not return a shipment id",
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
      // AWB assign e courier wallet theke taka kate, tai age cancel check
      if (!(await isStillConfirmed(order._id))) {
        return await abortIfCancelled(order._id, shipment);
      }

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
          console.error("AWB assign (quoted courier) failed:", err.message);
          return null;
        });
      let ex = extract(awbRes);
      let switched = false;

      if (!ex.awb && shipment.courierId) {
        awbRes = await shiprocket.assignAwb({
          shipmentId: shipment.shipmentId,
        });
        ex = extract(awbRes);
        switched = true;
      }

      if (!ex.awb) {
        throw new Error(
          ex.message ||
            "AWB could not be assigned. Check the courier wallet balance",
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
    let pickupJustRequested = false;
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
        pickupJustRequested = true;
      } catch (err) {
        if (/already/i.test(err.message || "")) {
          shipment = { ...shipment, pickupRequestedAt: new Date() };
        } else {
          pickupError = err.message;
        }
      }
    }

    const done = !!(shipment.awb && shipment.pickupRequestedAt);
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          shipment,
          shipmentDone: done,
          shipError: done ? null : pickupError,
          // pickup fail hole 10 min por cron abar try korbe
          shipLockUntil: done ? null : new Date(Date.now() + 10 * 60000),
        },
      },
    );

    const fresh = await OrderModel.findById(order._id).select("status").lean();
    if (fresh?.status === "CANCELLED") {
      return await abortIfCancelled(order._id, shipment);
    }

    if (pickupJustRequested && order.pickupAddress?.email) {
      sendPickupContactShipmentMail({
        order,
        shipment,
        address: order.pickupAddress,
      }).catch((e) => console.error("Pickup shipment mail error:", e.message));
    }

    return { started: true, done };
  } catch (err) {
    // fail hole dhire dhire (10 min x tries) abar try hobe
    const wait = Math.min(order.shipTries || 1, 12) * 10 * 60000;
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          shipError: err.message,
          shipLockUntil: new Date(Date.now() + wait),
        },
      },
    );
    console.error(`Auto shipment failed (${order.orderNumber}):`, err.message);
    return { started: false, error: err.message };
  }
};

// cron: booking date asha + fail howa shipment gulo
const processDueShipments = async () => {
  const list = await OrderModel.find(dueFilter())
    .select("_id")
    .sort({ shipStartDate: 1 })
    .limit(20)
    .lean();
  for (const o of list) {
    await startFulfilment(o._id);
  }
};

module.exports = { startFulfilment, processDueShipments };
