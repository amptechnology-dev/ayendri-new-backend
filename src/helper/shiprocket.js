const BASE_URL = "https://apiv2.shiprocket.in/v1/external";

const TOKEN_TTL_MS = 20 * 60 * 60 * 1000; // docs e 24h theke 10 din bola ache, tai 20h e refresh
const TIMEOUT_MS = 8000;
const DOWN_COOLDOWN_MS = 2 * 60 * 1000; // Shiprocket down hole 2 min bondho rakhi (proti request e timeout na khaoar jonno)
const SERVICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SERVICE_CACHE_MAX = 2000;

// product er packagingDetails.weight er unit -> kg. Jodi gram e rakho tahole 0.001 koro
const PACKAGING_WEIGHT_TO_KG = Number(process.env.PACKAGING_WEIGHT_TO_KG) || 1;
const DEFAULT_DIM_CM = 10;

const getDefaultWeightKg = () =>
  Number(process.env.SHIPROCKET_DEFAULT_WEIGHT_KG) > 0
    ? Number(process.env.SHIPROCKET_DEFAULT_WEIGHT_KG)
    : 0.5;

class ShiprocketError extends Error {
  constructor(message, { status = null, data = null, network = false } = {}) {
    super(message);
    this.name = "ShiprocketError";
    this.status = status;
    this.data = data;
    this.network = network;
  }
}

const isConfigured = () =>
  !!process.env.SHIPROCKET_EMAIL &&
  !!process.env.SHIPROCKET_PASSWORD &&
  process.env.SHIPROCKET_ENABLED !== "false";

// ---------- availability (circuit breaker) ----------
let downUntil = 0;
const isAvailable = () => isConfigured() && Date.now() >= downUntil;
const markDown = (err) => {
  if (err?.network || (err?.status && err.status >= 500)) {
    downUntil = Date.now() + DOWN_COOLDOWN_MS;
  }
};

// ---------- low level fetch ----------
const rawFetch = async (url, options = {}) => {
  let res;
  try {
    res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ShiprocketError(`Shiprocket network error: ${err.message}`, {
      network: true,
    });
  }
  const data = await res.json().catch(() => ({}));
  return { res, data };
};

// ---------- token ----------
let tokenCache = { token: null, expiresAt: 0 };
let loginPromise = null;

const login = () => {
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    const { res, data } = await rawFetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.SHIPROCKET_EMAIL,
        password: process.env.SHIPROCKET_PASSWORD,
      }),
    });
    if (!res.ok || !data.token) {
      throw new ShiprocketError(data.message || "Shiprocket login failed", {
        status: res.status,
        data,
      });
    }
    tokenCache = { token: data.token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return tokenCache.token;
  })()
    .catch((err) => {
      // login fail hole (vul credential / network) bar bar try na kore kichukkhon thamo
      downUntil = Date.now() + DOWN_COOLDOWN_MS;
      throw err;
    })
    .finally(() => {
      loginPromise = null;
    });

  return loginPromise;
};

const getToken = async () =>
  tokenCache.token && Date.now() < tokenCache.expiresAt
    ? tokenCache.token
    : login();

