const mongoose = require("mongoose");
const { z } = require("zod");
const chatbotService = require("../helper/chatbot.service");

const chatSchema = z.object({
  sessionId: z.string().trim().min(8, "sessionId is required").max(64),
  message: z.string().trim().min(1, "Message is required").max(1000),
  name: z.string().trim().max(100).optional(),
  phoneNumber: z.string().trim().max(20).optional(),
});

const faqSchema = z.object({
  question: z.string().trim().min(1).max(500),
  keywords: z.array(z.string().trim().min(1)).default([]),
  answer: z.string().trim().min(1).max(2000),
  category: z.string().trim().optional(),
  isActive: z.boolean().optional(),
});

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
    return res.status(error.status).json({ success: false, message: error.message });
  }
  console.error(`${label}:`, error);
  return res.status(500).json({ success: false, message: "Internal server error" });
};

const validId = (id) => mongoose.isValidObjectId(id);

// ---------- PUBLIC ----------
const chat = async (req, res) => {
  try {
    const body = chatSchema.parse(req.body);
    const result = await chatbotService.getChatReply(body);
    return res
      .status(200)
      .json({ success: true, message: "Reply generated successfully", data: result });
  } catch (error) {
    return handleError(res, error, "Chat Error");
  }
};

const getConversationHistory = async (req, res) => {
  try {
    const data = await chatbotService.getConversationHistory(req.params.sessionId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "Chat History Error");
  }
};

// ---------- ADMIN ----------
const createChatbot = async (req, res) => {
  try {
    const body = faqSchema.parse(req.body);
    const data = await chatbotService.createFaq(body);
    return res.status(201).json({ success: true, message: "FAQ created successfully", data });
  } catch (error) {
    return handleError(res, error, "Create FAQ Error");
  }
};

const getAllChatbots = async (req, res) => {
  try {
    const data = await chatbotService.getAllFaqs();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "Get FAQs Error");
  }
};

const getChatbotById = async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(400).json({ success: false, message: "Invalid id" });
    const data = await chatbotService.getFaqById(req.params.id);
    if (!data) return res.status(404).json({ success: false, message: "FAQ not found" });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "Get FAQ Error");
  }
};

const updateChatbot = async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(400).json({ success: false, message: "Invalid id" });
    const body = faqSchema.partial().parse(req.body);
    const data = await chatbotService.updateFaq(req.params.id, body);
    if (!data) return res.status(404).json({ success: false, message: "FAQ not found" });
    return res.status(200).json({ success: true, message: "FAQ updated successfully", data });
  } catch (error) {
    return handleError(res, error, "Update FAQ Error");
  }
};

const deleteChatbot = async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(400).json({ success: false, message: "Invalid id" });
    const data = await chatbotService.deleteFaq(req.params.id);
    if (!data) return res.status(404).json({ success: false, message: "FAQ not found" });
    return res.status(200).json({ success: true, message: "FAQ deleted successfully" });
  } catch (error) {
    return handleError(res, error, "Delete FAQ Error");
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
};