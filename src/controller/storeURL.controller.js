const StoreModel = require("../model/store.model.js");
const AppReleaseModel = require("../model/appRelease.model.js");
const { createInstallToken } = require("./install.controller");

const buildIntentUrl = (req, apkUrl) => {
  const pkg = process.env.ANDROID_PACKAGE_NAME;
  const host = req.get("host");
  const fallback = apkUrl
    ? `;S.browser_fallback_url=${encodeURIComponent(apkUrl)}`
    : "";
  return `intent://${host}${req.originalUrl}#Intent;scheme=https;package=${pkg}${fallback};end`;
};

const getStoreByUniqueId = async (req, res) => {
  try {
    const { storeUniqueId } = req.params;

    if (!storeUniqueId || !storeUniqueId.trim()) {
      return res.status(400).json({
        success: false,
        message: "Store unique id is required",
      });
    }

    const [store] = await StoreModel.aggregate([
      { $match: { storeUniqueId: storeUniqueId.trim() } },
      {
        $lookup: {
          from: AppReleaseModel.collection.name,
          pipeline: [
            { $match: { isActive: true } },
            { $sort: { createdAt: -1 } },
            { $limit: 1 },
            {
              $project: {
                _id: 0,
                appName: 1,
                version: 1,
                apkUrl: 1,
                fileSize: 1,
              },
            },
          ],
          as: "app",
        },
      },
      { $addFields: { app: { $arrayElemAt: ["$app", 0] } } },
      {
        $project: {
          storeUniqueId: 1,
          storeName: 1,
          storeType: 1,
          images: 1,
          isActive: 1,
          isVerify: 1,
          app: 1,
        },
      },
    ]);

    if (!store) {
      return res.status(404).json({
        success: false,
        message: "Store not found",
      });
    }

    // Browser hole HTML landing page, app/API call hole JSON
    const wantsHtml = (req.headers.accept || "").includes("text/html");

    if (wantsHtml) {
      const isAndroid = /android/i.test(req.headers["user-agent"] || "");
      const apkUrl = store.app?.apkUrl || null;

      // Android + APK ache hole install token toiri (clipboard e jabe)
      let installToken = null;
      if (isAndroid && apkUrl) {
        try {
          installToken = await createInstallToken(req, store.storeUniqueId);
        } catch (err) {
          console.error("Install token error:", err);
        }
      }

      res.set("Cache-Control", "no-store");

      return res.render("store-fallback", {
        store,
        isAndroid,
        apkUrl,
        installToken,
        intentUrl: isAndroid ? buildIntentUrl(req, apkUrl) : null,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Store fetched successfully",
      store,
    });
  } catch (error) {
    console.error("Get Store By Unique Id Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = { getStoreByUniqueId };
