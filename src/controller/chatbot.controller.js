const mongoose = require("mongoose");
const { z } = require("zod");
const chatbotService = require("../helper/chatbot.service");

const getUserId = (req) => req.user?._id || req.user?.id;
const objectId = z
  .string()
  .refine((v) => mongoose.isValidObjectId(v), "Invalid id");

const chatSchema = z.object({
  sessionId: z.string().trim().min(8, "sessionId is required").max(64),
  message: z.string().trim().min(1, "Message is required").max(1000),
  name: z.string().trim().max(100).optional(),
  phoneNumber: z.string().trim().max(20).optional(),
  storeId: objectId.optional(),
  orderId: objectId.optional(),
  resumeBot: z.boolean().optional(),
});

const requestAgentSchema = z.object({
  sessionId: z.string().trim().min(8).max(64),
  name: z.string().trim().max(100).optional(),
  phoneNumber: z.string().trim().max(20).optional(),
  storeId: objectId.optional(),
  orderId: objectId.optional(),
});

const faqSchema = z.object({
  storeId: objectId,
  question: z.string().trim().min(1, "Question is required").max(500),
  keywords: z
    .array(z.string().trim().min(1))
    .min(1, "Add at least one keyword")
    .max(30),
  answer: z.string().trim().min(1, "Answer is required").max(2000),
  category: z.string().trim().max(50).optional(),
  isActive: z.boolean().optional(),
});

const storeMessageSchema = z.object({
  content: z.string().trim().min(1, "Message is required").max(1000),
});

const conversationStateSchema = z
  .object({
    mode: z.enum(["bot", "human"]).optional(),
    status: z.enum(["active", "closed"]).optional(),
  })
  .refine((d) => d.mode || d.status, "mode or status is required");

const faqUpdateSchema = faqSchema.omit({ storeId: true }).partial();

const handleError = (res, error, label) => {
  if (error.name === "ZodError") {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    });
  }
  if (error.status) {
    return res
      .status(error.status)
      .json({ success: false, message: error.message });
  }
  console.error(`${label}:`, error);
  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

const checkId = (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid id" });
    return false;
  }
  return true;
};

// ---------- PUBLIC ----------
const chat = async (req, res) => {
  try {
    const body = chatSchema.parse(req.body);
    const result = await chatbotService.getChatReply(body);
    return res.status(200).json({
      success: true,
      message: "Reply generated successfully",
      data: result,
    });
  } catch (error) {
    return handleError(res, error, "Chat Error");
  }
};

const getConversationHistory = async (req, res) => {
  try {
    const data = await chatbotService.getConversationHistory(
      req.params.sessionId,
    );
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "Chat History Error");
  }
};

// ---------- STORE ----------
const createChatbot = async (req, res) => {
  try {
    const body = faqSchema.parse(req.body);
    const faq = await chatbotService.createFaq(getUserId(req), body);
    return res
      .status(201)
      .json({ success: true, message: "FAQ created successfully", faq });
  } catch (error) {
    return handleError(res, error, "Create FAQ Error");
  }
};

const getAllChatbots = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const storeId =
      typeof req.query.storeId === "string" &&
      mongoose.isValidObjectId(req.query.storeId)
        ? req.query.storeId
        : undefined;

    const { faqs, total } = await chatbotService.listFaqs({
      userId: getUserId(req),
      storeId,
      search,
      page,
      limit,
    });

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      faqs,
    });
  } catch (error) {
    return handleError(res, error, "Get FAQs Error");
  }
};

const getChatbotById = async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    const faq = await chatbotService.getFaqById(req.params.id, getUserId(req));
    return res.status(200).json({ success: true, faq });
  } catch (error) {
    return handleError(res, error, "Get FAQ Error");
  }
};

const updateChatbot = async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    const body = faqUpdateSchema.parse(req.body);
    const faq = await chatbotService.updateFaq(
      req.params.id,
      getUserId(req),
      body,
    );
    return res
      .status(200)
      .json({ success: true, message: "FAQ updated successfully", faq });
  } catch (error) {
    return handleError(res, error, "Update FAQ Error");
  }
};

const deleteChatbot = async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    await chatbotService.deleteFaq(req.params.id, getUserId(req));
    return res
      .status(200)
      .json({ success: true, message: "FAQ deleted successfully" });
  } catch (error) {
    return handleError(res, error, "Delete FAQ Error");
  }
};

// ---------- PUBLIC: poll ----------
const pollConversation = async (req, res) => {
  try {
    const after = typeof req.query.after === "string" ? req.query.after : "";
    const data = await chatbotService.pollConversation(
      req.params.sessionId,
      after,
    );
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "Chat Poll Error");
  }
};

// ---------- STORE: inbox ----------
const listConversations = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const mode = typeof req.query.mode === "string" ? req.query.mode : "";
    const storeId =
      typeof req.query.storeId === "string" &&
      mongoose.isValidObjectId(req.query.storeId)
        ? req.query.storeId
        : undefined;

    const { conversations, total, unreadTotal } =
      await chatbotService.listConversations({
        userId: getUserId(req),
        storeId,
        mode,
        search,
        page,
        limit,
      });

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      unreadTotal,
      totalPages: Math.ceil(total / limit),
      conversations,
    });
  } catch (error) {
    return handleError(res, error, "List Conversations Error");
  }
};

const getConversationMessages = async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    const data = await chatbotService.getConversationMessages(
      req.params.id,
      getUserId(req),
    );
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return handleError(res, error, "Get Conversation Error");
  }
};

const sendStoreMessage = async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    const { content } = storeMessageSchema.parse(req.body);
    const message = await chatbotService.sendStoreMessage(
      req.params.id,
      getUserId(req),
      content,
    );
    return res.status(201).json({ success: true, message });
  } catch (error) {
    return handleError(res, error, "Store Reply Error");
  }
};

const updateConversationState = async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    const body = conversationStateSchema.parse(req.body);
    const conversation = await chatbotService.updateConversationState(
      req.params.id,
      getUserId(req),
      body,
    );
    return res.status(200).json({ success: true, conversation });
  } catch (error) {
    return handleError(res, error, "Update Conversation Error");
  }
};

const requestAgent = async (req, res) => {
  try {
    const body = requestAgentSchema.parse(req.body);
    const data = await chatbotService.requestAgent(body);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "Request Agent Error");
  }
};

module.exports = {
  chat,
  getConversationHistory,
  createChatbot,
  getAllChatbots,
  getChatbotById,
  updateChatbot,
  deleteChatbot,
  pollConversation,
  listConversations,
  getConversationMessages,
  sendStoreMessage,
  updateConversationState,
  requestAgent
};
