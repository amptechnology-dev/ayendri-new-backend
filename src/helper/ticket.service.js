const { randomInt } = require("crypto");
const TicketModel = require("../model/ticket.model.js");
const ChatConversationModel = require("../model/chatConversation.model.js");
const ChatMessageModel = require("../model/chatMessage.model.js");
const StoreModel = require("../model/store.model.js");
const UserModel = require("../model/user.model.js");
const { notifyUserTicket } = require("./notification.helper.js");

const STATUSES = ["open", "in_progress", "resolved", "closed"];
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 0/O, 1/I confusing char nai

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

// chat e deya phone er last 10 digit diye customer account khuje ber kore
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
  if (!userId) return; // customer er account nai, shudhu chat e message jabe
  await notifyUserTicket({ userId, ticket, type, title, body });
};

// ticket er update customer er chat e dekhabe (widget e "AYENDRI Help Center" hishebe)
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

// ===================== STORE / SUPPORT =====================
const createTicket = async (
  userId,
  { conversationId, subject, description },
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

  const phoneKey = toPhoneKey(conv.phoneNumber);
  const user = await findUserByPhoneKey(phoneKey);

  const ticket = await TicketModel.create({
    ticketNo: await generateTicketNo(),
    conversation: conv._id,
    storeId: conv.storeId,
    userId: user?._id || null,
    customerName: conv.name,
    phoneNumber: conv.phoneNumber,
    phoneKey,
    subject,
    description,
    raisedBy: userId,
    unreadByUser: 1,
  });

  await postChatNote(
    conv,
    `Ticket #${ticket.ticketNo} has been raised for your complaint. You can track it in Profile > My Tickets.`,
    userId,
  );
  await notifyCustomer(
    ticket,
    "TICKET_RAISED",
    `Ticket #${ticket.ticketNo} raised 🎫`,
    `Your complaint "${subject}" has been registered. Track it in Profile > My Tickets.`,
  );
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
  const messages = await ChatMessageModel.find({
    conversation: ticket.conversation,
  })
    .sort({ createdAt: 1 })
    .lean();
  return { ticket, messages };
};

const updateTicket = async (id, userId, { status, resolution }) => {
  const ticket = await TicketModel.findById(id);
  if (!ticket) throw httpError(404, "Ticket not found");
  await assertStoreOwner(ticket.storeId, userId);

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

    const conv = await ChatConversationModel.findById(ticket.conversation);
    if (conv) await postChatNote(conv, text, userId);
    await notifyCustomer(
      ticket,
      "TICKET_UPDATED",
      `Ticket #${ticket.ticketNo} ${ticket.status === "resolved" ? "resolved ✅" : "updated"}`,
      text,
    );
  }
  return ticket;
};

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
  TicketModel.countDocuments({ ...myMatch(userId, phoneKey), unreadByUser: { $gt: 0 } });

const getMyTicket = async (id, userId, phoneKey) => {
  const ticket = await TicketModel.findOne({ _id: id, ...myMatch(userId, phoneKey) })
    .select("-raisedBy -storeId")
    .lean();
  if (!ticket) throw httpError(404, "Ticket not found");

  if (ticket.unreadByUser) {
    await TicketModel.updateOne({ _id: id }, { $set: { unreadByUser: 0 } });
    ticket.unreadByUser = 0;
  }
  const messages = await ChatMessageModel.find({ conversation: ticket.conversation })
    .sort({ createdAt: 1 })
    .select("role content createdAt")
    .lean();
  return { ticket, messages };
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
};
