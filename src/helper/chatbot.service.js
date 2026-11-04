const ChatbotFaqModel = require("../model/chatbot.model.js");
const ChatConversationModel = require("../model/chatConversation.model.js");
const ChatMessageModel = require("../model/chatMessage.model.js");
const { askAi } = require("../helper/chatAi.js");
const { getChatContextForAI } = require("../helper/chatContext.js");

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

// sob FAQ theke best match: je keyword sobcheye lomba match kore
const findBestFaq = (faqs, text) => {
  let best = null;
  let bestLen = 0;
  for (const faq of faqs) {
    for (const raw of faq.keywords || []) {
      const kw = String(raw || "").trim().toLowerCase();
      if (kw && text.includes(kw) && kw.length > bestLen) {
        best = faq;
        bestLen = kw.length;
      }
    }
  }
  return best;
};

const getChatReply = async ({ sessionId, message, name, phoneNumber }) => {
  let conversation = await ChatConversationModel.findOne({ sessionId });

  if (!conversation) {
    if (!name || !phoneNumber) {
      throw httpError(
        400,
        "Name and phone number are required to start a new conversation.",
      );
    }
    conversation = await ChatConversationModel.create({
      sessionId,
      name,
      phoneNumber,
    });
  } else {
    if (!conversation.name && name) conversation.name = name;
    if (!conversation.phoneNumber && phoneNumber)
      conversation.phoneNumber = phoneNumber;
    conversation.lastMessageAt = new Date();
    await conversation.save();
  }

  await ChatMessageModel.create({
    conversation: conversation._id,
    role: "user",
    content: message,
  });

  // 1) FAQ match
  const faqs = await ChatbotFaqModel.find({ isActive: true }).lean();
  const matched = findBestFaq(faqs, message.toLowerCase().trim());

  if (matched) {
    await ChatMessageModel.create({
      conversation: conversation._id,
      role: "assistant",
      content: matched.answer,
    });
    return {
      source: "faq",
      sessionId: conversation.sessionId,
      reply: matched.answer,
    };
  }

  // 2) AI fallback
  const history = await ChatMessageModel.find({ conversation: conversation._id })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  history.reverse();

  const context = await getChatContextForAI();
  const aiReply = await askAi(history, context);

  await ChatMessageModel.create({
    conversation: conversation._id,
    role: "assistant",
    content: aiReply,
  });

  return { source: "ai", sessionId: conversation.sessionId, reply: aiReply };
};

const getConversationHistory = async (sessionId) => {
  const conversation = await ChatConversationModel.findOne({ sessionId }).lean();
  if (!conversation) return [];
  return ChatMessageModel.find({ conversation: conversation._id })
    .sort({ createdAt: 1 })
    .lean();
};

const createFaq = (data) => ChatbotFaqModel.create(data);
const getAllFaqs = () => ChatbotFaqModel.find().sort({ createdAt: -1 });
const getFaqById = (id) => ChatbotFaqModel.findById(id);
const updateFaq = (id, data) =>
  ChatbotFaqModel.findByIdAndUpdate(id, data, { new: true, runValidators: true });
const deleteFaq = (id) => ChatbotFaqModel.findByIdAndDelete(id);

module.exports = {
  getChatReply,
  getConversationHistory,
  createFaq,
  getAllFaqs,
  getFaqById,
  updateFaq,
  deleteFaq,
};