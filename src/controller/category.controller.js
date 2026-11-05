const CategoryModel = require("../model/category.model.js");
const { uploadToR2 } = require("../helper/upload.js");
const mongoose = require("mongoose");
const {
  isStoreAvailable,
  getAvailableStoreIds,
  sendStoreUnavailable,
} = require("../helper/storeAvailability.js");
const ProductModel = require("../model/product.model.js");
const { CATEGORY_TYPES } = require("../model/category.model.js");

const uploadCategoryImage = async (files = []) => {
  const file = files.find((f) => f.fieldname.startsWith("image"));
  if (!file) return null;

  const fileName = `amp-store/categories/${Date.now()}-${file.originalname}`;
  return uploadToR2(file.buffer, fileName, file.mimetype);
};

const parseBoolean = (value) => {
  if (value === undefined) return undefined;
  return value === true || value === "true";
};

const normalizeType = (value) => String(value || "").trim().toUpperCase();

const createCategory = async (req, res) => {
  try {
    if (req.user?.role !== "STORE") {
      return res.status(403).json({
        message: "Only store users can add a category",
      });
    }
    const { name, description, storeId, icon } = req.body;
    const type = normalizeType(req.body.type) || "PRODUCT";

    if (!name?.trim() || !storeId) {
      return res.status(400).json({ message: "Name and storeId are required" });
    }
    if (!CATEGORY_TYPES.includes(type)) {
      return res
        .status(400)
        .json({ message: "Category type must be PRODUCT or SERVICE" });
    }

    const exists = await CategoryModel.findOne({
      name: name.trim(),
      storeId,
      type,
    });
    if (exists) {
      return res.status(400).json({
        message: `${type === "SERVICE" ? "Service" : "Product"} category already exists for this store`,
      });
    }

    const image = (await uploadCategoryImage(req.files)) || "";
    const category = await CategoryModel.create({
      name: name.trim(),
      description: description?.trim() || "",
      icon: icon?.trim() || "",
      image,
      storeId,
      type,
    });
    return res.status(201).json({
      message: "Category created successfully",
      category,
    });
  } catch (error) {
    console.error(error);
    if (error.code === 11000) {
      return res.status(400).json({
        message: "Category already exists for this store",
      });
    }
    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const allCategories = async (req, res) => {
  try {
    const { storeId } = req.query;
    const filter = {};

    if (req.query.type) {
      const type = normalizeType(req.query.type);
      if (!CATEGORY_TYPES.includes(type)) {
        return res
          .status(400)
          .json({ message: "type must be PRODUCT or SERVICE" });
      }
      filter.type = type;
    }

    if (storeId) {
      if (!mongoose.isValidObjectId(storeId)) {
        return res.status(400).json({ message: "Invalid store id" });
      }
      if (!(await isStoreAvailable(storeId))) {
        return sendStoreUnavailable(res);
      }
      filter.storeId = storeId;
    } else {
      filter.storeId = { $in: await getAvailableStoreIds() };
    }

    const categories = await CategoryModel.find(filter).sort({
      createdAt: -1,
    });

    return res.status(200).json({
      total: categories.length,
      categories,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

// SINGLE CATEGORY

const singleCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;

    if (!mongoose.isValidObjectId(categoryId)) {
      return res.status(400).json({ message: "Invalid category id" });
    }

    const category = await CategoryModel.findById(categoryId);

    if (!category) {
      return res.status(404).json({
        message: "Category not found",
      });
    }

    if (!(await isStoreAvailable(category.storeId))) {
      return sendStoreUnavailable(res);
    }

    return res.status(200).json({
      category,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

// UPDATE CATEGORY

const updateCategory = async (req, res) => {
  try {
    if (req.user?.role !== "STORE") {
      return res.status(403).json({
        message: "Only store users can update a category",
      });
    }

    const { categoryId } = req.params;

    if (!mongoose.isValidObjectId(categoryId)) {
      return res.status(400).json({ message: "Invalid category id" });
    }

    const category = await CategoryModel.findById(categoryId);

    if (!category) {
      return res.status(404).json({
        message: "Category not found",
      });
    }

    const { name, description, icon, isActive, removeImage } = req.body;

    // type is fixed after creation (products already depend on it)
    if (
      req.body.type !== undefined &&
      normalizeType(req.body.type) !== category.type
    ) {
      return res.status(400).json({
        message: "Category type cannot be changed after it is created",
      });
    }

    if (name?.trim()) {
      const exists = await CategoryModel.findOne({
        _id: { $ne: categoryId },
        storeId: category.storeId,
        type: category.type,
        name: name.trim(),
      });

      if (exists) {
        return res.status(400).json({
          message: "Category already exists for this store",
        });
      }

      category.name = name.trim();
    }
    category.description = description?.trim() ?? category.description;
    category.icon = icon !== undefined ? icon.trim() : category.icon;
    category.isActive = parseBoolean(isActive) ?? category.isActive;
    const newImage = await uploadCategoryImage(req.files);
    if (newImage) {
      category.image = newImage;
    } else if (removeImage === "true" || removeImage === true) {
      category.image = "";
    }

    await category.save();

    return res.status(200).json({
      success: true,
      message: "Category updated successfully",
      category,
    });
  } catch (error) {
    console.error(error);

    if (error.code === 11000) {
      return res.status(400).json({
        message: "Category already exists for this store",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};


const deleteCategory = async (req, res) => {
  try {
    if (req.user?.role !== "STORE") {
      return res.status(403).json({
        message: "Only store users can delete a category",
      });
    }

    const { categoryId } = req.params;

    if (!mongoose.isValidObjectId(categoryId)) {
      return res.status(400).json({ message: "Invalid category id" });
    }

    // don't leave products pointing to a deleted category
    const inUse = await ProductModel.countDocuments({ categoryId });
    if (inUse > 0) {
      return res.status(400).json({
        message: `Cannot delete: ${inUse} item(s) are using this category`,
      });
    }

    await CategoryModel.findByIdAndDelete(categoryId);

    return res.status(200).json({
      message: "Category deleted successfully",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

module.exports = {
  createCategory,
  allCategories,
  singleCategory,
  updateCategory,
  deleteCategory,
};
