const { randomInt, randomUUID } = require("crypto");
const TicketModel = require("../model/ticket.model.js");
const ChatConversationModel = require("../model/chatConversation.model.js");
const ChatMessageModel = require("../model/chatMessage.model.js");
const StoreModel = require("../model/store.model.js");
const OrderModel = require("../model/order.model.js");
const UserModel = require("../model/user.model.js");
const {
  notifyUserTicket,
  notifyStoreTicket,
} = require("./notification.helper.js");
const { notifyTicketParties } = require("./ticketComms.js");
const { uploadToR2, deleteFromR2 } = require("./upload.js");
const STATUSES = ["open", "in_progress", "resolved", "closed"];
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

// order er ja ja dekhabo (pickupAddress kokhono na)
const ORDER_FIELDS =
  "orderNumber status totalAmount totalItems items deliveryAddress paymentMethod paymentStatus priceStatus quote createdAt userId storeId";

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toPhoneKey = (p) =>
  String(p || "")
    .replace(/\D/g, "")
    .slice(-10);

const generateTicketNo = async () => {
  for (let i = 0; i < 10; i++) {
    const no = Array.from(
      { length: 5 },
      () => ALPHABET[randomInt(ALPHABET.length)],
    ).join("");
    if (!(await TicketModel.exists({ ticketNo: no }))) return no;
  }
  throw httpError(500, "Could not generate ticket number");
};

const assertStoreOwner = async (storeId, userId) => {
  const ok = await StoreModel.exists({ _id: storeId, userId });
  if (!ok) throw httpError(403, "Not authorized for this store");
};

const getOwnedStoreIds = async (userId) => {
  const stores = await StoreModel.find({ userId }).select("_id").lean();
  return stores.map((s) => s._id);
};

const findUserByPhoneKey = async (phoneKey) => {
  if (!phoneKey) return null;
  return UserModel.findOne({ role: "USER", phone: new RegExp(`${phoneKey}$`) })
    .select("_id")
    .lean();
};

const notifyCustomer = async (ticket, type, title, body) => {
  let userId = ticket.userId;
  if (!userId) {
    const user = await findUserByPhoneKey(ticket.phoneKey);
    userId = user?._id;
    if (userId)
      await TicketModel.updateOne({ _id: ticket._id }, { $set: { userId } });
  }
  if (!userId) return;
  await notifyUserTicket({ userId, ticket, type, title, body });
};

const postChatNote = async (conv, content, senderId) => {
  await ChatMessageModel.create({
    conversation: conv._id,
    role: "store",
    content,
    senderId,
  });
  conv.lastMessageAt = new Date();
  conv.lastMessagePreview = content.slice(0, 120);
  await conv.save();
};

const IMAGE_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// file name user er originalname theke na, mimetype theke banai (path/extension trick ektu safe)
const saveImage = async (file) => {
  const ext = IMAGE_EXT[file.mimetype];
  if (!ext) throw httpError(400, "Only JPG, PNG or WEBP images are allowed");
  const key = `tickets/${Date.now()}-${randomUUID()}.${ext}`;
  const url = await uploadToR2(file.buffer, key, file.mimetype);
  return { key, url };
};

// ticket create fail hole R2 te orphan image jemon na thake
const removeImages = (items) =>
  Promise.allSettled(items.map((i) => deleteFromR2(i.key)));

const safeNotifyStore = (ticket, type, title, body) =>
  notifyStoreTicket({ storeId: ticket.storeId, ticket, type, title, body });

// ===================== STORE / SUPPORT =====================
const createTicket = async (
  userId,
  { conversationId, orderId, subject, description },
) => {
  const conv = await ChatConversationModel.findById(conversationId);
  if (!conv) throw httpError(404, "Conversation not found");
  if (!conv.storeId)
    throw httpError(403, "Not authorized for this conversation");
  await assertStoreOwner(conv.storeId, userId);

  const existing = await TicketModel.exists({
    conversation: conv._id,
    status: { $in: ["open", "in_progress"] },
  });
  if (existing)
    throw httpError(409, "An open ticket already exists for this chat");

  // order: body theke, na hole chat e customer je order select korechhe
  let order = null;
  const wantedOrderId = orderId || conv.orderId;
  if (wantedOrderId) {
    order = await OrderModel.findOne({
      _id: wantedOrderId,
      storeId: conv.storeId,
    })
      .select("_id orderNumber")
      .lean();
  }

  const phoneKey = toPhoneKey(conv.phoneNumber);
  const user = await findUserByPhoneKey(phoneKey);

  const ticket = await TicketModel.create({
    ticketNo: await generateTicketNo(),
    conversation: conv._id,
    storeId: conv.storeId,
    userId: user?._id || null,
    orderId: order?._id || null,
    orderNumber: order ? String(order.orderNumber || "") : "",
    customerName: conv.name,
    phoneNumber: conv.phoneNumber,
    phoneKey,
    subject,
    description,
    raisedBy: userId,
    unreadByUser: 1,
  });

  const orderPart = ticket.orderNumber
    ? ` for order #${ticket.orderNumber}`
    : "";
  await postChatNote(
    conv,
    `Ticket #${ticket.ticketNo} has been raised${orderPart}. You can track it in Profile > My Tickets.`,
    userId,
  );
  await notifyCustomer(
    ticket,
    "TICKET_RAISED",
    `Ticket #${ticket.ticketNo} raised 🎫`,
    `Your complaint "${subject}"${orderPart} has been registered. Track it in Profile > My Tickets.`,
  );
  notifyTicketParties(ticket, "RAISED");
  return ticket;
};

