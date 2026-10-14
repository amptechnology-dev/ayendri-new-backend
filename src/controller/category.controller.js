const CategoryModel = require("../model/category.model.js");
const { uploadToR2 } = require("../helper/upload.js");
const mongoose = require("mongoose");
const {
  isStoreAvailable,
  getAvailableStoreIds,
  sendStoreUnavailable,
} = require("../helper/storeAvailability.js");

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

const createCategory = async (req, res) => {
  try {
    if (req.user?.role !== "STORE") {
      return res.status(403).json({
        message: "Only store users can add a category",
      });
    }
    const { name, description, storeId, icon } = req.body;
    if (!name?.trim() || !storeId) {
      return res.status(400).json({ message: "Name and storeId are required" });
    }
    const exists = await CategoryModel.findOne({ name: name.trim(), storeId });
    if (exists) {
      return res
        .status(400)
        .json({ message: "Category already exists for this store" });
    }
    const image = (await uploadCategoryImage(req.files)) || "";
    const category = await CategoryModel.create({
      name: name.trim(),
      description: description?.trim() || "",
      icon: icon?.trim() || "",
      image,
      storeId,
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

    const category = await CategoryModel.findById(categoryId);

    if (!category) {
      return res.status(404).json({
        message: "Category not found",
      });
    }

    const { name, description, icon, isActive, removeImage } = req.body;

    if (name?.trim()) {
      const exists = await CategoryModel.findOne({
        _id: { $ne: categoryId },
        storeId: category.storeId,
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

// DELETE CATEGORY

const deleteCategory = async (req, res) => {
  try {
    if (req.user?.role !== "STORE") {
      return res.status(403).json({
        message: "Only store users can delete a category",
      });
    }

    const { categoryId } = req.params;

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
