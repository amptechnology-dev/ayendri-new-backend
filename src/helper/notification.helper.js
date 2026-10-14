const {
  getMessaging,
  isFirebaseConfigured,
} = require("../config/firebase.admin.js");
const StoreModel = require("../model/store.model.js");
const NotificationModel = require("../model/notification.model.js");
const StoreVisitModel = require("../model/storeVisit.model.js");
const UserModel = require("../model/user.model.js");

const INVALID_TOKEN_CODES = [
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
];

const notifyStore = async ({ order, type, title, body }) => {
  try {
    await NotificationModel.create({
      storeId: order.storeId,
      type,
      title,
      body,
      orderId: order._id,
    });

    if (!isFirebaseConfigured) return;

    const store = await StoreModel.findById(order.storeId)
      .select("fcmTokens")
      .lean();
    if (!store?.fcmTokens?.length) return;

    const response = await getMessaging().sendEachForMulticast({
      notification: { title, body },
      data: {
        orderId: String(order._id),
        type,
        priceStatus: String(order.priceStatus || "NOT_REQUIRED"),
      },
      tokens: store.fcmTokens,
    });

    const invalidTokens = [];
    response.responses.forEach((r, idx) => {
      if (!r.success && INVALID_TOKEN_CODES.includes(r.error?.code)) {
        invalidTokens.push(store.fcmTokens[idx]);
      }
    });
    if (invalidTokens.length) {
      await StoreModel.updateOne(
        { _id: order.storeId },
        { $pull: { fcmTokens: { $in: invalidTokens } } },
      );
    }
  } catch (err) {
    console.error(`notifyStore (${type}) error:`, err);
  }
};

const notifyNewOrder = (order) =>
  notifyStore({
    order,
    type: "NEW_ORDER",
    title: "New Order Received",
    body:
      order.priceStatus === "AWAITING_QUOTE"
        ? `Order #${order.orderNumber} • Price estimate needed`
        : `Order #${order.orderNumber} • ₹${order.totalAmount}`,
  });

const notifyOrderCancelled = (order) =>
  notifyStore({
    order,
    type: "ORDER_CANCELLED",
    title: "Order Cancelled",
    body: `Order #${order.orderNumber} was cancelled by the customer`,
  });

// USER accept / reject korle STORE ke
const notifyStorePriceResponse = (order, accepted) =>
  notifyStore({
    order,
    type: accepted ? "PRICE_ACCEPTED" : "PRICE_REJECTED",
    title: accepted ? "Price Accepted ✅" : "Price Declined",
    body: accepted
      ? `Customer accepted the price for order #${order.orderNumber} • ₹${order.totalAmount}`
      : `Customer declined the price for order #${order.orderNumber}. Please send a new estimate.`,
  });

const buildUserNotification = (order) => {
  const n = order.orderNumber;
  switch (order.status) {
    case "PENDING":
      return {
        type: "ORDER_PLACED",
        title: "Order Placed 🎉",
        body:
          order.priceStatus === "AWAITING_QUOTE"
            ? `Your order #${n} has been placed. ${order.storeName || "The store"} will share the estimated price soon.`
            : `Your order #${n} has been placed successfully.`,
      };
    case "CONFIRMED":
      return {
        type: "ORDER_CONFIRMED",
        title: "Order Confirmed ✅",
        body: `${order.storeName || "The store"} confirmed your order #${n}.`,
      };
    case "SHIPPED":
      return {
        type: "ORDER_SHIPPED",
        title: "Order Shipped 🚚",
        body: `Your order #${n} is on its way.`,
      };
    case "DELIVERED":
      return {
        type: "ORDER_DELIVERED",
        title: "Order Delivered 📦",
        body: `Your order #${n} has been delivered.`,
      };
    case "CANCELLED": {
      const byStore = order.cancelledBy === "STORE";
      const reason = order.cancelReason ? ` Reason: ${order.cancelReason}` : "";
      return {
        type: "ORDER_CANCELLED",
        title: "Order Cancelled",
        body: byStore
          ? `${order.storeName || "The store"} cancelled your order #${n}.${reason}`
          : `You cancelled your order #${n}.`,
      };
    }
    default:
      return null;
  }
};

// USER ke in-app + push pathay (status ba price quote duto-r jonno)
const sendUserNotification = async (order, content) => {
  try {
    // populateUser: true hole userId object hoye jay
    const userId = order.userId?._id || order.userId;

    await NotificationModel.create({
      userId,
      type: content.type,
      title: content.title,
      body: content.body,
      orderId: order._id,
    });

    if (!isFirebaseConfigured) return;

    const user = await UserModel.findById(userId).select("fcmTokens").lean();
    if (!user?.fcmTokens?.length) return;

    const response = await getMessaging().sendEachForMulticast({
      notification: { title: content.title, body: content.body },
      data: {
        orderId: String(order._id),
        orderNumber: String(order.orderNumber),
        status: String(order.status),
        priceStatus: String(order.priceStatus || "NOT_REQUIRED"),
        type: content.type,
      },
      tokens: user.fcmTokens,
    });

    const invalidTokens = [];
    response.responses.forEach((r, idx) => {
      if (!r.success && INVALID_TOKEN_CODES.includes(r.error?.code)) {
        invalidTokens.push(user.fcmTokens[idx]);
      }
    });
    if (invalidTokens.length) {
      await UserModel.updateOne(
        { _id: userId },
        { $pull: { fcmTokens: { $in: invalidTokens } } },
      );
    }
  } catch (err) {
    console.error(`sendUserNotification (${content.type}) error:`, err);
  }
};