const listStoreTickets = async ({ userId, status, search, page, limit }) => {
  const owned = await getOwnedStoreIds(userId);
  const match = { storeId: { $in: owned } };
  if (STATUSES.includes(status)) match.status = status;
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    match.$or = [
      { ticketNo: rx },
      { customerName: rx },
      { phoneNumber: rx },
      { subject: rx },
      { orderNumber: rx },
    ];
  }

  const [tickets, total, openCount] = await Promise.all([
    TicketModel.find(match)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    TicketModel.countDocuments(match),
    TicketModel.countDocuments({
      storeId: { $in: owned },
      status: { $in: ["open", "in_progress"] },
    }),
  ]);
  return { tickets, total, openCount };
};

const getStoreTicket = async (id, userId) => {
  const ticket = await TicketModel.findById(id).lean();
  if (!ticket) throw httpError(404, "Ticket not found");
  await assertStoreOwner(ticket.storeId, userId);

  const [messages, order] = await Promise.all([
    ticket.conversation
      ? ChatMessageModel.find({ conversation: ticket.conversation })
          .sort({ createdAt: 1 })
          .lean()
      : [],
    ticket.orderId
      ? OrderModel.findOne({ _id: ticket.orderId, storeId: ticket.storeId })
          .select(ORDER_FIELDS)
          .lean()
      : null,
  ]);
  return { ticket, messages, order };
};

const updateTicket = async (id, userId, { status, resolution }) => {
  const ticket = await TicketModel.findById(id);
  if (!ticket) throw httpError(404, "Ticket not found");
  await assertStoreOwner(ticket.storeId, userId);

  if (ticket.status === "closed") {
    throw httpError(
      400,
      "This ticket was closed by the customer and can't be modified",
    );
  }
  if (status === "closed") {
    throw httpError(400, "Only the customer can close a ticket");
  }

  const prevStatus = ticket.status;
  const prevResolution = ticket.resolution;
  if (resolution !== undefined) ticket.resolution = resolution;
  if (status) ticket.status = status;

  if (ticket.status === "resolved" && !ticket.resolution) {
    throw httpError(400, "Please write the solution before resolving");
  }

  const done = ticket.status === "resolved" || ticket.status === "closed";
  ticket.resolvedAt = done ? ticket.resolvedAt || new Date() : null;

  const statusChanged = ticket.status !== prevStatus;
  const solutionChanged = ticket.resolution !== prevResolution;
  if (statusChanged || solutionChanged) ticket.unreadByUser += 1;
  await ticket.save();

  if (statusChanged) {
    const no = `#${ticket.ticketNo}`;
    const text = {
      open: `Ticket ${no} has been reopened.`,
      in_progress: `Ticket ${no} is now being worked on by our support team.`,
      resolved: `Ticket ${no} has been resolved.\nSolution: ${ticket.resolution}`,
      closed: `Ticket ${no} has been closed.`,
    }[ticket.status];

    const conv = ticket.conversation
      ? await ChatConversationModel.findById(ticket.conversation)
      : null;
    if (conv) await postChatNote(conv, text, userId);
    await notifyCustomer(
      ticket,
      "TICKET_UPDATED",
      `Ticket #${ticket.ticketNo} ${ticket.status === "resolved" ? "resolved ✅" : "updated"}`,
      text,
    );
    notifyTicketParties(ticket, "UPDATED");
  }
  return ticket;
};

// ===================== CUSTOMER (My Tickets) =====================
const myMatch = (userId, phoneKey) => ({
  $or: [{ userId }, ...(phoneKey ? [{ phoneKey }] : [])],
});

const listMyTickets = async ({ userId, phoneKey, page, limit }) => {
  const match = myMatch(userId, phoneKey);
  const [tickets, total] = await Promise.all([
    TicketModel.find(match)
      .select("-raisedBy -storeId -conversation")
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    TicketModel.countDocuments(match),
  ]);
  return { tickets, total };
};

const getMyUnread = async (userId, phoneKey) =>
  TicketModel.countDocuments({
    ...myMatch(userId, phoneKey),
    unreadByUser: { $gt: 0 },
  });

