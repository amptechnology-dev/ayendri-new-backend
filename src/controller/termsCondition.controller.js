const mongoose = require("mongoose");
const sanitizeHtml = require("sanitize-html");
const TermsConditionModel = require("../model/termsCondition.model.js");

const getUserId = (req) => req.user?._id || req.user?.id;

const escapeRegex = (str = "") => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toBool = (v) => v === true || v === "true";

// XSS thekate: shudhu formatting tag gulo allow
const cleanHtml = (html = "") =>
  sanitizeHtml(String(html), {
    allowedTags: [
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "ul",
      "ol",
      "li",
      "h2",
      "h3",
      "a",
    ],
    allowedAttributes: { a: ["href", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        target: "_blank",
        rel: "noopener noreferrer",
      }),
    },
  });

// tag bad diye shudhu text (<p><br></p> ke empty dhorar jonno)
const htmlToText = (html = "") =>
  sanitizeHtml(String(html), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, " ")
    .trim();

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

  if (error.statusCode) {
    return res
      .status(error.statusCode)
      .json({ success: false, message: error.message });
  }

  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

// POST /api/terms-conditions/upsert  (ADMIN)
// id nai -> create, id ache -> update. isActive shudhu pathale-o hobe (toggle)
const upsertTermsCondition = async (req, res) => {
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
        .json({ success: false, message: "Invalid terms & conditions id" });
    }

    if (isUpdate) {
      const exists = await TermsConditionModel.exists({ _id: id });
      if (!exists) {
        return res
          .status(404)
          .json({ success: false, message: "Terms & conditions not found" });
      }
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    const hasDescription = typeof body.description === "string";
    const description = hasDescription ? cleanHtml(body.description) : "";
    const descriptionText = htmlToText(description);

    if (!isUpdate) {
      const errors = [];
      if (!title) errors.push({ field: "title", message: "Title is required" });
      if (!descriptionText)
        errors.push({ field: "description", message: "Description is required" });
      if (errors.length) {
        return res
          .status(400)
          .json({ success: false, message: "Validation failed", errors });
      }
    }

    // update e description pathale kintu faka hole atkabo
    if (isUpdate && hasDescription && !descriptionText) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: [{ field: "description", message: "Description is required" }],
      });
    }

    const $set = {};
    if (title) $set.title = title;
    if (hasDescription) $set.description = description;
    if (body.order !== undefined && body.order !== "") {
      const order = Number(body.order);
      if (!Number.isFinite(order)) {
        return res
          .status(400)
          .json({ success: false, message: "Order must be a number" });
      }
      $set.order = order;
    }
    if (body.isActive !== undefined) $set.isActive = toBool(body.isActive);

    if (!Object.keys($set).length) {
      return res
        .status(400)
        .json({ success: false, message: "Nothing to update" });
    }

    const filterId = isUpdate ? id : new mongoose.Types.ObjectId();

    const terms = await TermsConditionModel.findOneAndUpdate(
      { _id: filterId },
      { $set, $setOnInsert: { uploadedBy: userId } },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    return res.status(isUpdate ? 200 : 201).json({
      success: true,
      message: isUpdate
        ? "Terms & conditions updated successfully"
        : "Terms & conditions created successfully",
      data: terms,
    });
  } catch (error) {
    return handleError(res, error, "Upsert Terms Condition Error");
  }
};

// GET /api/terms-conditions/all?page=&limit=&search=  (ADMIN)
const getAllTermsConditions = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
    const search = String(req.query.search || "").trim();

    const match = {};
    if (search) {
      match.title = new RegExp(escapeRegex(search), "i");
    }

    const [terms, totalTerms] = await Promise.all([
      TermsConditionModel.find(match)
        .populate("uploadedBy", "name email")
        .sort({ order: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      TermsConditionModel.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      page,
      limit,
      totalPages: Math.ceil(totalTerms / limit),
      totalTerms,
      terms,
    });
  } catch (error) {
    return handleError(res, error, "Get All Terms Conditions Error");
  }
};

// GET /api/terms-conditions/single/:id  (ADMIN)
const getSingleTermsCondition = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid terms & conditions id" });
    }

    const terms = await TermsConditionModel.findById(id)
      .populate("uploadedBy", "name email")
      .lean();
    if (!terms) {
      return res
        .status(404)
        .json({ success: false, message: "Terms & conditions not found" });
    }

    return res.status(200).json({ success: true, terms });
  } catch (error) {
    return handleError(res, error, "Get Single Terms Condition Error");
  }
};

// DELETE /api/terms-conditions/delete/:id  (ADMIN)
const deleteTermsCondition = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid terms & conditions id" });
    }

    const deleted = await TermsConditionModel.findByIdAndDelete(id);
    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Terms & conditions not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Terms & conditions deleted permanently",
    });
  } catch (error) {
    return handleError(res, error, "Delete Terms Condition Error");
  }
};

// GET /api/terms-conditions/active  (PUBLIC) - shob active section, order onujayi
const getActiveTermsConditions = async (req, res) => {
  try {
    const terms = await TermsConditionModel.find({ isActive: true })
      .sort({ order: 1, createdAt: 1 })
      .select("title description order updatedAt")
      .lean();

    return res.status(200).json({ success: true, terms });
  } catch (error) {
    return handleError(res, error, "Get Active Terms Conditions Error");
  }
};

module.exports = {
  upsertTermsCondition,
  getAllTermsConditions,
  getSingleTermsCondition,
  deleteTermsCondition,
  getActiveTermsConditions,
};