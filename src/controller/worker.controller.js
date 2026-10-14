const mongoose = require("mongoose");
const WorkerModel = require("../model/worker.model.js");
const StoreModel = require("../model/store.model.js");
const UserModel = require("../model/user.model.js");

// storeId ta req.user er nijer store kina check kore dey
const getOwnedStore = async (storeId, userId) => {
  if (!mongoose.isValidObjectId(storeId)) return null;
  return StoreModel.findOne({ _id: storeId, userId });
};

const createWorker = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const user = await UserModel.findById(userId);
    if (!user || user.role !== "STORE") {
      return res
        .status(403)
        .json({ success: false, message: "Only STORE can create worker" });
    }

    const { name, whatsappNo, storeId } = req.body;

    if (!name || !whatsappNo || !storeId) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: [
          !name && { field: "name", message: "Name is required" },
          !whatsappNo && { field: "whatsappNo", message: "WhatsApp number is required" },
          !storeId && { field: "storeId", message: "storeId is required" },
        ].filter(Boolean),
      });
    }

    const store = await getOwnedStore(storeId, userId);
    if (!store) {
      return res
        .status(404)
        .json({ success: false, message: "Store not found" });
    }

    const worker = await WorkerModel.create({ name, whatsappNo, storeId });

    return res.status(201).json({
      success: true,
      message: "Worker created successfully",
      data: worker,
    });
  } catch (error) {
    console.log(error);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => ({
        field: e.path,
        message: e.message,
      }));
      return res
        .status(400)
        .json({ success: false, message: "Validation failed", errors });
    }
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const getAllWorkers = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const { storeId } = req.query;

    let page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";

    // user er sob store id ber kore, tarpor filter
    const ownedStores = await StoreModel.find({ userId }).select("_id");
    const ownedStoreIds = ownedStores.map((s) => s._id);

    const match = { storeId: { $in: ownedStoreIds } };

    if (storeId) {
      if (!mongoose.isValidObjectId(storeId)) {
        return res.status(400).json({ success: false, message: "Invalid storeId" });
      }
      // requested storeId ta user er nijer kina check
      if (!ownedStoreIds.some((id) => id.equals(storeId))) {
        return res.status(404).json({ success: false, message: "Store not found" });
      }
      match.storeId = new mongoose.Types.ObjectId(storeId);
    }

    if (search) {
      match.$or = [
        { name: { $regex: search, $options: "i" } },
        { whatsappNo: { $regex: search, $options: "i" } },
      ];
    }

    const [workers, totalWorkers] = await Promise.all([
      WorkerModel.find(match)
        .populate("storeId", "storeName storeUniqueId")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WorkerModel.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      page,
      limit,
      totalPages: Math.ceil(totalWorkers / limit),
      totalWorkers,
      workers,
    });
  } catch (error) {
    console.error("Get All Workers Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const getSingleWorker = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.user?.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid worker id" });
    }

    const worker = await WorkerModel.findById(id).populate(
      "storeId",
      "storeName storeUniqueId userId",
    );

    if (!worker || String(worker.storeId?.userId) !== String(userId)) {
      return res
        .status(404)
        .json({ success: false, message: "Worker not found" });
    }

    return res.status(200).json({ success: true, worker });
  } catch (error) {
    console.error("Get Single Worker Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const updateWorker = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.user?.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid worker id" });
    }

    const worker = await WorkerModel.findById(id).populate("storeId", "userId");
    if (!worker || String(worker.storeId?.userId) !== String(userId)) {
      return res
        .status(404)
        .json({ success: false, message: "Worker not found" });
    }

    const { name, whatsappNo, storeId, isActive } = req.body;

    // storeId change korte chaile, notun storeId ta o user er nijer kina check
    if (storeId && String(storeId) !== String(worker.storeId._id)) {
      const newStore = await getOwnedStore(storeId, userId);
      if (!newStore) {
        return res
          .status(404)
          .json({ success: false, message: "Target store not found" });
      }
      worker.storeId = storeId;
    }

    if (name !== undefined) worker.name = name;
    if (whatsappNo !== undefined) worker.whatsappNo = whatsappNo;
    if (isActive !== undefined) worker.isActive = isActive;

    await worker.save();

    return res.status(200).json({
      success: true,
      message: "Worker updated successfully",
      data: worker,
    });
  } catch (error) {
    console.log(error);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => ({
        field: e.path,
        message: e.message,
      }));
      return res
        .status(400)
        .json({ success: false, message: "Validation failed", errors });
    }
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const deleteWorker = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.user?.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid worker id" });
    }

    const worker = await WorkerModel.findById(id).populate("storeId", "userId");
    if (!worker || String(worker.storeId?.userId) !== String(userId)) {
      return res
        .status(404)
        .json({ success: false, message: "Worker not found" });
    }

    await WorkerModel.findByIdAndDelete(id);

    return res
      .status(200)
      .json({ success: true, message: "Worker deleted successfully" });
  } catch (error) {
    console.error("Delete Worker Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  createWorker,
  getAllWorkers,
  getSingleWorker,
  updateWorker,
  deleteWorker,
};