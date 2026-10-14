const mongoose = require("mongoose");
const AdsModel = require("../model/ads.model");
const { uploadAdsMedia } = require("../helper/productImages");

const handleError = (res, error, label) => {
  console.error(label, error);
  if (error.statusCode) {
    return res
      .status(error.statusCode)
      .json({ success: false, message: error.message });
  }
  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

const parseBool = (v) => v === true || v === "true";

// CREATE
const createAds = async (req, res) => {
  try {
    const media = await uploadAdsMedia(req.files);
    if (!media) {
      return res
        .status(400)
        .json({ success: false, message: "Video file is required" });
    }

    const ads = await AdsModel.create({ mediaUrl: media.url });

    return res
      .status(201)
      .json({ success: true, message: "Ads created successfully", ads });
  } catch (error) {
    return handleError(res, error, "Create Ads Error:");
  }
};

// ALL ADS (admin panel - active + inactive shob)
const allAds = async (req, res) => {
  try {
    const ads = await AdsModel.find().sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, total: ads.length, ads });
  } catch (error) {
    return handleError(res, error, "All Ads Error:");
  }
};

// PUBLIC ADS (shudhu active ads, login lagbe na)
const publicAds = async (req, res) => {
  try {
    const ads = await AdsModel.find({ isActive: true })
      .select("mediaUrl createdAt")
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json({ success: true, total: ads.length, ads });
  } catch (error) {
    return handleError(res, error, "Public Ads Error:");
  }
};

// SINGLE ADS
const singleAds = async (req, res) => {
  try {
    const { adsId } = req.params;
    if (!mongoose.isValidObjectId(adsId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid ads id" });
    }

    const ads = await AdsModel.findById(adsId).lean();
    if (!ads) {
      return res
        .status(404)
        .json({ success: false, message: "Ads not found" });
    }

    return res.status(200).json({ success: true, ads });
  } catch (error) {
    return handleError(res, error, "Single Ads Error:");
  }
};

// UPDATE (notun video dile replace hobe, isActive toggle kora jabe)
const updateAds = async (req, res) => {
  try {
    const { adsId } = req.params;
    if (!mongoose.isValidObjectId(adsId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid ads id" });
    }

    const ads = await AdsModel.findById(adsId);
    if (!ads) {
      return res
        .status(404)
        .json({ success: false, message: "Ads not found" });
    }

    const media = await uploadAdsMedia(req.files);
    if (media) ads.mediaUrl = media.url;

    if (req.body.isActive !== undefined) {
      ads.isActive = parseBool(req.body.isActive);
    }

    await ads.save();

    return res
      .status(200)
      .json({ success: true, message: "Ads updated successfully", ads });
  } catch (error) {
    return handleError(res, error, "Update Ads Error:");
  }
};

// DELETE
const deleteAds = async (req, res) => {
  try {
    const { adsId } = req.params;
    if (!mongoose.isValidObjectId(adsId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid ads id" });
    }

    const ads = await AdsModel.findByIdAndDelete(adsId);
    if (!ads) {
      return res
        .status(404)
        .json({ success: false, message: "Ads not found" });
    }

    return res
      .status(200)
      .json({ success: true, message: "Ads deleted successfully" });
  } catch (error) {
    return handleError(res, error, "Delete Ads Error:");
  }
};

module.exports = {
  createAds,
  allAds,
  publicAds,
  singleAds,
  updateAds,
  deleteAds,
};