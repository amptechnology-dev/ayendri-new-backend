const UserModel = require("../model/user.model.js");
const StoreModel = require("../model/store.model.js");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const {
  updateUserSchema,
  sendPhoneOtpSchema,
  verifyPhoneOtpSchema,
} = require("../schema/user.schema.js");
const transporter = require("../helper/emailtransporter.js");
const { comparePassword } = require("../helper/comparePassword.js");
const { OAuth2Client } = require("google-auth-library");
const {
  generateAuthToken,
  setAuthCookie,
  buildResponseUser,
} = require("../helper/authToken");
const {
  issuePhoneOtp,
  verifyPhoneOtpCode,
  clearPhoneOtp,
} = require("../helper/phoneOtp.js");

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const continueWithGoogle = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({
        message: "Google token is required",
      });
    }
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    const { sub, email, name, picture } = payload;

    let user = await UserModel.findOne({ email, role: "USER" });

    if (!user) {
      user = await UserModel.create({
        name,
        email,
        googleId: sub,
        picture,
        provider: "GOOGLE",
        role: "USER",
        isVerified: true,
      });
    }

    const accessToken = jwt.sign(
      {
        userId: user._id,
        role: user.role,
        email: user.email,
        isActive: user.isActive,
      },
      process.env.TOKEN_SECRET,
      {
        expiresIn: process.env.TOKEN_EXPIRATION,
      },
    );

    res.cookie("login-token", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      path: "/",
      sameSite: "strict",
    });

    return res.status(200).json({
      message: "Google authentication successful",
      token: accessToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        picture: user.picture,
        isActive: user.isActive,
      },
    });
  } catch (error) {
    console.error("Google auth error:", error);
    return res.status(500).json({
      message: "Google authentication failed",
    });
  }
};

const ROLES = ["ADMIN", "STORE", "USER"];
const ROLE_LABELS = { ADMIN: "Admin", STORE: "Store", USER: "User" };

const zodResponse = (res, error) => {
  const errors = error.issues.map((err) => ({
    field: err.path.join("."),
    message: err.message,
  }));
  return res.status(400).json({
    success: false,
    message: errors[0]?.message || "Validation failed",
    errors,
  });
};

// zod schema unknown key strip kore dey, tai role / allowedRoles req.body theke pori
// calling app (web portal: ADMIN + STORE) kon role gulo sign in korte pare seta restrict korte pare
const readRoleScope = (body) => {
  const role =
    typeof body.role === "string" ? body.role.trim().toUpperCase() : null;

  if (role && !ROLES.includes(role)) {
    return { status: 400, error: "Invalid role" };
  }

  let allowedRoles = ROLES;
  if (Array.isArray(body.allowedRoles) && body.allowedRoles.length) {
    allowedRoles = body.allowedRoles
      .map((r) => String(r).trim().toUpperCase())
      .filter((r) => ROLES.includes(r));

    if (!allowedRoles.length) {
      return { status: 400, error: "Invalid allowed roles" };
    }
  }

  if (role && !allowedRoles.includes(role)) {
    return {
      status: 403,
      error: `${ROLE_LABELS[role]} accounts cannot sign in here`,
    };
  }

  return { role, allowedRoles };
};

const findLoginAccounts = (phone, { role, allowedRoles }) =>
  UserModel.find({ phone, role: role || { $in: allowedRoles } });

const notRegisteredMessage = ({ role, allowedRoles }) => {
  const label = role
    ? ROLE_LABELS[role]
    : allowedRoles.map((r) => ROLE_LABELS[r]).join(" or ");
  return `This mobile number is not registered as ${label}`;
};

// POST /api/login/send-otp   body: { phone, allowedRoles?, role? }
const sendLoginOtp = async (req, res) => {
  try {
    const { phone } = sendPhoneOtpSchema.parse(req.body);

    const scope = readRoleScope(req.body);
    if (scope.error) {
      return res
        .status(scope.status)
        .json({ success: false, message: scope.error });
    }

    // account na thakle SMS pathai na (SMS khoroch bachano)
    const accounts = await findLoginAccounts(phone, scope);
    if (!accounts.length) {
      return res
        .status(404)
        .json({ success: false, message: notRegisteredMessage(scope) });
    }

    const result = await issuePhoneOtp(phone, "LOGIN");
    if (!result.ok) {
      return res.status(result.status).json({
        success: false,
        message: result.message,
        retryAfter: result.retryAfter,
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent to your mobile number",
    });
  } catch (error) {
    if (error.name === "ZodError") return zodResponse(res, error);
    console.error("Send login OTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to send OTP. Please try again later.",
    });
  }
};

