const QRCode = require("qrcode");
const sharp = require("sharp");
const { uploadToR2, deleteFromR2 } = require("./upload.js");

const QR_SIZE = 1024;
const PADDING = 80;
const TITLE_HEIGHT = 140;
const FOOTER_HEIGHT = 110;

const escapeXml = (str = "") =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const truncate = (str = "", max = 28) =>
  str.length > max ? `${str.slice(0, max - 1)}…` : str;

const getStoreUrl = (storeUniqueId) => {
  const base = (process.env.STORE_LINK_BASE_URL || "").replace(/\/+$/, "");
  return `${base}/store/${storeUniqueId}`;
};

// QR + store name + caption diye JPG buffer banay (frontend er design er moto)
const buildQrJpeg = async (store) => {
  const url = getStoreUrl(store.storeUniqueId);

  const qrPng = await QRCode.toBuffer(url, {
    type: "png",
    errorCorrectionLevel: "H",
    margin: 2,
    width: QR_SIZE,
  });

  const width = QR_SIZE + PADDING * 2;
  const height = QR_SIZE + PADDING * 2 + TITLE_HEIGHT + FOOTER_HEIGHT;

  const textSvg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="50%" y="${PADDING + 70}" text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif" font-size="64"
        font-weight="bold" fill="#111827">${escapeXml(truncate(store.storeName))}</text>
      <text x="50%" y="${height - PADDING}" text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif" font-size="40"
        fill="#6b7280">Scan to open our store in the app</text>
    </svg>`;

  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([
      { input: qrPng, left: PADDING, top: PADDING + TITLE_HEIGHT },
      { input: Buffer.from(textSvg), left: 0, top: 0 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
};

// generate -> R2 upload -> store e save -> purono QR delete
const generateStoreQr = async (store) => {
  if (!store?.storeUniqueId) {
    throw new Error("storeUniqueId missing, cannot generate QR");
  }

  const buffer = await buildQrJpeg(store);

  const key = `amp-store-qr/${store.storeUniqueId}-${Date.now()}.jpg`;
  const qrCodeUrl = await uploadToR2(buffer, key, "image/jpeg");

  const oldKey = store.qrCodeKey;
  store.qrCodeUrl = qrCodeUrl;
  store.qrCodeKey = key;
  await store.save();

  if (oldKey) deleteFromR2(oldKey).catch(() => {});

  return qrCodeUrl;
};

const safeGenerateStoreQr = async (store) => {
  try {
    return await generateStoreQr(store);
  } catch (error) {
    console.error("Store QR generation error:", error);
    return null;
  }
};

module.exports = { generateStoreQr, safeGenerateStoreQr, getStoreUrl };
