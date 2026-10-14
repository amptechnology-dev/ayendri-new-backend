const mongoose = require("mongoose");
const UserModel = require("../model/user.model.js");
const StoreModel = require("../model/store.model.js");
const StoreViewModel = require("../model/StoreViewModel.js");
const ProductModel = require("../model/product.model.js");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { passwordGenerator } = require("../helper/PasswordGenerator.js");
const {
  createUserSchema,
  updateUserSchema,
} = require("../schema/user.schema.js");
const { uploadToR2 } = require("../helper/upload.js");
const sendPasswordEmail = require("../helper/mail.service.js");
const sendStoreVerifyEmail = require("../helper/sendStoreVerifyEmail");
const { sendPasswordSMS } = require("../helper/sendPasswordSMS.js");
const sendEmailVerificationOTP = require("../helper/sendEmailVerificationOTP.js");
const EmailVerifyModel = require("../model/otpverify.js");
const RecentSearchModel = require("../model/recentSearch.model");
const sendStoreCredentialsEmail = require("../helper/sendStoreCredentialsEmail.js");
const {
  generateAuthToken,
  setAuthCookie,
  buildResponseUser,
} = require("../helper/authToken");
const {
  generateStoreQr,
  safeGenerateStoreQr,
} = require("../helper/storeQr.js");

const normalizeEmail = (email) =>
  String(email || "")
    .trim()
    .toLowerCase();
const toBool = (value) =>
  value === true || String(value).trim().toLowerCase() === "true";

// trims a string, returns undefined for empty / null / undefined values
const clean = (value) => {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === "" ? undefined : trimmed;
};

// converts to a finite number, otherwise undefined (avoids saving NaN)
const toNumberOrUndefined = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
};

// is this email already registered under this role
const accountExists = (email, role) =>
  UserModel.exists({ email: normalizeEmail(email), role });

const roleConflict = (res, role) =>
  res.status(409).json({
    success: false,
    message: `This email is already registered as ${role}`,
  });

// returns true (and sends the response) when a required field is missing
const missingField = (res, fields) => {
  for (const [label, value] of fields) {
    if (value === undefined || value === null || String(value).trim() === "") {
      res.status(400).json({ success: false, message: `${label} is required` });
      return true;
    }
  }
  return false;
};

const DUPLICATE_FIELD_LABELS = {
  email: "Email",
  phone: "Phone number",
  storeUniqueId: "Store ID",
  gstin: "GSTIN",
};

