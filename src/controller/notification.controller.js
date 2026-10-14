const mongoose = require("mongoose");
const NotificationModel = require("../model/notification.model.js");
const StoreModel = require("../model/store.model.js");
const UserModel = require("../model/user.model.js");

const getUserId = (req) => req.user?._id || req.user?.id;

// req.user e role na thakle DB theke ana hobe
const getRole = async (req) =>
  req.user?.role ||
  (await UserModel.findById(getUserId(req)).select("role").lean())?.role;

const getOwnedStoreIds = async (userId) => {
  const stores = await StoreModel.find({ userId }).select("_id").lean();
  return stores.map((s) => s._id);
};

// role onujayi kon notification dekhbe: STORE -> nijer store gulor, USER -> nijer
const getNotificationScope = async (req) => {
  const userId = getUserId(req);
  const role = await getRole(req);

  if (role === "STORE") {
    const ownedStoreIds = await getOwnedStoreIds(userId);
    return { storeId: { $in: ownedStoreIds } };
  }
  return { userId };
};

const saveFcmToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "Token required" });
    }

    const userId = getUserId(req);
    const role = await getRole(req);

    if (role === "STORE") {
      const ownedStoreIds = await getOwnedStoreIds(userId);
      // ei device er token ager kono USER account e thakle shoriye dao
      await UserModel.updateMany(
        { fcmTokens: token },
        { $pull: { fcmTokens: token } },
      );
      await StoreModel.updateMany(
        { _id: { $in: ownedStoreIds } },
        { $addToSet: { fcmTokens: token } },
      );
    } else {
      // ei token onno user/store e thakle shoriye dao, na hole onner notification ei device e ashbe
      await StoreModel.updateMany(
        { fcmTokens: token },
        { $pull: { fcmTokens: token } },
      );
      await UserModel.updateMany(
        { fcmTokens: token, _id: { $ne: userId } },
        { $pull: { fcmTokens: token } },
      );
      await UserModel.updateOne(
        { _id: userId },
        { $addToSet: { fcmTokens: token } },
      );
    }

    return res.status(200).json({ success: true, message: "Token registered" });
  } catch (error) {
    console.error("saveFcmToken:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

// logout er somoy call korbe, jate logout er por notification na ashe
const removeFcmToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "Token required" });
    }

    const userId = getUserId(req);
    const role = await getRole(req);

    if (role === "STORE") {
      const ownedStoreIds = await getOwnedStoreIds(userId);
      await StoreModel.updateMany(
        { _id: { $in: ownedStoreIds } },
        { $pull: { fcmTokens: token } },
      );
    } else {
      await UserModel.updateOne(
        { _id: userId },
        { $pull: { fcmTokens: token } },
      );
    }

    return res.status(200).json({ success: true, message: "Token removed" });
  } catch (error) {
    console.error("removeFcmToken:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const getNotifications = async (req, res) => {
  try {
    const scope = await getNotificationScope(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);

    const [notifications, unreadCount] = await Promise.all([
      NotificationModel.find(scope)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      NotificationModel.countDocuments({ ...scope, isRead: false }),
    ]);

    return res.status(200).json({ success: true, notifications, unreadCount });
  } catch (error) {
    console.error("getNotifications:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const markNotificationsRead = async (req, res) => {
  try {
    const scope = await getNotificationScope(req);
    const { notificationIds } = req.body || {};

    const filter = { ...scope, isRead: false };
    if (Array.isArray(notificationIds) && notificationIds.length) {
      filter._id = { $in: notificationIds };
    }

    await NotificationModel.updateMany(filter, { $set: { isRead: true } });
    return res.status(200).json({ success: true, message: "Marked as read" });
  } catch (error) {
    console.error("markNotificationsRead:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

// DELETE /clear-all -> logged-in user/store er sob notification delete
const clearAllNotifications = async (req, res) => {
  try {
    const scope = await getNotificationScope(req);
    const result = await NotificationModel.deleteMany(scope);

    return res.status(200).json({
      success: true,
      message: "All notifications cleared",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("clearAllNotifications:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

// DELETE /clear-single/:id -> ekta specific notification delete
const clearSingleNotification = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid notification id" });
    }

    // scope diye filter korchi, jate onner notification delete na kora jay
    const scope = await getNotificationScope(req);
    const result = await NotificationModel.deleteOne({ _id: id, ...scope });

    if (result.deletedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Notification not found" });
    }

    return res
      .status(200)
      .json({ success: true, message: "Notification deleted" });
  } catch (error) {
    console.error("clearSingleNotification:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  saveFcmToken,
  removeFcmToken,
  getNotifications,
  markNotificationsRead,
  clearAllNotifications,
  clearSingleNotification,
};