const UserModel = require("../model/user.model.js");
const {
  addAddressSchema,
  updateAddressSchema,
} = require("../schema/user.schema.js");

const MAX_ADDRESSES = 5;

const getUserId = (req) => req.user._id || req.user.id;

const sendAddressError = (res, error, label) => {
  if (error.name === "ZodError") {
    const errors = error.issues.map((err) => ({
      field: err.path.join("."),
      message: err.message,
    }));
    return res.status(400).json({
      success: false,
      message: errors[0]?.message || "Validation failed",
      errors,
    });
  }

  if (error.name === "ValidationError") {
    const errors = Object.values(error.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return res.status(400).json({
      success: false,
      message: errors[0]?.message || "Validation failed",
      errors,
    });
  }

  console.error(`${label}:`, error);
  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

// GET /addresses
const getAddresses = async (req, res) => {
  try {
    const user = await UserModel.findById(getUserId(req)).select("addresses");
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    return res.status(200).json({
      success: true,
      total: user.addresses.length,
      addresses: user.addresses,
    });
  } catch (error) {
    return sendAddressError(res, error, "Get addresses error");
  }
};

// POST /addresses
const addAddress = async (req, res) => {
  try {
    const data = addAddressSchema.parse(req.body);

    const user = await UserModel.findById(getUserId(req));
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (user.addresses.length >= MAX_ADDRESSES) {
      return res.status(400).json({
        success: false,
        message: `You can save up to ${MAX_ADDRESSES} addresses only`,
      });
    }

    // prothom address ba isDefault: true hole seta default hobe
    const makeDefault = data.isDefault === true || user.addresses.length === 0;
    if (makeDefault) {
      user.addresses.forEach((a) => {
        a.isDefault = false;
      });
    }

    user.addresses.push({ ...data, isDefault: makeDefault });
    await user.save();

    const created = user.addresses[user.addresses.length - 1];

    return res.status(201).json({
      success: true,
      message: "Address added successfully",
      address: created,
      addresses: user.addresses,
    });
  } catch (error) {
    return sendAddressError(res, error, "Add address error");
  }
};

// PUT /addresses/:addressId
const updateAddress = async (req, res) => {
  try {
    const { addressId } = req.params;
    const data = updateAddressSchema.parse(req.body);

    if (Object.keys(data).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided to update",
      });
    }

    const user = await UserModel.findById(getUserId(req));
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const address = user.addresses.id(addressId);
    if (!address) {
      return res
        .status(404)
        .json({ success: false, message: "Address not found" });
    }

    // default ta shudhu true korle kaj korbe, false kore dile default-less hoye jabe
    const { isDefault, ...fields } = data;
    address.set(fields);

    if (isDefault === true) {
      user.addresses.forEach((a) => {
        a.isDefault = a._id.equals(address._id);
      });
    }

    await user.save();

    return res.status(200).json({
      success: true,
      message: "Address updated successfully",
      address,
      addresses: user.addresses,
    });
  } catch (error) {
    return sendAddressError(res, error, "Update address error");
  }
};

// DELETE /addresses/:addressId
const deleteAddress = async (req, res) => {
  try {
    const { addressId } = req.params;

    const user = await UserModel.findById(getUserId(req));
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const address = user.addresses.id(addressId);
    if (!address) {
      return res
        .status(404)
        .json({ success: false, message: "Address not found" });
    }

    const wasDefault = address.isDefault;
    user.addresses.pull({ _id: addressId });

    // default delete hole baki gulor prothom ta default hobe
    if (wasDefault && user.addresses.length > 0) {
      user.addresses[0].isDefault = true;
    }

    await user.save();

    return res.status(200).json({
      success: true,
      message: "Address deleted successfully",
      addresses: user.addresses,
    });
  } catch (error) {
    return sendAddressError(res, error, "Delete address error");
  }
};

// PATCH /addresses/:addressId/default
const setDefaultAddress = async (req, res) => {
  try {
    const { addressId } = req.params;

    const user = await UserModel.findById(getUserId(req));
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const address = user.addresses.id(addressId);
    if (!address) {
      return res
        .status(404)
        .json({ success: false, message: "Address not found" });
    }

    user.addresses.forEach((a) => {
      a.isDefault = a._id.equals(address._id);
    });
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Default address updated successfully",
      addresses: user.addresses,
    });
  } catch (error) {
    return sendAddressError(res, error, "Set default address error");
  }
};

module.exports = {
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
};