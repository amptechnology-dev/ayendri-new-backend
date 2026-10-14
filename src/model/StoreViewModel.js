const mongoose = require("mongoose");

const storeViewSchema =
    new mongoose.Schema(
        {
            storeId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Store",
                required: true
            },

            userId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
                required: true
            }
        },
        {
            timestamps: true
        }
    );

storeViewSchema.index(
    {
        storeId: 1,
        userId: 1
    },
    {
        unique: true
    }
);

module.exports = mongoose.model("StoreView", storeViewSchema);