const crypto = require("crypto");
const InstallToken = require("../model/installToken.model.js");
const StoreModel = require("../model/store.model.js");

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 ghonta
const IP_MATCH_WINDOW_MS = 30 * 60 * 1000; // IP fallback: shesh 30 minute
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 0/O, 1/I/L chhara

const generateToken = () =>
  Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join(
    "",
  );

// Cloudflare proxy er pichone real client IP CF-Connecting-IP e thake
const getClientIp = (req) =>
  (
    req.headers["cf-connecting-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0] ||
    req.ip ||
    ""
  ).trim();

// Store page render er shomoy call hoy. Same IP + browser + store hole
// notun document na bania ager token-i reuse kore (DB spam hobe na)
const createInstallToken = async (req, storeUniqueId) => {
  const now = new Date();
  const ip = getClientIp(req);
  const userAgent = (req.headers["user-agent"] || "").slice(0, 300);

  const doc = await InstallToken.findOneAndUpdate(
    {
      storeUniqueId,
      ip,
      userAgent,
      claimed: false,
      expiresAt: { $gt: now },
    },
    {
      $setOnInsert: {
        token: generateToken(),
        expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
      },
    },
    { upsert: true, returnDocument: "after" },
  );

  return doc.token;
};

// POST /api/install/claim   body: { token?: "ESHOP-INSTALL:8F7K29" }
const claimInstall = async (req, res) => {
  try {
    const now = new Date();
    const rawToken =
      typeof req.body?.token === "string"
        ? req.body.token
            .trim()
            .toUpperCase()
            .replace(/^ESHOP-INSTALL:/, "")
        : "";

    let doc = null;
    let method = null;

    // 1) Token diye (ekbar-i use kora jabe)
    if (rawToken) {
      doc = await InstallToken.findOneAndUpdate(
        { token: rawToken, claimed: false, expiresAt: { $gt: now } },
        { $set: { claimed: true, claimedAt: now } },
        { returnDocument: "after" },
      );
      if (doc) method = "token";
    }

    // 2) Fallback: IP diye, shudhu jodi ekta-i candidate thake
    if (!doc) {
      const ip = getClientIp(req);
      if (ip) {
        const candidates = await InstallToken.find({
          ip,
          claimed: false,
          expiresAt: { $gt: now },
          createdAt: { $gte: new Date(now.getTime() - IP_MATCH_WINDOW_MS) },
        })
          .sort({ createdAt: -1 })
          .limit(2);

        if (candidates.length === 1) {
          doc = await InstallToken.findOneAndUpdate(
            { _id: candidates[0]._id, claimed: false },
            { $set: { claimed: true, claimedAt: now } },
            { returnDocument: "after" },
          );
          if (doc) method = "ip";
        }
      }
    }

    if (!doc) {
      return res.status(200).json({ success: true, storeId: null });
    }

    const storeExists = await StoreModel.exists({
      storeUniqueId: doc.storeUniqueId,
    });

    return res.status(200).json({
      success: true,
      storeId: storeExists ? doc.storeUniqueId : null,
      method,
    });
  } catch (error) {
    console.error("Claim Install Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = { createInstallToken, claimInstall };