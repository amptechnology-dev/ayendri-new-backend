const StoreActionModel = require("../model/storeAction.model");
const StoreViewModel = require("../model/StoreViewModel");

const trackStoreAction = async (req, res) => {
  try {
    const { storeId, actionType } = req.body;

    await StoreActionModel.create({
      storeId,
      userId: req.user.id,
      actionType,
    });

    return res.status(200).json({
      message: "Action tracked successfully",
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const activityReport = async (req, res) => {
  try {
    // Store Views
    const views = await StoreViewModel.find()
      .populate({
        path: "userId",
        select: "name email phone role",
      })
      .populate({
        path: "storeId",
        select: "storeName storeUniqueId contactNo",
      })
      .sort({ createdAt: -1 });

    // Store Actions
    const actions = await StoreActionModel.find()
      .populate({
        path: "userId",
        select: "name email phone role",
      })
      .populate({
        path: "storeId",
        select: "storeName storeUniqueId contactNo",
      })
      .sort({ createdAt: -1 });

    return res.status(200).json({
      totalViews: views.length,
      totalActions: actions.length,

      views,

      actions,
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

module.exports = {
  trackStoreAction,
  activityReport
};
