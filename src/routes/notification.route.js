const router = require("express").Router();
const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const {
  saveFcmToken,
  removeFcmToken,
  getNotifications,
  markNotificationsRead,
  clearAllNotifications,
  clearSingleNotification,
} = require("../controller/notification.controller.js");

router.post("/fcm-token", verifyJwt, authorize("STORE", "USER"), saveFcmToken);
router.post(
  "/fcm-token/remove",
  verifyJwt,
  authorize("STORE", "USER"),
  removeFcmToken,
);
router.get("/", verifyJwt, authorize("STORE", "USER"), getNotifications);
router.patch(
  "/read",
  verifyJwt,
  authorize("STORE", "USER"),
  markNotificationsRead,
);
router.delete(
  "/clear-all",
  verifyJwt,
  authorize("STORE", "USER"),
  clearAllNotifications,
);
router.delete(
  "/clear-single/:id",
  verifyJwt,
  authorize("STORE", "USER"),
  clearSingleNotification,
);

module.exports = router;
