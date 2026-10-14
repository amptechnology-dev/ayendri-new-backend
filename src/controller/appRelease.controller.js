const mongoose = require("mongoose");
const path = require("path");
const AppReleaseModel = require("../model/appRelease.model.js");
const { uploadToR2 } = require("../helper/upload.js");

const APK_MIME = "application/vnd.android.package-archive";

const getUserId = (req) => req.user?._id || req.user?.id;

const escapeRegex = (str = "") => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// multipart e boolean string hoye ashe ("true"/"false")
const toBool = (v) => v === true || v === "true";

const sanitizeName = (name = "") =>
  path
    .basename(name, path.extname(name))
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 50);

const handleError = (res, error, label) => {
  console.error(`${label}:`, error);

  if (error.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: Object.values(error.errors).map((e) => ({
        field: e.path,
        message: e.message,
      })),
    });
  }

  if (error.code === 11000) {
    return res.status(400).json({
      success: false,
      message: "This version already exists",
    });
  }

  if (error.statusCode) {
    return res
      .status(error.statusCode)
      .json({ success: false, message: error.message });
  }

  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

// POST /api/app-release/upsert  (ADMIN)
// id nai -> create, id ache -> update. APK optional (update e), create e must.
// isActive shudhu pathale-o hobe (toggle), file lagbe na
const upsertAppRelease = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const body = req.body || {};
    const id = body.id || null;
    const isUpdate = !!id;

    if (isUpdate && !mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid app release id" });
    }

    if (isUpdate) {
      const exists = await AppReleaseModel.exists({ _id: id });
      if (!exists) {
        return res
          .status(404)
          .json({ success: false, message: "App release not found" });
      }
    }

    const appName = typeof body.appName === "string" ? body.appName.trim() : "";
    const version = typeof body.version === "string" ? body.version.trim() : "";
    const apk = req.file;

    if (!isUpdate) {
      const errors = [];
      if (!appName) errors.push({ field: "appName", message: "App name is required" });
      if (!version) errors.push({ field: "version", message: "Version is required" });
      if (!apk) errors.push({ field: "apk", message: "APK file is required" });
      if (errors.length) {
        return res
          .status(400)
          .json({ success: false, message: "Validation failed", errors });
      }
    }

    const $set = {};
    if (appName) $set.appName = appName;
    if (version) $set.version = version;
    if (body.releaseNotes !== undefined) {
      $set.releaseNotes = String(body.releaseNotes).trim();
    }
    if (body.isActive !== undefined) $set.isActive = toBool(body.isActive);

    if (apk) {
      // APK ekta zip, shuru te "PK" thake. extension fake hole ekhane atkabe
      if (apk.buffer.subarray(0, 2).toString() !== "PK") {
        return res
          .status(400)
          .json({ success: false, message: "Invalid APK file" });
      }

      const key = `amp-store/apk/${Date.now()}-${Math.round(
        Math.random() * 1e9,
      )}-${sanitizeName(apk.originalname)}.apk`;

      $set.apkUrl = await uploadToR2(apk.buffer, key, APK_MIME);
      $set.fileName = apk.originalname;
      $set.fileSize = apk.size;
    }

    if (!Object.keys($set).length) {
      return res
        .status(400)
        .json({ success: false, message: "Nothing to update" });
    }

    const filterId = isUpdate ? id : new mongoose.Types.ObjectId();

    const release = await AppReleaseModel.findOneAndUpdate(
      { _id: filterId },
      { $set, $setOnInsert: { uploadedBy: userId } },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    // ekshathe ekta-i active release (store link e ei ta-i jabe)
    if (release.isActive) {
      await AppReleaseModel.updateMany(
        { _id: { $ne: release._id }, isActive: true },
        { $set: { isActive: false } },
      );
    }

    return res.status(isUpdate ? 200 : 201).json({
      success: true,
      message: isUpdate
        ? "App release updated successfully"
        : "App release created successfully",
      data: release,
    });
  } catch (error) {
    return handleError(res, error, "Upsert App Release Error");
  }
};

// GET /api/app-release/all?page=&limit=&search=  (ADMIN)
const getAllAppReleases = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
    const search = String(req.query.search || "").trim();

    const match = {};
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      match.$or = [{ appName: rx }, { version: rx }];
    }

    const [apps, totalApps] = await Promise.all([
      AppReleaseModel.find(match)
        .populate("uploadedBy", "name email")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AppReleaseModel.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      page,
      limit,
      totalPages: Math.ceil(totalApps / limit),
      totalApps,
      apps,
    });
  } catch (error) {
    return handleError(res, error, "Get All App Releases Error");
  }
};

// GET /api/app-release/single/:id  (ADMIN)
const getSingleAppRelease = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid app release id" });
    }

    const app = await AppReleaseModel.findById(id)
      .populate("uploadedBy", "name email")
      .lean();
    if (!app) {
      return res
        .status(404)
        .json({ success: false, message: "App release not found" });
    }

    return res.status(200).json({ success: true, app });
  } catch (error) {
    return handleError(res, error, "Get Single App Release Error");
  }
};

// DELETE /api/app-release/delete/:id  (ADMIN)
const deleteAppRelease = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid app release id" });
    }

    const deleted = await AppReleaseModel.findByIdAndDelete(id);
    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "App release not found" });
    }

    return res
      .status(200)
      .json({ success: true, message: "App release deleted permanently" });
  } catch (error) {
    return handleError(res, error, "Delete App Release Error");
  }
};

// GET /api/app-release/latest  (PUBLIC) - current active release
const getLatestAppRelease = async (req, res) => {
  try {
    const app = await AppReleaseModel.findOne({ isActive: true })
      .sort({ createdAt: -1 })
      .select("appName version apkUrl fileSize releaseNotes createdAt")
      .lean();

    if (!app) {
      return res
        .status(404)
        .json({ success: false, message: "No active app release" });
    }

    return res.status(200).json({ success: true, app });
  } catch (error) {
    return handleError(res, error, "Get Latest App Release Error");
  }
};

module.exports = {
  upsertAppRelease,
  getAllAppReleases,
  getSingleAppRelease,
  deleteAppRelease,
  getLatestAppRelease,
};