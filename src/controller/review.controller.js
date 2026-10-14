const StoreModel = require("../model/store.model");

const addReview = async (req, res) => {
    try {
        const { storeId } = req.params;
        const { comment, rating } = req.body;
        const store = await StoreModel.findById(storeId);
        if (!store) {
            return res.status(404).json({
                message: "Store not found"
            });

        }
        const alreadyReviewed = store.reviews.find(
            (review) =>
                review.userId.toString() === req.user.id
        );
        // if (alreadyReviewed) {
        //     return res.status(400).json({
        //         message: "You already reviewed this store"
        //     });

        // }
        const newReview = {
            comment,
            rating,
            userId: req.user.id

        };

        store.reviews.push(newReview);

        await store.save();

        return res.status(201).json({
            message: "Review added successfully",
            reviews: store.reviews
        });
    } catch (error) {
        console.log(error);
        return res.status(500).json({
            message: "Failed to add review"
        });

    }

};

/* =========================
   UPDATE REVIEW
========================= */

const updateReview = async (req, res) => {

    try {

        const { storeId, reviewId } = req.params;

        const { comment, rating } = req.body;

        const store = await StoreModel.findById(storeId);

        if (!store) {

            return res.status(404).json({
                message: "Store not found"
            });

        }

        // 🔥 FIND REVIEW
        const review = store.reviews.id(reviewId);

        if (!review) {

            return res.status(404).json({
                message: "Review not found"
            });

        }

        // 🔥 OWNER CHECK
        if (review.userId.toString() !== req.user.id) {

            return res.status(403).json({
                message: "Unauthorized"
            });

        }

        // 🔥 UPDATE
        review.comment = comment || review.comment;

        review.rating = rating || review.rating;

        await store.save();

        return res.status(200).json({

            message: "Review updated successfully",

            review

        });

    } catch (error) {

        console.log(error);

        return res.status(500).json({
            message: "Failed to update review"
        });

    }

};

/* =========================
   DELETE REVIEW
========================= */

const deleteReview = async (req, res) => {

    try {

        const { storeId, reviewId } = req.params;

        const store = await StoreModel.findById(storeId);

        if (!store) {

            return res.status(404).json({
                message: "Store not found"
            });

        }

        const review = store.reviews.id(reviewId);

        if (!review) {

            return res.status(404).json({
                message: "Review not found"
            });

        }

        // 🔥 OWNER CHECK
        if (review.userId.toString() !== req.user.id) {

            return res.status(403).json({
                message: "Unauthorized"
            });

        }

        // 🔥 DELETE REVIEW
        store.reviews.pull(reviewId);

        await store.save();

        return res.status(200).json({

            message: "Review deleted successfully"

        });

    } catch (error) {

        console.log(error);

        return res.status(500).json({
            message: "Failed to delete review"
        });

    }

};

/* =========================
   GET STORE REVIEWS
========================= */

const getStoreReviews = async (req, res) => {

    try {

        const { storeId } = req.params;

        const store = await StoreModel.findById(storeId)
            .populate({
                path: "reviews.userId",
                select: "name email picture"
            });

        if (!store) {

            return res.status(404).json({
                message: "Store not found"
            });

        }

        return res.status(200).json({

            reviews: store.reviews

        });

    } catch (error) {

        console.log(error);

        return res.status(500).json({
            message: "Failed to get reviews"
        });

    }

};

module.exports = { addReview, updateReview, deleteReview, getStoreReviews };