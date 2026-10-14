const router = require("express").Router();

const {
  login,
  GetProfile,
  updateProfile,
  LogOut,
  updatePassword,
  continueWithGoogle,
} = require("../controller/login.controller.js");
const {
  sendForgotPasswordOtp,
  verifyForgotPasswordOtp,
  resetPasswordWithOtp,
  loginWithOtp,
} = require("../controller/forgotPassword.controller.js");
const {
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
} = require("../controller/address.controller.js");
const verifyJwt = require("../middleware/verifiyUser.js");

router.post("/", login);
router.get("/profile-page", verifyJwt, GetProfile);
router.put("/profile-page", verifyJwt, updateProfile);
router.post("/logout", verifyJwt, LogOut);
router.post("/update-password", verifyJwt, updatePassword);
router.post("/continue-with-google", continueWithGoogle);

// ---------- FORGOT PASSWORD (OTP) ----------
router.post("/forgot-password/send-otp", sendForgotPasswordOtp);
router.post("/forgot-password/verify-otp", verifyForgotPasswordOtp);
router.post("/forgot-password/reset-password", resetPasswordWithOtp);
router.post("/forgot-password/login-with-otp", loginWithOtp);

// -------------Address Routes --------
router.get("/addresses", verifyJwt, getAddresses);
router.post("/addresses", verifyJwt, addAddress);
router.put("/addresses/:addressId", verifyJwt, updateAddress);
router.delete("/addresses/:addressId", verifyJwt, deleteAddress);


module.exports = router;