// one place that turns any registration error into a specific message
const sendRegisterError = (res, error, { role, label }) => {
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

  if (error.code === 11000) {
    const keys = Object.keys(error.keyPattern || {});
    if (keys.includes("email") && keys.includes("role")) {
      return roleConflict(res, role);
    }
    const field = keys[0];
    return res.status(409).json({
      success: false,
      message: `${DUPLICATE_FIELD_LABELS[field] || field || "Value"} already exists`,
    });
  }

  if (error.name === "CastError") {
    return res
      .status(400)
      .json({ success: false, message: `Invalid value for ${error.path}` });
  }

  console.error(`${label}:`, error);
  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

const registerAdmin = async (req, res) => {
  try {
    const parsedData = createUserSchema.parse(req.body);
    const email = normalizeEmail(parsedData.email);

    if (await accountExists(email, "ADMIN")) {
      return roleConflict(res, "ADMIN");
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(parsedData.password, salt);

    const user = new UserModel({
      ...parsedData,
      email,
      password: hashedPassword,
      role: "ADMIN",
      isVerified: true,
    });
    await user.save();

    let emailSent = true;
    try {
      await sendPasswordEmail(email, parsedData.password);
      // await sendPasswordSMS(parsedData.phone, email, parsedData.password);
    } catch (mailError) {
      emailSent = false;
      console.error("Admin password email error:", mailError);
    }

    const { password: _password, ...safeUser } = user.toObject();
    return res.status(201).json({
      success: true,
      message: emailSent
        ? "Super Admin Register Successfully"
        : "Super Admin registered, but the password email could not be sent",
      user: safeUser,
    });
  } catch (error) {
    return sendRegisterError(res, error, {
      role: "ADMIN",
      label: "Admin registration error",
    });
  }
};

const registerOwner = async (req, res) => {
  try {
    const parsedData = createUserSchema.parse(req.body);
    const email = normalizeEmail(parsedData.email);

    if (await accountExists(email, "STORE")) {
      return roleConflict(res, "STORE");
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(parsedData.password, salt);

    const user = new UserModel({
      ...parsedData,
      email,
      password: hashedPassword,
      role: "STORE",
    });
    await user.save();

    let otpSent = true;
    try {
      await sendEmailVerificationOTP(req, user);
    } catch (mailError) {
      otpSent = false;
      console.error("Verification OTP email error:", mailError);
    }

    const { password: _password, ...safeUser } = user.toObject();
    return res.status(201).json({
      success: true,
      message: otpSent
        ? "Store owner registered and verification email sent successfully!"
        : "Store owner registered, but the verification email could not be sent. Please try again later.",
      user: safeUser,
    });
  } catch (error) {
    return sendRegisterError(res, error, {
      role: "STORE",
      label: "Store owner registration error",
    });
  }
};

const verifyEmailOTP = async (req, res) => {
  try {
    const { email, otp, role } = req.body;
    if (!email || !otp) {
      return res
        .status(400)
        .json({ status: false, message: "All fields are required" });
    }

    const normalizedEmail = normalizeEmail(email);
    const normalizedRole = role ? String(role).trim().toUpperCase() : null;

    if (
      normalizedRole &&
      !["ADMIN", "STORE", "USER"].includes(normalizedRole)
    ) {
      return res.status(400).json({ status: false, message: "Invalid role" });
    }

    const accounts = await UserModel.find(
      normalizedRole
        ? { email: normalizedEmail, role: normalizedRole }
        : { email: normalizedEmail },
    );
    if (!accounts.length) {
      return res
        .status(404)
        .json({ status: false, message: "Email doesn't exist" });
    }

    let existingUser;
    if (accounts.length === 1) {
      existingUser = accounts[0];
    } else {
      const unverified = accounts.filter((a) => !a.isVerified);
      if (unverified.length === 1) {
        existingUser = unverified[0];
      } else {
        return res.status(400).json({
          status: false,
          message: "Multiple accounts found for this email. Please send role.",
        });
      }
    }

    if (existingUser.isVerified) {
      return res
        .status(400)
        .json({ status: false, message: "Email is already verified" });
    }

    const emailVerification = await EmailVerifyModel.findOne({
      userId: existingUser._id,
      otp: String(otp).trim(),
    });
    if (!emailVerification) {
      await sendEmailVerificationOTP(req, existingUser);
      return res.status(400).json({
        status: false,
        message: "Invalid OTP, new OTP sent to your email",
      });
    }

    const expirationTime =
      emailVerification.createdAt.getTime() + 15 * 60 * 1000;
    if (Date.now() > expirationTime) {
      await sendEmailVerificationOTP(req, existingUser);
      return res.status(400).json({
        status: false,
        message: "OTP expired, new OTP sent to your email",
      });
    }

    existingUser.isVerified = true;
    await existingUser.save();
    await EmailVerifyModel.deleteMany({ userId: existingUser._id });

    const token = generateAuthToken(existingUser);
    setAuthCookie(res, token);

    return res.status(200).json({
      status: true,
      message: "Email verified successfully",
      token,
      user: buildResponseUser(existingUser),
    });
  } catch (error) {
    console.error("Verify OTP error:", error);
    return res.status(500).json({
      status: false,
      message: "Unable to verify email, please try again later",
    });
  }
};

const registerStoreOwner = async (req, res) => {
  let user;
  try {
    const {
      name,
      email,
      phone,
      password,
      storeName,
      storeType,
      categoryId,
      subCategoryId,
      description,
      contactNo,
      whatsappNo,
      website,
      gstin,
      lat,
      long,
    } = req.body;

    if (
      missingField(res, [
        ["Name", name],
        ["Email", email],
        ["Password", password],
      ])
    ) {
      return;
    }

    const normalizedEmail = normalizeEmail(email);

    if (await accountExists(normalizedEmail, "STORE")) {
      return roleConflict(res, "STORE");
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(String(password).trim(), salt);

    user = await UserModel.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: clean(phone),
      password: hashedPassword,
      role: "STORE",
    });

    /* IMAGE UPLOAD */
    let images = [];

    if (req.files?.length) {
      for (const file of req.files) {
        if (file.fieldname.startsWith("image")) {
          const fileName = `amp-store/${Date.now()}-${file.originalname}`;
          const url = await uploadToR2(file.buffer, fileName, file.mimetype);
          images.push(url);
        }
      }
    }

    const store = await StoreModel.create({
      storeName: clean(storeName),
      storeType: clean(storeType),
      categoryId: clean(categoryId),
      subCategoryId: clean(subCategoryId),
      description: clean(description),

      contactNo: clean(contactNo),
      whatsappNo: clean(whatsappNo),

      email: normalizedEmail,
      website: clean(website),

      gstin: clean(gstin),

      lat: toNumberOrUndefined(lat),
      long: toNumberOrUndefined(long),

      images,

      address: {
        area: req.body?.address?.area,
        state: req.body?.address?.state,
        country: req.body?.address?.country,
      },

      timing: {
        open: req.body?.timing?.open,
        close: req.body?.timing?.close,
      },

      timingByDay: {
        sunday: req.body?.timingByDay?.sunday,
        monday: req.body?.timingByDay?.monday,
        tuesday: req.body?.timingByDay?.tuesday,
        wednesday: req.body?.timingByDay?.wednesday,
        thursday: req.body?.timingByDay?.thursday,
        friday: req.body?.timingByDay?.friday,
        saturday: req.body?.timingByDay?.saturday,
      },

      imageSeo: req.body.imageSeo,

      userId: user._id,
    });

    await safeGenerateStoreQr(store);

    let emailSent = true;
    try {
      await sendPasswordEmail(normalizedEmail, password);
    } catch (mailError) {
      emailSent = false;
      console.error("Store owner password email error:", mailError);
    }

    return res.status(201).json({
      success: true,
      message: emailSent
        ? "Your store registration is successful. Please wait for admin verification."
        : "Your store registration is successful, but the email could not be sent. Please wait for admin verification.",
      user: {
        ...user.toObject(),
        password: undefined,
      },
      store,
    });
  } catch (error) {
    // store create failed, remove the orphan user
    if (user?._id) {
      await UserModel.findByIdAndDelete(user._id).catch(() => {});
    }

    return sendRegisterError(res, error, {
      role: "STORE",
      label: "Store owner registration error",
    });
  }
};

const createUser = async (req, res) => {
  let user;
  let store;
  try {
    const {
      name,
      email,
      phone,
      password,
      storeName,
      storeType,
      categoryId,
      subCategoryId,
      description,
      contactNo,
      whatsappNo,
      supportNo,
      website,
      gstin,
      lat,
      long,
    } = req.body;

    if (
      missingField(res, [
        ["Name", name],
        ["Email", email],
        ["Password", password],
      ])
    ) {
      return;
    }

    const normalizedEmail = normalizeEmail(email);

    if (await accountExists(normalizedEmail, "STORE")) {
      return roleConflict(res, "STORE");
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(String(password).trim(), salt);

    user = await UserModel.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: clean(phone),
      password: hashedPassword,
      role: "STORE",
      isVerified: true,
    });

    /* IMAGE UPLOAD */
    let images = [];

    if (req.files?.length) {
      for (const file of req.files) {
        if (file.fieldname.startsWith("image")) {
          const fileName = `amp-store/${Date.now()}-${file.originalname}`;
          const url = await uploadToR2(file.buffer, fileName, file.mimetype);
          images.push(url);
        }
      }
    }

    store = await StoreModel.create({
      storeName: clean(storeName),
      storeType: clean(storeType),
      categoryId: clean(categoryId),
      subCategoryId: clean(subCategoryId),
      description: clean(description),

      contactNo: clean(contactNo),
      whatsappNo: clean(whatsappNo),
      supportNo: clean(supportNo),

      email: normalizedEmail,
      website: clean(website),
      gstin: clean(gstin),

      lat: toNumberOrUndefined(lat),
      long: toNumberOrUndefined(long),

      images,

      address: {
        area: req.body?.address?.area,
        state: req.body?.address?.state,
        country: req.body?.address?.country,
      },

      timing: {
        open: req.body?.timing?.open,
        close: req.body?.timing?.close,
      },

      timingByDay: {
        sunday: req.body?.timingByDay?.sunday,
        monday: req.body?.timingByDay?.monday,
        tuesday: req.body?.timingByDay?.tuesday,
        wednesday: req.body?.timingByDay?.wednesday,
        thursday: req.body?.timingByDay?.thursday,
        friday: req.body?.timingByDay?.friday,
        saturday: req.body?.timingByDay?.saturday,
      },

      userId: user._id,
      isVerify: true,
      isVisitor: toBool(req.body.isVisitor),
    });

    await safeGenerateStoreQr(store);

    let emailSent = true;
    try {
      await sendStoreCredentialsEmail({
        toEmail: user.email,
        ownerName: user.name,
        storeName: store.storeName,
        storeUniqueId: store.storeUniqueId,
        password: String(password).trim(),
      });
    } catch (mailError) {
      emailSent = false;
      console.error("Store credentials email error:", mailError);
    }

    return res.status(201).json({
      success: true,
      message: emailSent
        ? "User and store created successfully"
        : "User and store created, but the credentials email could not be sent",
      user: {
        ...user.toObject(),
        password: undefined,
      },
      store,
    });
  } catch (error) {
    // store create failed, remove the orphan user
    if (user?._id && !store) {
      await UserModel.findByIdAndDelete(user._id).catch(() => {});
    }

    return sendRegisterError(res, error, {
      role: "STORE",
      label: "User creation error",
    });
  }
};

const createStore = async (req, res) => {
  try {
    const {
      storeName,
      storeType,
      categoryId,
      subCategoryId,
      description,
      contactNo,
      whatsappNo,
      website,
      gstin,
      lat,
      long,
    } = req.body;

    const userId = req.user.id;

    const user = await UserModel.findById(userId);
    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    let images = [];

    if (req.files?.length) {
      for (const file of req.files) {
        if (file.fieldname.startsWith("image")) {
          const fileName = `amp-store/${Date.now()}-${file.originalname}`;

          const url = await uploadToR2(file.buffer, fileName, file.mimetype);

          images.push(url);
        }
      }
    }

    const store = await StoreModel.create({
      storeName: clean(storeName),
      storeType: clean(storeType),
      categoryId: clean(categoryId),
      subCategoryId: clean(subCategoryId),
      description: clean(description),

      contactNo: clean(contactNo),
      whatsappNo: clean(whatsappNo),

      email: user.email,
      website: clean(website),

      gstin: clean(gstin),

      lat: toNumberOrUndefined(lat),
      long: toNumberOrUndefined(long),

      images,

      address: {
        area: req.body?.address?.area,
        state: req.body?.address?.state,
        country: req.body?.address?.country,
      },

      timing: {
        open: req.body?.timing?.open,
        close: req.body?.timing?.close,
      },

      timingByDay: {
        sunday: req.body?.timingByDay?.sunday,
        monday: req.body?.timingByDay?.monday,
        tuesday: req.body?.timingByDay?.tuesday,
        wednesday: req.body?.timingByDay?.wednesday,
        thursday: req.body?.timingByDay?.thursday,
        friday: req.body?.timingByDay?.friday,
        saturday: req.body?.timingByDay?.saturday,
      },

      imageSeo: req.body.imageSeo,

      userId: userId,

      isVerify: false,
    });

    await safeGenerateStoreQr(store);

    return res.status(201).json({
      message: "Store created successfully",
      user: {
        ...user.toObject(),
        password: undefined,
      },
      store,
    });
  } catch (error) {
    console.error("Store creation error:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const allStores = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit =
      parseInt(req.query.limit) ||
      parseInt(process.env.DEFAULT_PAGE_SIZE) ||
      10;
    const search = req.query.search || "";

    const skip = (page - 1) * limit;

    const pipeline = [
      {
        $match: {
          storeName: { $regex: search, $options: "i" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "owner",
        },
      },

      {
        $unwind: {
          path: "$owner",
          preserveNullAndEmptyArrays: true,
        },
      },

      {
        $addFields: {
          ownerName: "$owner.name",
          ownerEmail: "$owner.email",
          ownerPhone: "$owner.phone",
        },
      },

      {
        $project: {
          owner: 0,
        },
      },

      {
        $sort: { createdAt: -1 },
      },

      {
        $skip: skip,
      },

      {
        $limit: limit,
      },
    ];

    const stores = await StoreModel.aggregate(pipeline);

    const totalStores = await StoreModel.countDocuments({
      storeName: { $regex: search, $options: "i" },
    });

    const totalPages = Math.ceil(totalStores / limit);

    return res.status(200).json({
      page,
      totalPages,
      totalStores,
      stores,
    });
  } catch (error) {
    console.error("Error fetching stores:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const singleStore = async (req, res) => {
  try {
    const storeId = req.params.storeId;

    const store = await StoreModel.aggregate([
      {
        $match: {
          _id: new mongoose.Types.ObjectId(storeId),
        },
      },

      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "owner",
        },
      },

      {
        $unwind: "$owner",
      },

      {
        $project: {
          storeName: 1,
          storeType: 1,
          categoryId: 1,
          subCategoryId: 1,
          storeUniqueId: 1,
          description: 1,
          images: 1,
          contactNo: 1,
          whatsappNo: 1,
          website: 1,
          gstin: 1,
          lat: 1,
          long: 1,
          address: 1,
          timing: 1,
          timingByDay: 1,
          imageSeo: 1,
          reviews: 1,
          createdAt: 1,
          isVerify: 1,
          isActive: 1,
          isVisitor: 1,
          qrCodeUrl: 1,
          owner: {
            _id: "$owner._id",
            name: "$owner.name",
            email: "$owner.email",
            phone: "$owner.phone",
          },
        },
      },
    ]);

    if (!store.length) {
      return res.status(404).json({
        message: "Store not found",
      });
    }

    return res.status(200).json({
      store: store[0],
    });
  } catch (error) {
    console.error("Error fetching store:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const updateStoreAndUser = async (req, res) => {
  try {
    const { storeId } = req.params;
    const isAdmin = req.user?.role === "ADMIN";

    const store = await StoreModel.findById(storeId);

    if (!store) {
      return res.status(404).json({
        message: "Store not found",
      });
    }

    const user = await UserModel.findById(store.userId);

    /* PASSWORD UPDATE */

    let password = user.password;

    if (req.body.password) {
      const salt = await bcrypt.genSalt(10);
      password = await bcrypt.hash(req.body.password.trim(), salt);
    }

    await UserModel.findByIdAndUpdate(user._id, {
      name: req.body.name || user.name,
      email: req.body.email || user.email,
      phone: req.body.phone || user.phone,
      password,
    });

    let images = [];

    // 1️⃣ If client sends existing images list (remaining images)
    if (req.body.images) {
      if (Array.isArray(req.body.images)) {
        images = req.body.images;
      } else {
        images = [req.body.images];
      }
    }

    // 2️⃣ Upload new images & add
    if (req.files?.length) {
      for (const file of req.files) {
        if (file.fieldname.startsWith("image")) {
          const fileName = `amp-store/${Date.now()}-${file.originalname}`;

          const url = await uploadToR2(file.buffer, fileName, file.mimetype);

          images.push(url);
        }
      }
    }

    // 3️⃣ If nothing sent → keep old images
    if (!req.body.images && !req.files?.length) {
      images = store.images;
    }

    /* ============================== */

    const updatedStore = await StoreModel.findByIdAndUpdate(
      storeId,
      {
        storeName: req.body.storeName || store.storeName,
        storeType: req.body.storeType || store.storeType,
        categoryId: req.body.categoryId || store.categoryId,
        subCategoryId: req.body.subCategoryId || store.subCategoryId,
        description: req.body.description || store.description,

        contactNo: req.body.contactNo || store.contactNo,
        whatsappNo: req.body.whatsappNo || store.whatsappNo,

        website: req.body.website || store.website,
        gstin: req.body.gstin || store.gstin,

        lat: req.body.lat ? Number(req.body.lat) : store.lat,
        long: req.body.long ? Number(req.body.long) : store.long,

        images,

        address: {
          area: req.body?.address?.area || store.address?.area,
          state: req.body?.address?.state || store.address?.state,
          country: req.body?.address?.country || store.address?.country,
        },

        timing: {
          open: req.body?.timing?.open || store.timing?.open,
          close: req.body?.timing?.close || store.timing?.close,
        },

        timingByDay: {
          sunday: req.body?.timingByDay?.sunday || store.timingByDay?.sunday,
          monday: req.body?.timingByDay?.monday || store.timingByDay?.monday,
          tuesday: req.body?.timingByDay?.tuesday || store.timingByDay?.tuesday,
          wednesday:
            req.body?.timingByDay?.wednesday || store.timingByDay?.wednesday,
          thursday:
            req.body?.timingByDay?.thursday || store.timingByDay?.thursday,
          friday: req.body?.timingByDay?.friday || store.timingByDay?.friday,
          saturday:
            req.body?.timingByDay?.saturday || store.timingByDay?.saturday,
        },

        imageSeo: req.body.imageSeo || store.imageSeo,

        isVerify: req.body.isVerify ?? store.isVerify,
        isActive: req.body.isActive ?? store.isActive,
        isVisitor:
          isAdmin && req.body.isVisitor !== undefined
            ? toBool(req.body.isVisitor)
            : Boolean(store.isVisitor),
      },
      { new: true },
    );

    if (req.body.storeName && req.body.storeName !== store.storeName) {
      await safeGenerateStoreQr(updatedStore);
    }

    return res.status(200).json({
      message: "User and store updated successfully",
      store: updatedStore,
    });
  } catch (error) {
    console.error("Update error:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const deleteStoreAndUser = async (req, res) => {
  try {
    const { storeId } = req.params;

    const store = await StoreModel.findById(storeId);

    if (!store) {
      return res.status(404).json({
        message: "Store not found",
      });
    }

    const userId = store.userId;

    /* DELETE STORE */

    await StoreModel.findByIdAndDelete(storeId);

    /* DELETE USER */

    await UserModel.findByIdAndDelete(userId);

    return res.status(200).json({
      message: "Store and related user deleted successfully",
    });
  } catch (error) {
    console.error("Delete error:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const userBasedStores = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const stores = await StoreModel.find({
      userId: userId,
    })
      .populate({
        path: "userId",
        select: "name email phone",
      })
      .sort({ createdAt: -1 });

    const totalStores = stores.length;

    return res.status(200).json({
      totalStores,
      stores,
    });
  } catch (error) {
    console.error("Error fetching stores:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const publicAllStores = async (req, res) => {
  try {
    const search = req.query.search || "";

    const stores = await StoreModel.find({
      $and: [
        { isVerify: true },
        { isActive: true },
        {
          $or: [
            { storeName: { $regex: search, $options: "i" } },
            { "address.area": { $regex: search, $options: "i" } },
            { "address.state": { $regex: search, $options: "i" } },
            { "address.country": { $regex: search, $options: "i" } },
          ],
        },
      ],
    })
      .populate({
        path: "userId",
        select: "name email phone",
      })
      .sort({ createdAt: -1 });

    return res.status(200).json({
      totalStores: stores.length,
      stores,
    });
  } catch (error) {
    console.error("Error fetching public stores:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const storeWithProducts = async (req, res) => {
  try {
    const { storeId } = req.params;

    if (req.user && ["USER", "STORE"].includes(req.user.role)) {
      await RecentSearchModel.findOneAndUpdate(
        {
          userId: req.user.id,
          storeId,
        },
        {
          userId: req.user.id,
          storeId,
          updatedAt: new Date(),
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        },
      );

      const existingView = await StoreViewModel.findOne({
        storeId,
        userId: req.user.id,
      });

      if (!existingView) {
        await StoreViewModel.create({
          storeId,
          userId: req.user.id,
        });

        await StoreModel.findByIdAndUpdate(storeId, {
          $inc: {
            viewCount: 1,
          },
        });
      }
    }

    const store = await StoreModel.findById(storeId).populate({
      path: "userId",
      select: "name email phone",
    });

    if (!store) {
      return res.status(404).json({
        message: "Store not found",
      });
    }

    const products = await ProductModel.find({
      storeId: storeId,
      isActive: true,
      isVerified: true,
    }).sort({
      createdAt: -1,
    });

    return res.status(200).json({
      store,

      totalProducts: products.length,

      products,
    });
  } catch (error) {
    console.error("Error fetching store with products:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const verifyStoreStatus = async (req, res) => {
  try {
    const { storeId } = req.params;
    const { isVerify } = req.body;

    if (!storeId) {
      return res.status(400).json({
        message: "Store ID is required",
      });
    }

    /* ============================
       GET STORE
    ============================ */
    const store = await StoreModel.findById(storeId);

    if (!store) {
      return res.status(404).json({
        message: "Store not found",
      });
    }

    /* ============================
       UPDATE VERIFY STATUS
    ============================ */
    store.isVerify = isVerify;
    await store.save();

    /* ============================
       GET USER (OWNER)
    ============================ */
    const user = await UserModel.findById(store.userId);

    /* ============================
       SEND MAIL ONLY IF VERIFIED
    ============================ */
    if (isVerify && user?.email) {
      await sendStoreVerifyEmail(
        user.email,
        store.storeName,
        store.storeUniqueId,
      );
    }

    return res.status(200).json({
      success: true,
      message:
        "Store is " +
        (isVerify ? "verified" : "not verified") +
        " successfully",
    });
  } catch (error) {
    console.error("Store verify error:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const updateStoreFeatured = async (req, res) => {
  try {
    const { storeId } = req.params;
    const store = await StoreModel.findById(storeId);
    if (!store) {
      return res.status(404).json({
        message: "Store not found",
      });
    }
    store.isFeatured = !store.isFeatured;
    await store.save();
    return res.status(200).json({
      message: `Store ${
        store.isFeatured ? "featured" : "removed from featured"
      } successfully`,
      store,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const storesBySubCategory = async (req, res) => {
  try {
    const { subCategoryId } = req.params;

    const stores = await StoreModel.find({
      subCategoryId,
      isActive: true,
    })
      .populate("userId", "name email")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      total: stores.length,
      stores,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const searchStoreNames = async (req, res) => {
  try {
    const { search = "" } = req.query;

    const stores = await StoreModel.find(
      {
        storeName: {
          $regex: search,
          $options: "i",
        },
        isActive: true,
      },
      {
        storeName: 1,
        _id: 1,
      },
    )
      .limit(20)
      .sort({ storeName: 1 });

    return res.status(200).json({
      total: stores.length,
      stores,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const allStates = async (req, res) => {
  try {
    const states = await StoreModel.distinct("address.state", {
      isActive: true,
    });

    const filteredStates = states
      .filter((state) => state && state.trim())
      .sort();

    return res.status(200).json({
      total: filteredStates.length,
      states: filteredStates,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const storesByState = async (req, res) => {
  try {
    const { state } = req.params;

    const stores = await StoreModel.find({
      "address.state": {
        $regex: `^${state}$`,
        $options: "i",
      },
      isActive: true,
    })
      .populate("categoryId", "name image")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      total: stores.length,
      stores,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const recentSearchStores = async (req, res) => {
  try {
    const userId = req.user.id;

    const recentStores = await RecentSearchModel.find({
      userId,
    })
      .populate({
        path: "storeId",
        populate: {
          path: "categoryId",
          select: "name image",
        },
      })
      .sort({
        updatedAt: -1,
      })
      .limit(20);

    const stores = recentStores.map((item) => item.storeId).filter(Boolean);

    return res.status(200).json({
      total: stores.length,
      stores,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const clearRecentSearches = async (req, res) => {
  try {
    await RecentSearchModel.deleteMany({
      userId: req.user.id,
    });

    return res.status(200).json({
      message: "Recent searches cleared successfully",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const relatedStores = async (req, res) => {
  try {
    const { storeId } = req.params;

    const currentStore = await StoreModel.findById(storeId);

    if (!currentStore) {
      return res.status(404).json({
        message: "Store not found",
      });
    }

    const stores = await StoreModel.find({
      storeType: currentStore.storeType,

      _id: {
        $ne: storeId, // current store বাদ
      },

      isActive: true,
    })
      .sort({ viewCount: -1 })
      .limit(10);

    return res.status(200).json({
      total: stores.length,
      stores,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const nearbyStores = async (req, res) => {
  try {
    const { lat, long, radius = 5 } = req.query;

    if (!lat || !long) {
      return res.status(400).json({
        message: "Latitude and Longitude are required",
      });
    }

    const userLat = Number(lat);
    const userLong = Number(long);
    const maxDistance = Number(radius);

    const stores = await StoreModel.find({
      isActive: true,
      isVerify: true,
    });

    const getDistance = (lat1, lon1, lat2, lon2) => {
      const R = 6371;

      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;

      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
          Math.cos((lat2 * Math.PI) / 180) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);

      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      return R * c;
    };

    const nearbyStores = stores
      .map((store) => {
        const distance = getDistance(userLat, userLong, store.lat, store.long);

        return {
          ...store.toObject(),
          distance: Number(distance.toFixed(2)),
        };
      })
      .filter((store) => store.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance);

    return res.status(200).json({
      total: nearbyStores.length,
      radius: `${maxDistance} KM`,
      stores: nearbyStores,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const registerUser = async (req, res) => {
  try {
    const parsedData = createUserSchema.parse(req.body);
    const email = normalizeEmail(parsedData.email);

    if (await accountExists(email, "USER")) {
      return roleConflict(res, "USER");
    }

    const hashedPassword = await bcrypt.hash(parsedData.password, 10);
    const user = await UserModel.create({
      name: parsedData.name.trim(),
      email,
      phone: parsedData.phone?.trim(),
      password: hashedPassword,
      role: "USER",
      provider: "LOCAL",
      isVerified: false,
      addresses: parsedData.address
        ? [{ ...parsedData.address, isDefault: true }]
        : [],
    });

    let otpSent = true;
    try {
      await sendEmailVerificationOTP(req, user);
    } catch (mailError) {
      otpSent = false;
      console.error("Verification OTP email error:", mailError);
    }

    const { password: _password, ...safeUser } = user.toObject();
    return res.status(201).json({
      success: true,
      message: otpSent
        ? "Registration successful. Verification OTP sent to your email."
        : "Registration successful, but verification email could not be sent. Please try again later.",
      user: safeUser,
    });
  } catch (error) {
    return sendRegisterError(res, error, {
      role: "USER",
      label: "User registration error",
    });
  }
};

const generateStoreQrCode = async (req, res) => {
  try {
    const { storeId } = req.params;

    if (!mongoose.isValidObjectId(storeId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid store id" });
    }

    const store = await StoreModel.findById(storeId);
    if (!store) {
      return res
        .status(404)
        .json({ success: false, message: "Store not found" });
    }

    const userId = String(req.user._id || req.user.id);
    const isAdmin = req.user.role === "ADMIN";
    if (!isAdmin && String(store.userId) !== userId) {
      return res
        .status(403)
        .json({
          success: false,
          message: "You can't generate QR for this store",
        });
    }

    const force = req.query.regenerate === "true";
    if (store.qrCodeUrl && !force) {
      return res.status(200).json({
        success: true,
        message: "QR code already exists",
        qrCodeUrl: store.qrCodeUrl,
      });
    }

    const qrCodeUrl = await generateStoreQr(store);

    return res.status(200).json({
      success: true,
      message: "QR code generated successfully",
      qrCodeUrl,
    });
  } catch (error) {
    console.error("Generate store QR error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to generate QR code" });
  }
};

module.exports = {
  registerAdmin,
  registerOwner,
  createUser,
  allStores,
  singleStore,
  updateStoreAndUser,
  deleteStoreAndUser,
  userBasedStores,
  publicAllStores,
  storeWithProducts,
  registerStoreOwner,
  verifyStoreStatus,
  createStore,
  updateStoreFeatured,
  verifyEmailOTP,
  storesBySubCategory,
  searchStoreNames,
  allStates,
  storesByState,
  recentSearchStores,
  clearRecentSearches,
  relatedStores,
  nearbyStores,
  registerUser,
  generateStoreQrCode,
};
