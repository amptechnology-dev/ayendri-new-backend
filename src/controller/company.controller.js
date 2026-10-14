const CompanyModel = require("../model/company.model.js");
const { upsertCompanySchema } = require("../schema/company.schema.js");

const SINGLETON_KEY = "COMPANY_INFO";

// ---------- PUT /api/company (ADMIN) ----------
// Na thakle create, thakle update (upsert)
const upsertCompanyInfo = async (req, res) => {
  try {
    const parsed = upsertCompanySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
    }

    const userId = req.user?._id || req.user?.id;

    const company = await CompanyModel.findOneAndUpdate(
      { singletonKey: SINGLETON_KEY },
      {
        $set: { ...parsed.data, updatedBy: userId },
        $setOnInsert: { singletonKey: SINGLETON_KEY },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    ).lean();

    return res.status(200).json({
      success: true,
      message: "Company info saved successfully",
      data: company,
    });
  } catch (error) {
    console.error("Upsert Company Info Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ---------- GET /api/company (PUBLIC) ----------
const getCompanyInfo = async (req, res) => {
  try {
    const company = await CompanyModel.findOne({ singletonKey: SINGLETON_KEY })
      .select("-__v")
      .lean();

    // Data na thakleo 200 + null, frontend e handle kora easy
    return res.status(200).json({ success: true, data: company || null });
  } catch (error) {
    console.error("Get Company Info Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ---------- DELETE /api/company (ADMIN) ----------
const deleteCompanyInfo = async (req, res) => {
  try {
    const deleted = await CompanyModel.findOneAndDelete({ singletonKey: SINGLETON_KEY });
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Company info not found" });
    }
    return res.status(200).json({ success: true, message: "Company info deleted" });
  } catch (error) {
    console.error("Delete Company Info Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = { upsertCompanyInfo, getCompanyInfo, deleteCompanyInfo };