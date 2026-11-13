const OrderModel = require("../model/order.model.js");
const mongoose = require("mongoose");
const ChatbotFaqModel = require("../model/chatbot.model.js");
const ChatConversationModel = require("../model/chatConversation.model.js");
const ChatMessageModel = require("../model/chatMessage.model.js");
const StoreModel = require("../model/store.model.js");
const { askAi } = require("../helper/chatAi.js");
const {
  getChatContextForAI,
  getStoreContextForAI,
} = require("../helper/chatContext.js");
const { notifyStoreChat } = require("./notification.helper.js");

const AI_FAIL_TEXT = "Sorry, AI is unavailable right now.";
const TICKET_RX = /\[\[\s*NEED[_\s-]?TICKET\s*\]\]/i;
const TICKET_RX_ALL = new RegExp(TICKET_RX.source, "gi");

// safety net: obvious complaints always get the button, even if the AI forgets the marker
const COMPLAINT_RX =
  /\b(damaged|broken|defective|wrong item|wrong product|not received|never received|fake|cheated|complaint|want (a )?refund|money back|raise (a )?ticket)\b/i;
// OrderModel already import kora ache
const ORDER_FIELDS =
  "orderNumber status totalAmount totalItems items deliveryAddress paymentMethod paymentStatus priceStatus quote createdAt storeId";

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// link the order the customer picked (must exist, and belong to the chat's store)
const linkOrder = async (conv, orderId) => {
  if (!orderId || String(conv.orderId || "") === String(orderId)) return;
  const ok = await OrderModel.exists({
    _id: orderId,
    ...(conv.storeId ? { storeId: conv.storeId } : {}),
  });
  if (ok) conv.orderId = orderId;
};

const getOwnedStoreIds = async (userId) => {
  const stores = await StoreModel.find({ userId }).select("_id").lean();
  return stores.map((s) => s._id);
};

// sobcheye lomba keyword match jitbe. Same lomba hole store er nijer FAQ agey
const findBestFaq = (faqs, text) => {
  let best = null;
  let bestScore = 0;
  for (const faq of faqs) {
    for (const raw of faq.keywords || []) {
      const kw = String(raw || "")
        .trim()
        .toLowerCase();
      if (!kw || !text.includes(kw)) continue;
      const score = kw.length * 2 + (faq.storeId ? 1 : 0);
      if (score > bestScore) {
        best = faq;
        bestScore = score;
      }
    }
  }
  return best;
};

