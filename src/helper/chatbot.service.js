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

const AI_FAIL_TEXT = "Sorry, AI is unavailable right now.";

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
      const kw = String(raw || "").trim().toLowerCase();
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

// ===================== PUBLIC CHAT =====================
const getChatReply = async ({ sessionId, message, name, phoneNumber, storeId }) => {
  let conversation = await ChatConversationModel.findOne({ sessionId });

  if (!conversation) {
    if (!name || !phoneNumber) {
      throw httpError(400, "Name and phone number are required to start a new conversation.");
    }
    conversation = await ChatConversationModel.create({
      sessionId,
      name,
      phoneNumber,
      storeId: storeId || null,
    });
  } else {
    if (!conversation.name && name) conversation.name = name;
    if (!conversation.phoneNumber && phoneNumber) conversation.phoneNumber = phoneNumber;
    conversation.lastMessageAt = new Date();
    await conversation.save();
  }

  await ChatMessageModel.create({
    conversation: conversation._id,
    role: "user",
    content: message,
  });

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
    return { source: "faq", sessionId: conversation.sessionId, reply: matched.answer };
  }

  // 2) AI fallback
  const history = await ChatMessageModel.find({ conversation: conversation._id })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  history.reverse();

  const [baseContext, storeContext] = await Promise.all([
    getChatContextForAI(),
    getStoreContextForAI(storeId),
  ]);
  const context = [baseContext, storeContext].filter(Boolean).join("\n");

  const aiReply = await askAi(history, context);

  if (aiReply !== AI_FAIL_TEXT) {
    await ChatMessageModel.create({
      conversation: conversation._id,
      role: "assistant",
      content: aiReply,
    });
  }

  return { source: "ai", sessionId: conversation.sessionId, reply: aiReply };
};

const getConversationHistory = async (sessionId) => {
  const conversation = await ChatConversationModel.findOne({ sessionId }).lean();
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
  return ChatbotFaqModel.findById(id).populate("storeId", "storeName storeUniqueId").lean();
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
  createFaq,
  listFaqs,
  getFaqById,
  updateFaq,
  deleteFaq,
};