const getMyTicket = async (id, userId, phoneKey) => {
  const ticket = await TicketModel.findOne({
    _id: id,
    ...myMatch(userId, phoneKey),
  })
    .select("-raisedBy -storeId")
    .lean();
  if (!ticket) throw httpError(404, "Ticket not found");

  if (ticket.unreadByUser) {
    await TicketModel.updateOne({ _id: id }, { $set: { unreadByUser: 0 } });
    ticket.unreadByUser = 0;
  }

  const [messages, order] = await Promise.all([
    ticket.conversation
      ? ChatMessageModel.find({ conversation: ticket.conversation })
          .sort({ createdAt: 1 })
          .select("role content createdAt")
          .lean()
      : [],
    ticket.orderId
      ? OrderModel.findOne({ _id: ticket.orderId, userId })
          .select(ORDER_FIELDS)
          .lean()
      : null,
  ]);
  return { ticket, messages, order };
};

const listMyOrdersForTicket = async (userId) => {
  const orders = await OrderModel.find({ userId })
    .select("orderNumber status storeName createdAt items.name")
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  return orders.map((o) => ({
    _id: o._id,
    orderNumber: o.orderNumber,
    status: o.status,
    storeName: o.storeName || "",
    createdAt: o.createdAt,
    itemNames: (o.items || []).slice(0, 2).map((i) => i.name),
  }));
};

const createMyTicket = async (
  userId,
  { orderId, subject, description },
  files = [],
) => {
  const [user, order] = await Promise.all([
    UserModel.findById(userId).select("name phone").lean(),
    OrderModel.findOne({ _id: orderId, userId })
      .select("_id orderNumber storeId")
      .lean(),
  ]);
  if (!user) throw httpError(404, "User not found");
  if (!order) throw httpError(404, "Order not found");

  const duplicate = await TicketModel.exists({
    userId,
    orderId: order._id,
    status: { $in: ["open", "in_progress"] },
  });
  if (duplicate)
    throw httpError(409, "You already have an open ticket for this order");

  // validation sob pass korar por-i upload (faltu upload এড়াতে)
  const results = await Promise.allSettled(files.map(saveImage));
  const uploaded = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);

  if (uploaded.length !== files.length) {
    results
      .filter((r) => r.status === "rejected")
      .forEach((r) => console.error("Ticket image upload:", r.reason));
    await removeImages(uploaded);
    throw httpError(502, "Image upload failed, please try again");
  }

  let ticket;
  try {
    ticket = await TicketModel.create({
      ticketNo: await generateTicketNo(),
      storeId: order.storeId,
      userId,
      orderId: order._id,
      orderNumber: String(order.orderNumber || ""),
      customerName: user.name || "",
      phoneNumber: user.phone || "",
      phoneKey: toPhoneKey(user.phone),
      subject,
      description,
      images: uploaded.map((i) => i.url),
      createdBy: "USER",
      raisedBy: userId,
      unreadByUser: 0,
    });
  } catch (err) {
    await removeImages(uploaded);
    throw err;
  }

  safeNotifyStore(
    ticket,
    "TICKET_RAISED_BY_USER",
    `New ticket #${ticket.ticketNo} 🎫`,
    `${ticket.customerName || "A customer"} raised a complaint for order #${ticket.orderNumber}`,
  );
  notifyTicketParties(ticket, "RAISED");
  return ticket;
};

const closeMyTicket = async (id, userId, phoneKey, { rating, comment }) => {
  const existing = await TicketModel.findOne({
    _id: id,
    ...myMatch(userId, phoneKey),
  })
    .select("status resolvedAt")
    .lean();
  if (!existing) throw httpError(404, "Ticket not found");
  if (existing.status === "closed")
    throw httpError(409, "Ticket is already closed");

  // status != closed condition: double click / race e duplicate feedback hobe na
  const ticket = await TicketModel.findOneAndUpdate(
    { _id: id, ...myMatch(userId, phoneKey), status: { $ne: "closed" } },
    {
      $set: {
        status: "closed",
        closedBy: "USER",
        resolvedAt: existing.resolvedAt || new Date(),
        unreadByUser: 0,
        feedback: { rating, comment: comment || "", at: new Date() },
      },
    },
    { returnDocument: "after" },
  );
  if (!ticket) throw httpError(409, "Ticket is already closed");

  safeNotifyStore(
    ticket,
    "TICKET_CLOSED_BY_USER",
    `Ticket #${ticket.ticketNo} closed (${rating}★)`,
    comment
      ? `Customer feedback: ${comment.slice(0, 120)}`
      : "Customer closed the ticket",
  );
  notifyTicketParties(ticket, "CLOSED");
  return ticket;
};

module.exports = {
  toPhoneKey,
  createTicket,
  listStoreTickets,
  getStoreTicket,
  updateTicket,
  listMyTickets,
  getMyUnread,
  getMyTicket,
  listMyOrdersForTicket,
  createMyTicket,
  closeMyTicket,
};