// POST /api/login/verify-otp   body: { phone, otp, allowedRoles?, role? }
const verifyLoginOtp = async (req, res) => {
  try {
    const { phone, otp } = verifyPhoneOtpSchema.parse(req.body);

    const scope = readRoleScope(req.body);
    if (scope.error) {
      return res
        .status(scope.status)
        .json({ success: false, message: scope.error });
    }

    const accounts = await findLoginAccounts(phone, scope);
    if (!accounts.length) {
      return res
        .status(404)
        .json({ success: false, message: notRegisteredMessage(scope) });
    }

    const check = await verifyPhoneOtpCode(phone, "LOGIN", otp);
    if (!check.ok) {
      return res
        .status(check.status)
        .json({ success: false, message: check.message });
    }

    // ek phone e ekadhik role: OTP consume na kore role select korte bolo
    if (accounts.length > 1) {
      return res.status(400).json({
        success: false,
        message: "Multiple accounts found for this number. Please select a role.",
        requireRole: true,
        roles: accounts.map((a) => a.role),
      });
    }

    const user = accounts[0];

    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "Your account is inactive. Please contact support.",
      });
    }

    // STORE login: store must be active and verified
    if (user.role === "STORE") {
      const store = await StoreModel.findOne({ userId: user._id })
        .select("isActive isVerify")
        .lean();

      if (!store) {
        return res.status(404).json({
          success: false,
          message: "Store not found for this account",
        });
      }

      if (!store.isActive) {
        return res.status(403).json({
          success: false,
          message: "Your store is inactive. Please contact with super admin.",
        });
      }

      if (!store.isVerify) {
        return res.status(403).json({
          success: false,
          message: "Your store is not verified yet. Please wait for approval.",
        });
      }
    }

    // OTP diye phone owner proof hoye gelo, tai account verified dhora hoy
    if (!user.isVerified) {
      await UserModel.updateOne(
        { _id: user._id },
        { $set: { isVerified: true } },
      );
      user.isVerified = true;
    }

    await clearPhoneOtp(phone, "LOGIN");

    const token = generateAuthToken(user);
    setAuthCookie(res, token);

    return res.status(200).json({
      message: "Login successful",
      token,
      user: buildResponseUser(user),
    });
  } catch (error) {
    if (error.name === "ZodError") return zodResponse(res, error);
    console.error("Verify login OTP error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error logging in user" });
  }
};

const LogOut = async (req, res) => {
  try {
    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    res.clearCookie("login-token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    });

    return res.status(200).json({
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("Logout error:", error);
    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const GetProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await UserModel.findById(userId)
      .select("-password")
      .select("-shiftType")
      .select("-isActive");
    return res
      .status(200)
      .json({ message: "User profile fetched successfully", user });
  } catch (error) {
    console.error("Error fetching user profile:", error);
    return res
      .status(500)
      .json({ message: "Error fetching user profile", error });
  }
};

const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const parsedData = updateUserSchema.parse(req.body);
    const { name, phone } = parsedData;
    const existingUser = await UserModel.findById(userId);
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const updateFields = {};
    if (name !== undefined) updateFields.name = name.trim();
    if (phone !== undefined) updateFields.phone = phone; // already normalized by schema

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided to update",
      });
    }

    const updatedUser = await UserModel.findByIdAndUpdate(
      userId,
      { $set: updateFields },
      { new: true, runValidators: true },
    ).select("-password");

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }
    const tokenPayload = {
      userId: updatedUser._id,
      role: updatedUser.role,
      email: updatedUser.email,
      phone: updatedUser.phone,
      isActive: updatedUser.isActive,
    };

    if (updatedUser.role === "USER" && updatedUser.address) {
      tokenPayload.address = {
        addressLine: updatedUser.address.addressLine,
        area: updatedUser.address.area,
        city: updatedUser.address.city,
        state: updatedUser.address.state,
        pincode: updatedUser.address.pincode,
        country: updatedUser.address.country,
      };
    }

    const token = jwt.sign(tokenPayload, process.env.TOKEN_SECRET, {
      expiresIn: process.env.TOKEN_EXPIRATION,
    });

    res.cookie("login-token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      path: "/",
      sameSite: "strict",
    });

    const responseUser = {
      id: updatedUser._id,
      name: updatedUser.name,
      email: updatedUser.email,
      role: updatedUser.role,
      phone: updatedUser.phone,
      isActive: updatedUser.isActive,
    };
    if (updatedUser.role === "USER" && updatedUser.address) {
      responseUser.address = updatedUser.address;
    }
    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      token,
      user: responseUser,
    });
  } catch (error) {
    if (error.name === "ZodError") {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: error.issues.map((err) => ({
          field: err.path.join("."),
          message: err.message,
        })),
      });
    }
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
      return res.status(409).json({
        success: false,
        message: "This mobile number is already registered for this role",
      });
    }
    console.error("Update profile error:", error);
    return res.status(500).json({
      success: false,
      message: "Error updating user profile",
    });
  }
};

