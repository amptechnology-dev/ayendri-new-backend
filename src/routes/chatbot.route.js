const router = require("express").Router();
const rateLimit = require("express-rate-limit");

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const c = require("../controller/chatbot.controller.js");

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many messages, please slow down" },
});

// ---------- PUBLIC (customer widget) ----------
router.post("/chat", chatLimiter, c.chat);
router.post("/request-agent", chatLimiter, c.requestAgent);
router.get("/history/:sessionId", c.getConversationHistory);
router.get("/poll/:sessionId", c.pollConversation);

// ---------- STORE INBOX (must be BEFORE "/:id") ----------
router.get("/conversations", verifyJwt, authorize("STORE"), c.listConversations);
router.get("/conversations/:id/messages", verifyJwt, authorize("STORE"), c.getConversationMessages);
router.post("/conversations/:id/messages", verifyJwt, authorize("STORE"), c.sendStoreMessage);
router.patch("/conversations/:id/state", verifyJwt, authorize("STORE"), c.updateConversationState);

// ---------- STORE FAQ ----------
router.get("/", verifyJwt, authorize("STORE"), c.getAllChatbots);
router.post("/", verifyJwt, authorize("STORE"), c.createChatbot);
router.get("/:id", verifyJwt, authorize("STORE"), c.getChatbotById);
router.put("/:id", verifyJwt, authorize("STORE"), c.updateChatbot);
router.delete("/:id", verifyJwt, authorize("STORE"), c.deleteChatbot);

module.exports = router;