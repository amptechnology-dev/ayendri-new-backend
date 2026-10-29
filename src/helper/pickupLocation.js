const StoreModel = require("../model/store.model.js");
const StoreDeliveryModel = require("../model/storeDelivery.model.js");
const PincodeModel = require("../model/pincode.model.js");
const shiprocket = require("./shiprocket.js");
const { pickupLocationName } = require("./pickupAddress.js");

// store এর data ভুল/অসম্পূর্ণ হলে এই error আসবে (এটা 400, Shiprocket এর দোষ না)
class PickupSetupError extends Error {
  constructor(message) {
    super(message);
    this.name = "PickupSetupError";
  }
}

const clean = (s) => String(s || "").trim();
const toPhone10 = (s) => clean(s).replace(/\D/g, "").slice(-10);

const ensurePickupLocation = async ({ storeId, ownerName, ownerEmail }) => {
  const store = await StoreModel.findById(storeId)
    .select(
      "storeName storeUniqueId address contactNo supportNo whatsappNo email shiprocketPickupLocation",
    )
    .lean();
  if (!store) throw new PickupSetupError("Store not found");

  // আগে একবার বানানো থাকলে আর কিছু করতে হবে না
  if (store.shiprocketPickupLocation) return store.shiprocketPickupLocation;

  const nickname = clean(store.storeUniqueId).slice(0, 36);
  if (!nickname) throw new PickupSetupError("Store unique id not found");

  // Shiprocket এ আগে থেকেই আছে কিনা দেখো (যেমন আগের কোনো try তে বানানো হয়েছিল)
  const existing = await shiprocket.listPickupLocations();
  const alreadyThere = existing.some((l) => l.pickup_location === nickname);

  if (!alreadyThere) {
    // pincode আসে delivery settings থেকে, city/state আসে PincodeModel থেকে
    const delivery = await StoreDeliveryModel.findOne({ storeId })
      .select("pincode")
      .lean();
    const pincode = clean(delivery?.pincode);
    if (!/^\d{6}$/.test(pincode)) {
      throw new PickupSetupError(
        "Store pincode is missing. Please save delivery settings for this store first",
      );
    }

    const pin = await PincodeModel.findOne({ pincode })
      .select("area district state")
      .lean();

    const phone = toPhone10(
      store.contactNo || store.supportNo || store.whatsappNo,
    );
    if (phone.length !== 10) {
      throw new PickupSetupError(
        "A valid 10 digit store contact number is required for courier pickup",
      );
    }

    const email = clean(store.email || ownerEmail);
    if (!email) {
      throw new PickupSetupError("Store email is required for courier pickup");
    }

    // address: store এর area + pincode এর area (Shiprocket এর address অনেক ছোট হলে reject করে)
    const addressLine = [store.address?.area, pin?.area]
      .map(clean)
      .filter(Boolean)
      .join(", ");
    if (addressLine.length < 10) {
      throw new PickupSetupError(
        "Store address is too short for courier pickup. Please add a full address",
      );
    }

    const city = clean(pin?.district);
    const state = clean(pin?.state || store.address?.state);
    if (!city || !state) {
      throw new PickupSetupError(
        "Could not find city/state for the store pincode",
      );
    }

    try {
      await shiprocket.addPickupLocation({
        pickup_location: nickname,
        name: clean(ownerName || store.storeName),
        email,
        phone,
        address: addressLine,
        address_2: "",
        city,
        state,
        country: "India",
        pin_code: pincode,
      });
    } catch (err) {
      if (!/already|exist|in use/i.test(err.message || "")) throw err;
    }
  }

  await StoreModel.updateOne(
    { _id: storeId },
    { $set: { shiprocketPickupLocation: nickname } },
  );
  return nickname;
};

const ensureAddressPickupLocation = async (
  a,
  { ownerEmail, ownerName } = {},
) => {
  const nickname = pickupLocationName(a);

  const phone = toPhone10(a.phone);
  if (phone.length !== 10) {
    throw new PickupSetupError("Pickup phone must be a 10 digit number");
  }
  const email = clean(a.email || ownerEmail);
  if (!email) {
    throw new PickupSetupError("Pickup email is required for courier pickup");
  }
  const addressLine = [a.addressLine, a.area]
    .map(clean)
    .filter(Boolean)
    .join(", ");
  if (addressLine.length < 10) {
    throw new PickupSetupError(
      "Pickup address is too short for courier pickup. Please add a full address",
    );
  }
  if (!clean(a.city) || !clean(a.state) || !/^\d{6}$/.test(clean(a.pincode))) {
    throw new PickupSetupError("Pickup city, state and pincode are required");
  }

  const existing = await shiprocket.listPickupLocations();
  if (!existing.some((l) => l.pickup_location === nickname)) {
    try {
      await shiprocket.addPickupLocation({
        pickup_location: nickname,
        name: clean(a.contactName || ownerName),
        email,
        phone,
        address: addressLine,
        address_2: "",
        city: clean(a.city),
        state: clean(a.state),
        country: clean(a.country) || "India",
        pin_code: clean(a.pincode),
      });
    } catch (err) {
      if (!/already|exist|in use/i.test(err.message || "")) throw err;
    }
  }
  return nickname;
};

module.exports = {
  ensurePickupLocation,
  ensureAddressPickupLocation,
  PickupSetupError,
};
