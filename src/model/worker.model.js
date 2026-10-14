const mongoose = require("mongoose");

const workerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Worker name is required"],
      trim: true,
    },
    whatsappNo: {
      type: String,
      required: [true, "WhatsApp number is required"],
      trim: true,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

workerSchema.index({ storeId: 1 });

const WorkerModel = mongoose.model("Worker", workerSchema);
module.exports = WorkerModel;