// Update Password
const updatePassword = async (req, res) => {
  try {
    const userId = req.user._id; // Get user ID from token
    const { oldPassword, newPassword, confirmPassword } = req.body;
    if (!oldPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({
        message: "New password should be at least 8 characters long",
      });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        message: "Password do not match",
      });
    }
    const user = await UserModel.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    // [FIX] await chilo na, Promise truthy hoy tai je kono old password cholto
    const isMatch = await comparePassword(oldPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Old password is incorrect" });
    }
    const salt = bcrypt.genSaltSync(10);
    const hashedNewPassword = await bcrypt.hash(newPassword, salt);
    user.password = hashedNewPassword;
    await user.save();
    res
      .status(200)
      .json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    console.error("Error updating password:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Reset Password link
const resetpasswordlink = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res
        .status(400)
        .json({ status: false, message: "Email field is required" });
    }
    const user = await UserModel.findOne({ email });
    if (!user) {
      return res
        .status(404)
        .json({ status: false, message: "Email doesn't exist" });
    }
    // Generate token for password reset
    const secret = user._id + process.env.TOKEN_SECRET;
    const token = jwt.sign({ userID: user._id }, secret, {
      expiresIn: process.env.TOKEN_EXPIRATION,
    });
    // Reset Link and this link generate by frontend developer
    // FRONTEND_HOST_FORGETPASSWORD = http://localhost:3004/forgetpassword
    const resetLink = `${process.env.FRONTEND_URL}/${user._id}/${token}`;
    // Send password reset email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: "Password Reset Link",
      html: `<p>Hello ${user.name},</p><p>Please <a href="${resetLink}">Click here</a> to reset your password.</p>`,
    });
    // Send success response
    res.status(200).json({
      status: true,
      message: "Password reset email sent. Please check your email.",
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      status: false,
      message: "Unable to send password reset email. Please try again later.",
    });
  }
};

// Forget Password
const forgetPassword = async (req, res) => {
  try {
    const { id, token } = req.params;
    const { password, confirmPassword } = req.body;
    const user = await UserModel.findById(id);
    if (!user) {
      return res.status(404).json({ status: false, message: "User not found" });
    }
    // Validate token check
    const new_secret = user._id + process.env.TOKEN_SECRET;
    jwt.verify(token, new_secret);

    if (!password || !confirmPassword) {
      return res.status(400).json({
        status: false,
        message: "New Password and Confirm New Password are required",
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        status: false,
        message: "New Password and Confirm New Password don't match",
      });
    }
    // Generate salt and hash new password
    const salt = await bcrypt.genSalt(10);
    const newHashPassword = await bcrypt.hash(password, salt);

    // Update user's password
    await UserModel.findByIdAndUpdate(user._id, {
      $set: { password: newHashPassword },
    });

    // Send success response
    res
      .status(200)
      .json({ status: "success", message: "Password reset successfully" });
  } catch (error) {
    console.log("Error updating password...", error);
    return res
      .status(500)
      .json({ status: "failed", message: "Token expired or invalid" });
  }
};

module.exports = {
  sendLoginOtp,
  verifyLoginOtp,
  GetProfile,
  updateProfile,
  LogOut,
  resetpasswordlink,
  forgetPassword,
  updatePassword,
  continueWithGoogle,
};