// ---------- request ----------
const request = async (method, path, { query, body } = {}, retried = false) => {
  const token = await getToken();

  const qs = query
    ? `?${new URLSearchParams(
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)]),
      ).toString()}`
    : "";

  const { res, data } = await rawFetch(`${BASE_URL}${path}${qs}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (process.env.SHIPROCKET_DEBUG === "true") {
    console.log(
      `[Shiprocket] ${method} ${path}${qs} -> ${res.status}`,
      JSON.stringify(data).slice(0, 2000),
    );
  }

  // token expire hoye gele ekbar notun token niye retry
  if (res.status === 401 && !retried) {
    tokenCache = { token: null, expiresAt: 0 };
    return request(method, path, { query, body }, true);
  }

  if (!res.ok) {
    const message =
      data?.message ||
      (data?.errors && JSON.stringify(data.errors)) ||
      `Shiprocket request failed (${res.status})`;
    throw new ShiprocketError(message, { status: res.status, data });
  }
  return data;
};

// ---------- serviceability (cache soho) ----------
const serviceCache = new Map();

const etaDaysOf = (c) => {
  const direct = parseInt(c.estimated_delivery_days, 10);
  if (Number.isFinite(direct) && direct >= 0) return direct;

  const hrs = Number(c.etd_hours);
  if (Number.isFinite(hrs) && hrs > 0) return Math.ceil(hrs / 24);

  if (c.etd) {
    const t = new Date(c.etd).getTime();
    if (Number.isFinite(t))
      return Math.max(0, Math.ceil((t - Date.now()) / 86400000));
  }
  return null; 
};

const modeOf = (c) => {
  if (c.is_surface === undefined || c.is_surface === null) return null;
  return c.is_surface === true || Number(c.is_surface) === 1 ? "SURFACE" : "AIR";
};

const normalizeServiceability = (data, cod) => {
  const list = data?.data?.available_courier_companies || [];

  let couriers = list
    .map((c) => ({
      id: Number(c.courier_company_id ?? c.courier_id),
      name: c.courier_name,
      rate: Number(c.rate ?? c.freight_charge ?? c.total_charge ?? 0),
      etaDays: etaDaysOf(c),
      etd: c.etd || null,
      cod: Number(c.cod) === 1,
      rating: Number(c.rating) || null,
      mode: modeOf(c), 
    }))
    .filter((c) => Number.isFinite(c.rate)); 

  if (cod && list.some((c) => c.cod !== undefined)) {
    couriers = couriers.filter((c) => c.cod);
  }

  if (couriers.length === 0) return { serviceable: false, couriers: [] };

  const eta = (c) => (Number.isFinite(c.etaDays) ? c.etaDays : 9999);
  const cheapest = [...couriers].sort(
    (a, b) => a.rate - b.rate || eta(a) - eta(b),
  )[0];
  const fastest = [...couriers].sort(
    (a, b) => eta(a) - eta(b) || a.rate - b.rate,
  )[0];

  return { serviceable: true, couriers, cheapest, fastest };
};

const resolveWeightDims = ({ parcel, weightKg }) => {
  const raw =
    Number(parcel?.weight) > 0
      ? Number(parcel.weight)
      : Number(weightKg) > 0
        ? Number(weightKg)
        : getDefaultWeightKg();
  const weight = Math.round(raw * 100) / 100;
  const dims = parcel?.dimsComplete
    ? { length: parcel.length, breadth: parcel.breadth, height: parcel.height }
    : null;
  return { weight, dims };
};

const checkServiceability = async ({
  pickupPostcode,
  deliveryPostcode,
  weightKg,
  parcel,
  cod = false,
}) => {
  const { weight, dims } = resolveWeightDims({ parcel, weightKg });
  const dimKey = dims ? `${dims.length}x${dims.breadth}x${dims.height}` : "nd";
  const key = `${pickupPostcode}|${deliveryPostcode}|${weight}|${cod ? 1 : 0}|${dimKey}`;

  const hit = serviceCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let value;
  try {
    const data = await request("GET", "/courier/serviceability/", {
      query: {
        pickup_postcode: pickupPostcode,
        delivery_postcode: deliveryPostcode,
        weight,
        cod: cod ? 1 : 0,
        ...(dims || {}),
      },
    });
    value = normalizeServiceability(data, !!cod);
  } catch (err) {
    if (err.status === 404) {
      value = { serviceable: false, couriers: [] };
    } else {
      markDown(err);
      throw err;
    }
  }

  if (serviceCache.size >= SERVICE_CACHE_MAX) {
    serviceCache.delete(serviceCache.keys().next().value);
  }
  serviceCache.set(key, {
    value,
    expiresAt: Date.now() + SERVICE_CACHE_TTL_MS,
  });
  return value;
};

const COUNTRY_CODES = {
  "united states": "US",
  usa: "US",
  us: "US",
  "united kingdom": "GB",
  uk: "GB",
  gb: "GB",
  england: "GB",
  canada: "CA",
  australia: "AU",
  "new zealand": "NZ",
  "united arab emirates": "AE",
  uae: "AE",
  "saudi arabia": "SA",
  qatar: "QA",
  kuwait: "KW",
  oman: "OM",
  bahrain: "BH",
  singapore: "SG",
  malaysia: "MY",
  thailand: "TH",
  indonesia: "ID",
  philippines: "PH",
  vietnam: "VN",
  "hong kong": "HK",
  japan: "JP",
  "south korea": "KR",
  china: "CN",
  germany: "DE",
  france: "FR",
  italy: "IT",
  spain: "ES",
  portugal: "PT",
  netherlands: "NL",
  belgium: "BE",
  ireland: "IE",
  switzerland: "CH",
  austria: "AT",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  poland: "PL",
  turkey: "TR",
  israel: "IL",
  bangladesh: "BD",
  nepal: "NP",
  "sri lanka": "LK",
  bhutan: "BT",
  "south africa": "ZA",
  nigeria: "NG",
  kenya: "KE",
  brazil: "BR",
  mexico: "MX",
};

const toCountryCode = (country) => {
  const c = String(country || "")
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ");
  if (!c) return null;
  if (/^[a-z]{2}$/.test(c)) return c.toUpperCase();
  return COUNTRY_CODES[c] || null;
};

const cacheSet = (key, value, ttl) => {
  if (serviceCache.size >= SERVICE_CACHE_MAX) {
    serviceCache.delete(serviceCache.keys().next().value);
  }
  serviceCache.set(key, { value, expiresAt: Date.now() + ttl });
};

// Shiprocket er international serviceability path. Prothom ta try hoy, 404 hole porer ta
const INTL_PATHS = [
  "/courier/international/serviceability",
  "/international/courier/serviceability",
];
const INTL_ERROR_CACHE_TTL_MS = 2 * 60 * 1000; // error hole besi khon cache na

const checkInternationalServiceability = async ({
  pickupPostcode,
  countryCode,
  weightKg,
  parcel,
}) => {
  const { weight, dims } = resolveWeightDims({ parcel, weightKg });
  const dimKey = dims ? `${dims.length}x${dims.breadth}x${dims.height}` : "nd";
  const key = `INTL|${pickupPostcode}|${countryCode}|${weight}|${dimKey}`;

  const hit = serviceCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let value = null;
  let ttl = SERVICE_CACHE_TTL_MS;
  let lastErr = null;

  for (const path of INTL_PATHS) {
    try {
      const data = await request("GET", path, {
        query: {
          pickup_postcode: pickupPostcode,
          delivery_country: countryCode,
          weight,
          cod: 0, // international e COD hoy na
          ...(dims || {}),
        },
      });
      value = normalizeServiceability(data, false);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (err.status === 404 || err.status === 405) continue; // porer path try koro
      break;
    }
  }

  if (lastErr) {
    console.error(
      `[Shiprocket] international serviceability failed (${countryCode}):`,
      lastErr.message,
      lastErr.data ? JSON.stringify(lastErr.data).slice(0, 500) : "",
    );
    markDown(lastErr);
    value = { serviceable: false, couriers: [], error: true };
    ttl = INTL_ERROR_CACHE_TTL_MS;
  } else if (!value?.serviceable) {
    console.warn(
      `[Shiprocket] no international courier for ${countryCode}. Check international is activated on your account`,
    );
  }

  cacheSet(key, value, ttl);
  return value;
};

// ---------- shipment ----------
const createAdhocOrder = (payload) =>
  request("POST", "/orders/create/adhoc", { body: payload });

const listPickupLocations = async () => {
  const data = await request("GET", "/settings/company/pickup");
  return data?.data?.shipping_address || [];
};

const addPickupLocation = (payload) =>
  request("POST", "/settings/company/addpickup", { body: payload });

const assignAwb = ({ shipmentId, courierId }) =>
  request("POST", "/courier/assign/awb", {
    body: {
      shipment_id: shipmentId,
      ...(courierId ? { courier_id: courierId } : {}),
    },
  });

const generatePickup = (shipmentId) =>
  request("POST", "/courier/generate/pickup", {
    body: { shipment_id: [shipmentId] },
  });

// ---------- parcel weight / size (product packagingDetails theke) ----------
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const PKG_FIELDS = [
  "weight",
  "length",
  "breadth",
  "height",
  "expectedDeliveryDays",
];

// size -> color -> product, field by field. Empty {} ba 0 value hole porer level e jay
const findPackaging = (product, variantId) => {
  if (!product) return {};
  const chain = [];

  if (variantId) {
    const id = String(variantId);
    for (const v of product.variants || []) {
      if (String(v._id) === id) {
        chain.push(v.packagingDetails);
        break;
      }
      const sv = (v.sizeVariants || []).find((s) => String(s._id) === id);
      if (sv) {
        chain.push(sv.packagingDetails, v.packagingDetails);
        break;
      }
    }
  }
  chain.push(product.packagingDetails);

  const out = {};
  for (const f of PKG_FIELDS) {
    for (const p of chain) {
      const n = num(p?.[f]);
      if (n) {
        out[f] = n;
        break;
      }
    }
  }
  return out;
};

// entries: [{ product, variantId, quantity }]
const calcWeightKg = (entries) => {
  const total = entries.reduce((sum, { product, variantId, quantity }) => {
    const pkg = findPackaging(product, variantId);
    const w = num(pkg.weight);
    const unitKg = w ? w * PACKAGING_WEIGHT_TO_KG : getDefaultWeightKg();
    return sum + unitKg * (Number(quantity) || 1);
  }, 0);
  return Math.max(0.1, Math.round(total * 100) / 100);
};

const buildParcel = (entries) => {
  let length = 0;
  let breadth = 0;
  let height = 0;
  let dimsComplete = true;
  let weightComplete = true;
  const r1 = (n) => Math.round(n * 10) / 10;
  const r2 = (n) => Math.round(n * 100) / 100;

  const items = entries.map(({ product, variantId, quantity }) => {
    const pkg = findPackaging(product, variantId);
    const qty = Number(quantity) || 1;

    const w = num(pkg.weight);
    const l = num(pkg.length);
    const b = num(pkg.breadth);
    const h = num(pkg.height);
    const hasDims = !!(l && b && h);

    if (!w) weightComplete = false;
    if (!hasDims) dimsComplete = false;

    const unitWeightKg = w ? w * PACKAGING_WEIGHT_TO_KG : getDefaultWeightKg();
    const L = l || DEFAULT_DIM_CM;
    const B = b || DEFAULT_DIM_CM;
    const H = h || DEFAULT_DIM_CM;

    length = Math.max(length, L);
    breadth = Math.max(breadth, B);
    height += H * qty;

    return {
      productId: product?._id ?? null,
      variantId: variantId ?? null,
      name: product?.name ?? null,
      quantity: qty,
      unitWeightKg: r2(unitWeightKg),
      lineWeightKg: r2(unitWeightKg * qty),
      length: L,
      breadth: B,
      height: H,
      usedDefaultWeight: !w,
      usedDefaultDims: !hasDims,
    };
  });

  const weight = Math.max(
    0.1,
    r2(items.reduce((s, i) => s + i.lineWeightKg, 0)),
  );
  const volumetricWeight = r2((length * breadth * height) / 5000);

  return {
    length: r1(length),
    breadth: r1(breadth),
    height: r1(height),
    weight,
    volumetricWeight,
    chargeableWeight: Math.max(weight, volumetricWeight),
    dimsComplete,
    weightComplete,
    items,
  };
};

module.exports = {
  ShiprocketError,
  isConfigured,
  isAvailable,
  checkServiceability,
  checkInternationalServiceability,
  toCountryCode,
  createAdhocOrder,
  assignAwb,
  generatePickup,
  listPickupLocations,
  addPickupLocation,
  calcWeightKg,
  buildParcel,
};