const notifyUserOrderStatus = async (order) => {
  const content = buildUserNotification(order);
  if (!content) return;
  return sendUserNotification(order, content);
};

// store estimate pathale USER ke
const notifyUserPriceQuote = (order) =>
  sendUserNotification(order, {
    type: "PRICE_QUOTED",
    title: "Price Estimate Received 💰",
    body: `${order.storeName || "The store"} sent an estimated price of ₹${order.quote?.total} for order #${order.orderNumber}. Please accept or decline.`,
  });

// ===================== OFFER BANNER -> shudhu oi store visit kora USER =====================
const USER_BATCH_SIZE = 500;
const FCM_BATCH_SIZE = 500;

const VIDEO_URL_REGEX = /\.(mp4|webm|mov)(\?.*)?$/i;

// banner media image/gif na video seta bujhe nao
const getBannerMedia = (banner) => {
  const url = banner.image || null;
  if (!url) return { mediaUrl: null, mediaType: null };
  const isVideo = banner.mediaType === "video" || VIDEO_URL_REGEX.test(url);
  return { mediaUrl: url, mediaType: isVideo ? "video" : "image" };
};

const sendOfferToUserBatch = async ({
  users,
  banner,
  title,
  body,
  mediaUrl,
  mediaType,
}) => {
  await NotificationModel.insertMany(
    users.map((u) => ({
      userId: u._id,
      type: "NEW_OFFER",
      title,
      body,
      bannerId: banner._id,
      mediaUrl,
      mediaType,
    })),
    { ordered: false },
  );

  if (!isFirebaseConfigured) return;

  const tokens = [...new Set(users.flatMap((u) => u.fcmTokens || []))];
  if (!tokens.length) return;

  const pushImage =
    mediaType === "image" && mediaUrl && /^https:\/\//i.test(mediaUrl)
      ? mediaUrl
      : undefined;

  const invalidTokens = [];
  for (let i = 0; i < tokens.length; i += FCM_BATCH_SIZE) {
    const chunk = tokens.slice(i, i + FCM_BATCH_SIZE);

    const response = await getMessaging().sendEachForMulticast({
      notification: {
        title,
        body,
        ...(pushImage ? { imageUrl: pushImage } : {}),
      },
      data: {
        type: "NEW_OFFER",
        bannerId: String(banner._id),
        storeId: String(banner.storeId),
        mediaUrl: mediaUrl || "",
        mediaType: mediaType || "",
      },
      android: {
        priority: "high",
        notification: pushImage ? { imageUrl: pushImage } : {},
      },
      apns: {
        payload: { aps: { "mutable-content": 1 } },
        ...(pushImage ? { fcmOptions: { imageUrl: pushImage } } : {}),
      },
      tokens: chunk,
    });

    response.responses.forEach((r, idx) => {
      if (!r.success && INVALID_TOKEN_CODES.includes(r.error?.code)) {
        invalidTokens.push(chunk[idx]);
      }
    });
  }

  if (invalidTokens.length) {
    await UserModel.updateMany(
      {
        _id: { $in: users.map((u) => u._id) },
        fcmTokens: { $in: invalidTokens },
      },
      { $pull: { fcmTokens: { $in: invalidTokens } } },
    );
  }
};

// offerBanner: true hole shudhu jara ei store visit korechhe (role USER, active) tara pabe
const notifyUsersNewOffer = async (banner) => {
  try {
    const store = await StoreModel.findById(banner.storeId)
      .select("storeName")
      .lean();

    const title = "New Offer 🎁";
    const body = store?.storeName
      ? `${store.storeName}: ${banner.name}`
      : banner.name;

    const { mediaUrl, mediaType } = getBannerMedia(banner);

    // ei store er visit record gulo stream kora hocche
    const visitCursor = StoreVisitModel.find({ storeId: banner.storeId })
      .select("userId")
      .lean()
      .cursor();

    const processBatch = async (userIds) => {
      if (!userIds.length) return;
      try {
        // visitor holeo role USER ar active hote hobe
        const users = await UserModel.find({
          _id: { $in: userIds },
          role: "USER",
          isActive: true,
        })
          .select("_id fcmTokens")
          .lean();
        if (!users.length) return;

        await sendOfferToUserBatch({
          users,
          banner,
          title,
          body,
          mediaUrl,
          mediaType,
        });
      } catch (err) {
        // ekta batch fail korle baki batch gulo jeno atke na jay
        console.error("notifyUsersNewOffer batch error:", err);
      }
    };

    let userIds = [];
    for await (const visit of visitCursor) {
      userIds.push(visit.userId);
      if (userIds.length >= USER_BATCH_SIZE) {
        const current = userIds;
        userIds = [];
        await processBatch(current);
      }
    }
    await processBatch(userIds);
  } catch (err) {
    console.error("notifyUsersNewOffer error:", err);
  }
};

module.exports = {
  notifyNewOrder,
  notifyOrderCancelled,
  notifyUserOrderStatus,
  notifyUserPriceQuote,
  notifyStorePriceResponse,
  notifyUsersNewOffer,
};