const mongoose = require("mongoose");
const { z } = require("zod");
const ticketService = require("../helper/ticket.service");
const UserModel = require("../model/user.model.js");
const ChatConversationModel = require("../model/chatConversation.model.js");
const getUserId = (req) => req.user?._id || req.user?.id;

const getMe = async (req) => {
  const userId = getUserId(req);
  const u = await UserModel.findById(userId).select("phone").lean();
  return { userId, phoneKey: ticketService.toPhoneKey(u?.phone) };
};

const objectId = z
  .string()
  .refine((v) => mongoose.isValidObjectId(v), "Invalid id");

const createSchema = z.object({
  conversationId: objectId,
  orderId: objectId.optional(),
  subject: z.string().trim().min(3, "Subject is required").max(150),
  description: z.string().trim().min(5, "Describe the complaint").max(2000),
});

const updateSchema = z
  .object({
    status: z.enum(["open", "in_progress", "resolved"]).optional(),
    resolution: z.string().trim().max(2000).optional(),
  })
  .refine(
    (d) => d.status !== undefined || d.resolution !== undefined,
    "status or resolution is required",
  );

// multipart form e empty field "" ashe, seta soriye dai
const stripEmpty = (obj = {}) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== ""));

const userCreateSchema = z.object({
  orderId: objectId,
  subject: z.string().trim().min(3, "Subject is required").max(150),
  description: z.string().trim().min(5, "Describe the complaint").max(2000),
});

const closeSchema = z.object({
  rating: z.coerce.number().int().min(1, "Please give a rating").max(5),
  comment: z.string().trim().max(1000).optional(),
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
  if (error.status)
    return res
      .status(error.status)
      .json({ success: false, message: error.message });
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

const paging = (req, defLimit = 10) => ({
  page: Math.max(parseInt(req.query.page) || 1, 1),
  limit: Math.min(Math.max(parseInt(req.query.limit) || defLimit, 1), 100),
});

// ---------- STORE / SUPPORT ----------
const storeList = async (req, res) => {
  try {
    const { page, limit } = paging(req);
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const { tickets, total, openCount } = await ticketService.listStoreTickets({
      userId: getUserId(req),
      status,
      search,
      page,
      limit,
    });
    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      openCount,
      totalPages: Math.ceil(total / limit),
      tickets,
    });
  } catch (error) {
    return handleError(res, error, "List Tickets Error");
  }
};

const storeCreate = async (req, res) => {
  try {
    const body = createSchema.parse(req.body);
    const ticket = await ticketService.createTicket(getUserId(req), body);
    return res
      .status(201)
      .json({ success: true, message: "Ticket raised", ticket });
  } catch (error) {
    return handleError(res, error, "Create Ticket Error");
  }
};

const storeGet = async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    const data = await ticketService.getStoreTicket(
      req.params.id,
      getUserId(req),
    );
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return handleError(res, error, "Get Ticket Error");
  }
};

const storeUpdate = async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    const body = updateSchema.parse(req.body);
    const ticket = await ticketService.updateTicket(
      req.params.id,
      getUserId(req),
      body,
    );
    return res
      .status(200)
      .json({ success: true, message: "Ticket updated", ticket });
  } catch (error) {
    return handleError(res, error, "Update Ticket Error");
  }
};

const myList = async (req, res) => {
  try {
    const { page, limit } = paging(req, 20);
    const me = await getMe(req);
    const { tickets, total } = await ticketService.listMyTickets({
      ...me,
      page,
      limit,
    });
    return res.status(200).json({ success: true, page, limit, total, tickets });
  } catch (error) {
    return handleError(res, error, "My Tickets Error");
  }
};

const myUnread = async (req, res) => {
  try {
    const me = await getMe(req);
    const count = await ticketService.getMyUnread(me.userId, me.phoneKey);
    return res.status(200).json({ success: true, data: { count } });
  } catch (error) {
    return handleError(res, error, "My Tickets Unread Error");
  }
};

const myGet = async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    const me = await getMe(req);
    const data = await ticketService.getMyTicket(
      req.params.id,
      me.userId,
      me.phoneKey,
    );
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return handleError(res, error, "My Ticket Error");
  }
};

const myOrders = async (req, res) => {
  try {
    const orders = await ticketService.listMyOrdersForTicket(getUserId(req));
    return res.status(200).json({ success: true, orders });
  } catch (error) {
    return handleError(res, error, "My Orders Error");
  }
};

const myCreate = async (req, res) => {
  let unlocked = null;
  try {
    // sessionId is not part of the ticket body, so take it out before zod
    const { sessionId, ...rest } = stripEmpty(req.body);
    const body = userCreateSchema.parse(rest);

    // The bot unlocks ONE ticket per chat (ticketAllowed). Consume it atomically.
    unlocked =
      typeof sessionId === "string" &&
      sessionId.length >= 8 &&
      sessionId.length <= 64
        ? await ChatConversationModel.findOneAndUpdate(
            { sessionId, ticketAllowed: true },
            { $set: { ticketAllowed: false } },
          )
        : null;

    if (!unlocked) {
      return res.status(403).json({
        success: false,
        message:
          "Tickets can only be raised when our chat assistant offers it. Please chat with us first.",
      });
    }

    const ticket = await ticketService.createMyTicket(
      getUserId(req),
      body,
      req.files || [],
    );
    return res
      .status(201)
      .json({ success: true, message: "Ticket raised", ticket });
  } catch (error) {
    // ticket was not created (bad order, upload error...), so give the unlock back
    if (unlocked) {
      await ChatConversationModel.updateOne(
        { _id: unlocked._id },
        { $set: { ticketAllowed: true } },
      ).catch(() => {});
    }
    return handleError(res, error, "Create My Ticket Error");
  }
};

const myClose = async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    const body = closeSchema.parse(req.body);
    const me = await getMe(req);
    const ticket = await ticketService.closeMyTicket(
      req.params.id,
      me.userId,
      me.phoneKey,
      body,
    );
    return res
      .status(200)
      .json({ success: true, message: "Ticket closed", ticket });
  } catch (error) {
    return handleError(res, error, "Close My Ticket Error");
  }
};

module.exports = {
  storeList,
  storeCreate,
  storeGet,
  storeUpdate,
  myList,
  myUnread,
  myGet,
  myOrders,
  myCreate,
  myClose,
};