const getChatReply = async ({
  sessionId,
  message,
  name,
  phoneNumber,
  storeId,
  orderId,
  resumeBot,
}) => {
  let conversation = await ChatConversationModel.findOne({ sessionId });

  if (!conversation) {
    if (!name || !phoneNumber) {
      throw httpError(
        400,
        "Name and phone number are required to start a new conversation.",
      );
    }
    conversation = new ChatConversationModel({
      sessionId,
      name,
      phoneNumber,
      storeId: storeId || null,
    });
  } else {
    if (!conversation.name && name) conversation.name = name;
    if (!conversation.phoneNumber && phoneNumber)
      conversation.phoneNumber = phoneNumber;
    if (
      storeId &&
      conversation.mode !== "human" &&
      String(conversation.storeId || "") !== String(storeId)
    ) {
      conversation.storeId = storeId;
    }
  }

  await linkOrder(conversation, orderId);

  // NEW: user "Talk with Assistant" chaple bot abar on
  if (resumeBot && conversation.mode === "human") {
    conversation.mode = "bot";
    conversation.handledBy = null;
    conversation.humanRequested = false;
  }

  conversation.status = "active";
  conversation.lastMessageAt = new Date();
  conversation.lastMessagePreview = message.slice(0, 120);
  if (conversation.mode === "human" || conversation.humanRequested)
    conversation.unreadByStore += 1;
  await conversation.save();

  await ChatMessageModel.create({
    conversation: conversation._id,
    role: "user",
    content: message,
  });

  // ---- HUMAN MODE: bot chup, store reply dibe ----
  if (conversation.mode === "human") {
    return {
      source: "human",
      mode: "human",
      sessionId: conversation.sessionId,
      reply: null,
    };
  }

  const faqFilter = { isActive: true };
  if (storeId) faqFilter.storeId = { $in: [storeId, null] };
  const faqs = await ChatbotFaqModel.find(faqFilter).lean();
  const matched = findBestFaq(faqs, message.toLowerCase().trim());

  if (matched) {
    await ChatMessageModel.create({
      conversation: conversation._id,
      role: "assistant",
      content: matched.answer,
    });
    return {
      source: "faq",
      mode: "bot",
      sessionId: conversation.sessionId,
      reply: matched.answer,
    };
  }

  const history = await ChatMessageModel.find({
    conversation: conversation._id,
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  history.reverse();

  // store er purono reply AI er kache "assistant" hishebe jabe
  const aiHistory = history.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  const [baseContext, storeContext] = await Promise.all([
    getChatContextForAI(),
    getStoreContextForAI(storeId),
  ]);
  const context = [baseContext, storeContext].filter(Boolean).join("\n");

  const rawReply = await askAi(aiHistory, context);
  console.log("RAW AI REPLY:", JSON.stringify(rawReply)); // remove after testing
  const failed = rawReply === AI_FAIL_TEXT;
  const canRaiseTicket =
    !failed && (TICKET_RX.test(rawReply) || COMPLAINT_RX.test(message));
  const aiReply = failed
    ? rawReply
    : rawReply.replace(TICKET_RX_ALL, "").trim() ||
      "I'm sorry, I couldn't resolve this. You can raise a ticket and our team will help you.";

  if (!failed) {
    await ChatMessageModel.create({
      conversation: conversation._id,
      role: "assistant",
      content: aiReply,
      canRaiseTicket,
    });
  }

  if (canRaiseTicket) {
    conversation.ticketAllowed = true; // unlocks ONE ticket for this chat
    await conversation.save();
  }

  return {
    source: "ai",
    mode: "bot",
    sessionId: conversation.sessionId,
    reply: aiReply,
    canRaiseTicket,
  };
};

const getConversationHistory = async (sessionId) => {
  const conversation = await ChatConversationModel.findOne({
    sessionId,
  }).lean();
  if (!conversation) return [];
  return ChatMessageModel.find({ conversation: conversation._id })
    .sort({ createdAt: 1 })
    .lean();
};

// ===================== STORE: FAQ MANAGE =====================
const assertStoreOwner = async (storeId, userId) => {
  const ok = await StoreModel.exists({ _id: storeId, userId });
  if (!ok) throw httpError(403, "Not authorized for this store");
};

// ===================== USER: REQUEST CUSTOMER SERVICE (AGENT) =====================
const requestAgent = async ({
  sessionId,
  name,
  phoneNumber,
  storeId,
  orderId,
}) => {
  let conv = await ChatConversationModel.findOne({ sessionId });

  if (!conv) {
    if (!name || !phoneNumber) {
      throw httpError(
        400,
        "Name and phone number are required to start a new conversation.",
      );
    }
    conv = new ChatConversationModel({
      sessionId,
      name,
      phoneNumber,
      storeId: storeId || null,
    });
  }
  if (!conv.storeId && storeId) conv.storeId = storeId;
  if (!conv.storeId) {
    throw httpError(400, "Customer service is not available right now.");
  }

  await linkOrder(conv, orderId);

  // agent already chat e ache
  if (conv.mode === "human") {
    return {
      mode: "human",
      humanRequested: false,
      sessionId: conv.sessionId,
      reply: null,
    };
  }

  const first = !conv.humanRequested;
  conv.humanRequested = true;
  conv.status = "active";
  conv.lastMessageAt = new Date();
  conv.lastMessagePreview = "Customer requested an agent";
  if (first) conv.unreadByStore += 1;
  await conv.save();

  const reply =
    "Your request has been sent to AYENDRI Help Center. An agent will join this chat shortly. Meanwhile I'm happy to help. 🙏";

  if (first) {
    await ChatMessageModel.create({
      conversation: conv._id,
      role: "assistant",
      content: reply,
    });
    notifyStoreChat({
      storeId: conv.storeId,
      conversationId: conv._id,
      type: "AGENT_REQUESTED",
      title: "Customer needs help 🎧",
      body: `${conv.name || "A customer"} requested customer service in chat`,
    });
  }

  return {
    mode: "bot",
    humanRequested: true,
    sessionId: conv.sessionId,
    reply: first ? reply : null,
  };
};

const pollConversation = async (sessionId, after) => {
  const serverTime = new Date().toISOString();
  const conversation = await ChatConversationModel.findOne({ sessionId })
    .select("_id mode humanRequested")
    .lean();
  if (!conversation)
    return { mode: "bot", humanRequested: false, serverTime, messages: [] };

  let messages = [];
  const afterDate = after ? new Date(after) : null;
  if (afterDate && !isNaN(afterDate)) {
    messages = await ChatMessageModel.find({
      conversation: conversation._id,
      role: "store",
      createdAt: { $gt: afterDate },
    })
      .sort({ createdAt: 1 })
      .lean();
  }
  return {
    mode: conversation.mode,
    humanRequested: !!conversation.humanRequested,
    serverTime,
    messages,
  };
};

// ===================== STORE: INBOX =====================
const findOwnedConversation = async (id, userId) => {
  const conv = await ChatConversationModel.findById(id);
  if (!conv) throw httpError(404, "Conversation not found");
  if (!conv.storeId)
    throw httpError(403, "Not authorized for this conversation");
  await assertStoreOwner(conv.storeId, userId);
  return conv;
};

const listConversations = async ({
  userId,
  storeId,
  mode,
  search,
  page,
  limit,
}) => {
  const owned = await getOwnedStoreIds(userId);
  let storeFilter = { $in: owned };

  if (storeId) {
    if (!owned.some((id) => String(id) === String(storeId))) {
      throw httpError(403, "Not authorized for this store");
    }
    storeFilter = storeId;
  }

  const match = { storeId: storeFilter };
  if (mode === "bot" || mode === "human") match.mode = mode;
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    match.$or = [{ name: rx }, { phoneNumber: rx }];
  }

  const [conversations, total, unreadTotal] = await Promise.all([
    ChatConversationModel.find(match)
      .populate("storeId", "storeName")
      .populate("orderId", "orderNumber status")
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ChatConversationModel.countDocuments(match),
    ChatConversationModel.countDocuments({
      storeId: storeFilter,
      unreadByStore: { $gt: 0 },
    }),
  ]);

  return { conversations, total, unreadTotal };
};

const getConversationMessages = async (id, userId) => {
  const conv = await findOwnedConversation(id, userId);
  if (conv.unreadByStore) {
    conv.unreadByStore = 0;
    await conv.save();
  }
  const [messages, order] = await Promise.all([
    ChatMessageModel.find({ conversation: conv._id }).sort({ createdAt: 1 }).lean(),
    conv.orderId
      ? OrderModel.findOne({ _id: conv.orderId, storeId: conv.storeId }).select(ORDER_FIELDS).lean()
      : null,
  ]);
  return { conversation: conv.toObject(), messages, order };
};

const sendStoreMessage = async (id, userId, content) => {
  const conv = await findOwnedConversation(id, userId);

  const msg = await ChatMessageModel.create({
    conversation: conv._id,
    role: "store",
    content,
    senderId: userId,
  });

  conv.mode = "human"; // store reply dilei bot off
  conv.handledBy = userId;
  conv.status = "active";
  conv.unreadByStore = 0;
  conv.lastMessageAt = new Date();
  conv.lastMessagePreview = `You: ${content.slice(0, 110)}`;
  await conv.save();

  return msg;
};

const updateConversationState = async (id, userId, { mode, status }) => {
  const conv = await findOwnedConversation(id, userId);
  if (mode) {
    conv.mode = mode;
    conv.handledBy = mode === "human" ? userId : null;
  }
  if (status) conv.status = status;
  await conv.save();
  return conv;
};

const findOwnedFaq = async (id, userId) => {
  const faq = await ChatbotFaqModel.findById(id);
  if (!faq) throw httpError(404, "FAQ not found");
  if (!faq.storeId) throw httpError(403, "Not authorized to modify this FAQ");
  await assertStoreOwner(faq.storeId, userId);
  return faq;
};

const createFaq = async (userId, data) => {
  await assertStoreOwner(data.storeId, userId);
  return ChatbotFaqModel.create(data);
};

const listFaqs = async ({ userId, storeId, search, page, limit }) => {
  const owned = await getOwnedStoreIds(userId);
  let storeFilter = { $in: owned };

  if (storeId) {
    if (!owned.some((id) => String(id) === String(storeId))) {
      throw httpError(403, "Not authorized for this store");
    }
    storeFilter = storeId;
  }

  const match = { storeId: storeFilter };
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    match.$or = [{ question: rx }, { answer: rx }, { keywords: rx }];
  }

  const [faqs, total] = await Promise.all([
    ChatbotFaqModel.find(match)
      .populate("storeId", "storeName storeUniqueId")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ChatbotFaqModel.countDocuments(match),
  ]);

  return { faqs, total };
};

const getFaqById = async (id, userId) => {
  await findOwnedFaq(id, userId);
  return ChatbotFaqModel.findById(id)
    .populate("storeId", "storeName storeUniqueId")
    .lean();
};

const updateFaq = async (id, userId, data) => {
  const faq = await findOwnedFaq(id, userId);
  Object.assign(faq, data);
  await faq.save();
  return faq;
};

const deleteFaq = async (id, userId) => {
  const faq = await findOwnedFaq(id, userId);
  await faq.deleteOne();
};

module.exports = {
  getChatReply,
  getConversationHistory,
  pollConversation,
  createFaq,
  listFaqs,
  getFaqById,
  updateFaq,
  deleteFaq,
  listConversations,
  getConversationMessages,
  sendStoreMessage,
  updateConversationState,
  requestAgent,
};
