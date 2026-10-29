const crypto = require("crypto");

const norm = (v) => String(v ?? "").trim();
const digits = (v) => norm(v).replace(/\D/g, "");

// same address + same contact = same key. Order split + Shiprocket pickup nickname e use hoy
// [CHANGE] contactName + email key te dhukano hoyeche. Noile same address kintu alada contact
// (alada email) er product ek order e merge hoye jeto, ar shudhu prothom contact mail pete
const pickupGroupKey = (a) => {
  if (!a || !norm(a.pincode)) return "";
  const s = [
    a.addressLine,
    a.area,
    a.city,
    a.state,
    a.pincode,
    a.phone,
    a.contactName,
    a.email,
  ]
    .map((x) => norm(x).toLowerCase())
    .join("|");
  return crypto.createHash("md5").update(s).digest("hex").slice(0, 10);
};

// Shiprocket e register kora pickup location er nickname (36 char er kom)
const pickupLocationName = (a) =>
  `PKP-${norm(a.pincode)}-${pickupGroupKey(a).slice(0, 8)}`;

// mongoose subdoc / lean object dutoi handle kore
// p = product (ba pickupAddress thaka kono doc)
const plainPickup = (p) => {
  const a = p?.pickupAddress;
  if (!a || !norm(a.pincode)) return null;
  return typeof a.toObject === "function" ? a.toObject() : { ...a };
};

// body.pickupAddress ->
//  { error }               : validation fail
//  { clear: true }         : faka / "null" (purono pickup muche jabe)
//  { address }             : valid address
//  { address: undefined }  : field-i ashe ni (kichu change korbe na)
const parsePickupAddress = (body) => {
  const raw = body.pickupAddress;
  if (raw === undefined)
    return { address: undefined, clear: false, error: null };

  let obj = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t || t === "null")
      return { clear: true, address: undefined, error: null };
    try {
      obj = JSON.parse(t);
    } catch {
      return {
        error: {
          field: "pickupAddress",
          message: "Invalid pickupAddress format",
        },
      };
    }
  }
  if (!obj || typeof obj !== "object") {
    return { clear: true, address: undefined, error: null };
  }

  let phone = digits(obj.phone);
  if (phone.length > 10) phone = phone.slice(-10);

  const address = {
    contactName: norm(obj.contactName),
    phone,
    // [CHANGE] lowercase, jate same email alada case e likhle alada group na hoy
    email: norm(obj.email).toLowerCase() || undefined,
    addressLine: norm(obj.addressLine),
    area: norm(obj.area) || undefined,
    city: norm(obj.city),
    state: norm(obj.state),
    pincode: digits(obj.pincode),
    country: norm(obj.country) || "India",
  };

  const fail = (message) => ({
    error: { field: "pickupAddress", message },
    address: undefined,
    clear: false,
  });

  if (!address.contactName) return fail("Pickup contact name is required");
  if (!/^\d{10}$/.test(address.phone))
    return fail("Pickup phone must be a 10 digit number");
  // [CHANGE] email ekhon required (mail jabe)
  if (!address.email) return fail("Pickup contact email is required");
  if (!/^\S+@\S+\.\S+$/.test(address.email))
    return fail("Pickup email is invalid");
  if (!address.addressLine) return fail("Pickup address is required");
  if (address.addressLine.length < 10)
    return fail("Pickup address is too short. Please add a full address");
  if (!address.city) return fail("Pickup city is required");
  if (!address.state) return fail("Pickup state is required");
  if (!/^\d{6}$/.test(address.pincode))
    return fail("Pickup pincode must be 6 digits");

  return { address, clear: false, error: null };
};

module.exports = {
  pickupGroupKey,
  pickupLocationName,
  plainPickup,
  parsePickupAddress,
};