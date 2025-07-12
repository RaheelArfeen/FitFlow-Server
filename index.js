const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
dotenv.config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

const serviceAccount = require("./firebase-service-account.json");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.hqacvhm.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

app.use(
    cors({
        origin: ["http://localhost:5173", "https://your-frontend-domain.com"],
        credentials: true,
    })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ================= Verify Firebase Token =================
const verifyFBToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized: No Firebase token" });
    }
    const token = authHeader.split(" ")[1];
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
    } catch (error) {
        console.error("Firebase token verification error:", error);
        res.status(403).send({ message: "Forbidden: Invalid Firebase token" });
    }
};

// ================= Verify Admin Role =================
const verifyAdmin = async (req, res, next) => {
    if (!req.decoded || !req.decoded.email) {
        return res.status(401).send({ message: "Unauthorized: User not authenticated via Firebase" });
    }

    const email = req.decoded.email;
    const usersCollection = client.db("fitflowDB").collection("users");

    try {
        const user = await usersCollection.findOne({ email });

        if (!user || user.role !== "admin") {
            return res.status(403).send({ message: "Forbidden: Not an admin" });
        }
        next();
    } catch (error) {
        console.error("Error verifying admin role:", error);
        res.status(500).send({ message: "Internal server error during role verification." });
    }
};

async function run() {
    try {
        await client.connect();
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

        const db = client.db("fitflowDB");
        const usersCollection = db.collection("users");
        const trainerCollection = db.collection("trainers");
        const bookingsCollection = db.collection("bookings");
        const paymentsCollection = db.collection("payments");
        const communityCollection = db.collection("community");

        // ================= Trainer Routes =================
        app.get("/trainers", async (req, res) => {
            try {
                const { status } = req.query;
                let query = {};

                if (status) {
                    query.status = status;
                }

                const trainers = await trainerCollection.find(query).toArray();
                res.send(trainers);
            } catch (error) {
                console.error("Failed to fetch trainers:", error);
                res.status(500).send({ message: "Failed to fetch trainers" });
            }
        });

        app.post("/trainers", verifyFBToken, async (req, res) => {
            try {
                const {
                    email,
                    name,
                    age,
                    experience,
                    photoURL,
                    specialization,
                    description,
                    certifications,
                    sessions,
                    social,
                    slots
                } = req.body;

                if (!email || !name || !specialization || !description || !photoURL) {
                    return res.status(400).send({ message: "Missing required application fields (email, name, specialization, description, photoURL)." });
                }
                if (!Array.isArray(slots)) {
                    return res.status(400).send({ message: "Slots must be an array for trainer application." });
                }
                if (req.decoded.email !== email) {
                    return res.status(403).send({ message: "Forbidden: You can only submit a trainer application for your own account." });
                }

                const existingTrainer = await trainerCollection.findOne({ email });
                if (existingTrainer) {
                    return res.status(409).send({ message: "A trainer profile (or application) already exists for this email." });
                }

                const newTrainerApplication = {
                    email,
                    name,
                    age: age || null,
                    experience: experience || 0,
                    photoURL,
                    specialization,
                    description,
                    certifications: certifications || [],
                    sessions: sessions || 0,
                    social: social || { instagram: '', twitter: '', linkedin: '' },
                    rating: 0,
                    ratings: [],
                    slots: slots || [],
                    role: "trainer",
                    status: "pending",
                    appliedAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };

                const result = await trainerCollection.insertOne(newTrainerApplication);
                res.status(201).send({ message: "Trainer application submitted successfully. Awaiting approval.", insertedId: result.insertedId });
            } catch (error) {
                console.error("Error submitting trainer application:", error.message, error.stack);
                res.status(500).send({ message: "Failed to submit trainer application." });
            }
        });

        app.patch("/trainers/:id/status", verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const trainerId = req.params.id;
                const { status, feedback } = req.body;

                if (!ObjectId.isValid(trainerId)) {
                    return res.status(400).send({ message: "Invalid trainer ID format." });
                }
                if (!["accepted", "rejected"].includes(status)) {
                    return res.status(400).send({ message: "Invalid status provided. Must be 'accepted' or 'rejected'." });
                }

                const updateDoc = {
                    $set: {
                        status: status,
                        updatedAt: new Date(),
                    }
                };
                if (feedback) {
                    updateDoc.$set.adminFeedback = feedback;
                }

                if (status === "accepted") {
                    const trainer = await trainerCollection.findOne({ _id: new ObjectId(trainerId) });
                    if (trainer && trainer.email) {
                        await usersCollection.updateOne(
                            { email: trainer.email },
                            { $set: { role: "trainer", updatedAt: new Date() } }
                        );
                    }
                } else if (status === "rejected") {
                    const trainer = await trainerCollection.findOne({ _id: new ObjectId(trainerId) });
                    if (trainer && trainer.email) {
                        await usersCollection.updateOne(
                            { email: trainer.email },
                            { $set: { role: "member", updatedAt: new Date() } }
                        );
                    }
                }

                const result = await trainerCollection.updateOne(
                    { _id: new ObjectId(trainerId) },
                    updateDoc
                );

                if (result.modifiedCount === 0) {
                    return res.status(404).send({ message: "Trainer not found or status already set." });
                }

                res.send({ message: `Trainer status updated to ${status}.` });

            } catch (error) {
                console.error("Error updating trainer status:", error);
                res.status(500).send({ message: "Failed to update trainer status." });
            }
        });

        app.get("/trainers/:id", async (req, res) => {
            try {
                const trainer = await trainerCollection.findOne({ _id: new ObjectId(req.params.id) });
                if (!trainer) return res.status(404).send({ message: "Trainer not found" });
                res.send(trainer);
            } catch (error) {
                console.error("Failed to fetch trainer by ID:", error);
                res.status(500).send({ message: "Failed to fetch trainer" });
            }
        });

        // ================= Trainer Rating Routes =================
        app.get("/trainers/rating/:id", verifyFBToken, async (req, res) => {
            const trainerId = req.params.id;
            const userEmail = req.decoded.email;

            try {
                const trainer = await trainerCollection.findOne(
                    { _id: new ObjectId(trainerId) },
                    { projection: { ratings: 1, rating: 1 } }
                );

                if (!trainer) {
                    return res.status(404).send({ message: "Trainer not found" });
                }

                const userRatingObj = trainer.ratings?.find(r => r.email === userEmail);
                const userRating = userRatingObj ? userRatingObj.rating : 0;

                res.send({
                    averageRating: trainer.rating || 0,
                    totalRatings: trainer.ratings?.length || 0,
                    ratings: trainer.ratings || [],
                    userRating,
                });
            } catch (error) {
                console.error("Failed to fetch trainer ratings:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        app.post("/trainers/rating/:id", verifyFBToken, async (req, res) => {
            const trainerId = req.params.id;
            const { rating } = req.body;
            const userEmail = req.decoded.email;

            if (typeof rating !== 'number' || rating < 1 || rating > 5) {
                return res.status(400).send({ success: false, message: "Rating must be a number between 1 and 5." });
            }

            try {
                const trainer = await trainerCollection.findOne({ _id: new ObjectId(trainerId) });

                if (!trainer) {
                    return res.status(404).send({ success: false, message: "Trainer not found" });
                }

                if (trainer.status !== 'accepted') {
                    return res.status(403).send({ success: false, message: "This trainer is not yet active or is no longer accepting ratings." });
                }

                const alreadyRated = trainer.ratings?.find((r) => r.email === userEmail);
                if (alreadyRated) {
                    return res.status(409).send({ success: false, message: "You already rated this trainer." });
                }

                const user = await usersCollection.findOne({ email: userEmail });
                const userName = user?.displayName || "Anonymous User";
                const userPhoto = user?.photoURL || "";

                const newRating = {
                    email: userEmail,
                    name: userName,
                    photoURL: userPhoto,
                    rating,
                    date: new Date(),
                };

                const updatedRatings = [...(trainer.ratings || []), newRating];
                const avgRating =
                    updatedRatings.reduce((sum, r) => sum + r.rating, 0) / updatedRatings.length;

                const result = await trainerCollection.updateOne(
                    { _id: new ObjectId(trainerId) },
                    {
                        $set: {
                            ratings: updatedRatings,
                            rating: avgRating,
                            updatedAt: new Date(),
                        },
                    }
                );

                res.send({ success: true, message: "Rating submitted", result });
            } catch (error) {
                console.error("Error submitting rating:", error);
                res.status(500).send({ success: false, message: "Failed to submit rating" });
            }
        });

        // ================= Community Routes =================
        app.get('/community', async (req, res) => {
            try {
                const posts = await communityCollection.find().sort({ createdAt: -1 }).toArray();
                res.send(posts);
            } catch (error) {
                console.error('Error fetching community posts:', error);
                res.status(500).send({ message: 'Failed to fetch posts.' });
            }
        });

        app.get('/community/:id', async (req, res) => {
            try {
                const id = req.params.id;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid post ID format." });
                }

                const post = await communityCollection.findOne({ _id: new ObjectId(id) });

                if (!post) {
                    return res.status(404).send({ message: 'Post not found.' });
                }

                if (post.comments && post.comments.length > 0) {
                    post.comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                }

                res.send(post);
            } catch (error) {
                console.error('Error fetching post by ID:', error);
                res.status(500).send({ message: 'Failed to fetch post.' });
            }
        });

        app.post("/community", verifyFBToken, async (req, res) => {
            try {
                const { title, content, category, tags } = req.body;

                if (!title || !content || !category) {
                    return res.status(400).send({ message: "Title, content, and category are required for a post." });
                }

                const userEmail = req.decoded.email;
                const user = await usersCollection.findOne({ email: userEmail });

                if (!user) {
                    return res.status(404).send({ message: "User not found." });
                }

                const post = {
                    title,
                    content,
                    category,
                    tags: tags || [],
                    author: user.displayName || "Anonymous",
                    authorPhoto: user.photoURL || "",
                    authorRole: user.role || "member",
                    email: user.email,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    likes: 0,
                    dislikes: 0,
                    comments: [],
                    votes: [],
                };

                const result = await communityCollection.insertOne(post);
                res.status(201).send({ insertedId: result.insertedId, message: "Post added successfully" });
            } catch (error) {
                console.error("Error adding post:", error);
                res.status(500).send({ message: "Failed to add post." });
            }
        });

        app.post("/community/:postId/comments", verifyFBToken, async (req, res) => {
            try {
                const { postId } = req.params;
                const { commentText } = req.body;
                const userEmail = req.decoded.email;

                if (!ObjectId.isValid(postId)) {
                    return res.status(400).send({ message: "Invalid post ID format." });
                }

                if (!commentText || commentText.trim() === "") {
                    return res.status(400).send({ message: "Comment text is required" });
                }

                const user = await usersCollection.findOne({ email: userEmail });
                if (!user) return res.status(404).send({ message: "User not found" });

                const newComment = {
                    _id: new ObjectId(),
                    text: commentText,
                    author: user.displayName || "Anonymous",
                    authorPhoto: user.photoURL || "",
                    authorRole: user.role || "member",
                    email: user.email,
                    createdAt: new Date(),
                };

                const result = await communityCollection.updateOne(
                    { _id: new ObjectId(postId) },
                    {
                        $push: { comments: newComment },
                        $set: { updatedAt: new Date() }
                    }
                );

                if (result.modifiedCount === 0) {
                    return res.status(404).send({ message: "Post not found or comment not added" });
                }

                const updatedPost = await communityCollection.findOne({ _id: new ObjectId(postId) });

                if (updatedPost?.comments?.length) {
                    updatedPost.comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                }

                res.status(201).send({
                    message: "Comment added",
                    comment: newComment,
                    post: updatedPost
                });
            } catch (error) {
                console.error("Error adding comment:", error);
                res.status(500).send({ message: "Failed to add comment" });
            }
        });

        app.delete("/community/:postId/comments/:commentId", verifyFBToken, async (req, res) => {
            try {
                const { postId, commentId } = req.params;
                const userEmail = req.decoded.email;

                if (!ObjectId.isValid(postId) || !ObjectId.isValid(commentId)) {
                    return res.status(400).send({ message: "Invalid post or comment ID format." });
                }

                const post = await communityCollection.findOne({ _id: new ObjectId(postId) });

                if (!post) {
                    return res.status(404).send({ message: "Post not found." });
                }

                const commentIndex = post.comments.findIndex(
                    (comment) => comment._id.toString() === commentId
                );

                if (commentIndex === -1) {
                    return res.status(404).send({ message: "Comment not found on this post." });
                }

                const isAdmin = req.decoded.role === "admin";
                if (post.comments[commentIndex].email !== userEmail && !isAdmin) {
                    return res.status(403).send({ message: "Forbidden: You are not the author of this comment and not an admin." });
                }

                post.comments.splice(commentIndex, 1);

                const result = await communityCollection.updateOne(
                    { _id: new ObjectId(postId) },
                    {
                        $set: {
                            comments: post.comments,
                            updatedAt: new Date(),
                        },
                    }
                );

                if (result.modifiedCount === 0) {
                    return res.status(500).send({ message: "Failed to delete comment: No changes made." });
                }

                res.status(200).send({ message: "Comment deleted successfully." });
            } catch (error) {
                console.error("Error deleting comment:", error);
                res.status(500).send({ message: "Failed to delete comment. Please try again." });
            }
        });

        app.post("/community/vote", verifyFBToken, async (req, res) => {
            try {
                const { postId, voteType } = req.body;
                const email = req.decoded.email;

                if (!postId || !ObjectId.isValid(postId)) {
                    return res.status(400).json({ message: "Invalid postId." });
                }

                if (!["like", "dislike", null].includes(voteType)) {
                    return res.status(400).json({ message: "Invalid vote type. Must be 'like', 'dislike', or null." });
                }

                const post = await communityCollection.findOne({ _id: new ObjectId(postId) });
                if (!post) return res.status(404).json({ message: "Post not found" });

                let votes = post.votes || [];
                const existingVote = votes.find((v) => v.email === email);

                if (existingVote) {
                    votes = votes.filter((v) => v.email !== email);
                }

                if (voteType) {
                    votes.push({ email, type: voteType });
                }

                const likes = votes.filter((v) => v.type === "like").length;
                const dislikes = votes.filter((v) => v.type === "dislike").length;

                const result = await communityCollection.updateOne(
                    { _id: new ObjectId(postId) },
                    {
                        $set: {
                            votes,
                            likes,
                            dislikes,
                        },
                    }
                );

                if (result.modifiedCount === 0) {
                    return res.status(500).json({ message: "Failed to update vote." });
                }

                res.json({ message: "Vote updated", likes, dislikes });
            } catch (err) {
                console.error("Vote error:", err);
                res.status(500).json({ message: "Internal server error" });
            }
        });

        // ================= User Routes =================
        app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const users = await usersCollection.find().toArray();
                res.send(users);
            } catch (error) {
                console.error("Failed to fetch users:", error);
                res.status(500).send({ message: "Failed to fetch users" });
            }
        });

        app.get("/users/:email", async (req, res) => {
            try {
                const user = await usersCollection.findOne({ email: req.params.email });
                if (!user) return res.status(404).send({ message: "User not found" });
                res.send(user);
            } catch (error) {
                console.error("Failed to fetch user by email:", error);
                res.status(500).send({ message: "Failed to fetch user" });
            }
        });

        app.get("/users/role/:email", async (req, res) => {
            try {
                const user = await usersCollection.findOne({ email: req.params.email });
                if (!user) return res.status(404).send({ message: "User not found" });
                res.send({ role: user.role || "member" });
            } catch (error) {
                console.error("Failed to fetch user role:", error);
                res.status(500).send({ message: "Failed to fetch user role" });
            }
        });

        app.post("/users", async (req, res) => {
            try {
                const { email, displayName, photoURL, lastSignInTime, role = "member" } = req.body;
                if (!email) {
                    return res.status(400).send({ message: "Email is required to create/update user." });
                }

                const result = await usersCollection.updateOne(
                    { email },
                    {
                        $set: {
                            displayName,
                            photoURL,
                            lastSignInTime,
                            role,
                            updatedAt: new Date(),
                        },
                        $setOnInsert: {
                            createdAt: new Date(),
                        }
                    },
                    { upsert: true }
                );
                res.send(result);
            } catch (error) {
                console.error("Failed to create/update user:", error);
                res.status(500).send({ message: "Failed to create/update user" });
            }
        });

        app.patch("/users", verifyFBToken, async (req, res) => {
            try {
                const { email, lastSignInTime, role } = req.body;
                const authenticatedEmail = req.decoded.email;

                if (!email) {
                    return res.status(400).send({ message: "Email is required for update." });
                }

                if (authenticatedEmail !== email && req.decoded.role !== "admin") {
                    return res.status(403).send({ message: "Forbidden: You can only update your own profile or must be an admin." });
                }

                const updateFields = { updatedAt: new Date() };
                if (lastSignInTime) updateFields.lastSignInTime = lastSignInTime;

                if (role && req.decoded.role === "admin") {
                    updateFields.role = role;
                } else if (role && req.decoded.role !== "admin") {
                    return res.status(403).send({ message: "Forbidden: Only admins can change user roles." });
                }

                if (Object.keys(updateFields).length === 1 && updateFields.updatedAt) {
                    return res.status(400).send({ message: "No valid fields to update (lastSignInTime or role)." });
                }

                const result = await usersCollection.updateOne(
                    { email },
                    { $set: updateFields }
                );

                if (result.modifiedCount === 0 && result.matchedCount === 0) {
                    return res.status(404).send({ message: "User not found or no changes made." });
                }

                res.send(result);
            } catch (error) {
                console.error("Failed to update user:", error);
                res.status(500).send({ message: "Failed to update user" });
            }
        });

        // ================= JWT Authentication Routes =================
        app.post("/register", async (req, res) => {
            try {
                const { email, displayName, photoURL, lastSignInTime } = req.body;
                if (!email) return res.status(400).json({ error: "Email required" });

                await usersCollection.updateOne(
                    { email },
                    {
                        $set: {
                            email,
                            displayName,
                            photoURL,
                            lastSignInTime: lastSignInTime || new Date().toISOString(),
                            role: "member",
                            updatedAt: new Date(),
                        },
                        $setOnInsert: {
                            createdAt: new Date(),
                        }
                    },
                    { upsert: true }
                );

                const user = await usersCollection.findOne({ email });

                const token = jwt.sign(
                    {
                        email: user.email,
                        role: user.role,
                        name: user.displayName,
                    },
                    process.env.JWT_ACCESS_SECRET,
                    { expiresIn: "1h" }
                );

                res.json({
                    message: "User registered and logged in",
                    token,
                    user: {
                        email: user.email,
                        role: user.role,
                        displayName: user.displayName,
                    },
                });
            } catch (error) {
                console.error("Registration error:", error);
                res.status(500).json({ error: "Registration failed" });
            }
        });

        app.post("/login", async (req, res) => {
            try {
                const { email } = req.body;
                if (!email) return res.status(400).json({ error: "Email required" });

                const user = await usersCollection.findOne({ email });
                if (!user) return res.status(401).json({ error: "User not found" });

                await usersCollection.updateOne(
                    { email },
                    { $set: { lastSignInTime: new Date().toISOString(), updatedAt: new Date() } }
                );

                const token = jwt.sign(
                    {
                        email: user.email,
                        role: user.role,
                        name: user.displayName || "Anonymous",
                    },
                    process.env.JWT_ACCESS_SECRET,
                    { expiresIn: "1h" }
                );

                res.json({
                    message: "Login successful",
                    token,
                    user: {
                        email: user.email,
                        role: user.role,
                        displayName: user.displayName,
                    },
                });
            } catch (error) {
                console.error("Login error:", error);
                res.status(500).json({ error: "Login failed" });
            }
        });

        app.post("/logout", (req, res) => {
            res.json({ message: "Logged out successfully" });
        });

        // ================= Booking Routes =================
        app.get("/bookings", verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const bookings = await bookingsCollection.aggregate([
                    {
                        $lookup: {
                            from: "users",
                            localField: "email",
                            foreignField: "email",
                            as: "userDetails",
                        },
                    },
                    { $unwind: "$userDetails" },
                    {
                        $lookup: {
                            from: "trainers",
                            localField: "trainerId",
                            foreignField: "_id",
                            as: "trainerDetails",
                        },
                    },
                    { $unwind: "$trainerDetails" },
                    {
                        $project: {
                            _id: 1,
                            email: 1,
                            trainerId: 1,
                            slotId: 1,
                            slotName: 1,
                            slotTime: 1,
                            slotDay: 1,
                            packageId: 1,
                            packageName: 1,
                            packagePrice: 1,
                            sessionType: 1,
                            price: 1,
                            transactionId: 1,
                            paymentStatus: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            userName: "$userDetails.displayName",
                            userEmail: "$userDetails.email",
                            userPhotoURL: "$userDetails.photoURL",
                            userRole: "$userDetails.role",
                            userLastSignInTime: "$userDetails.lastSignInTime",
                            trainerName: "$trainerDetails.name",
                            trainerEmail: "$trainerDetails.email",
                            trainerImage: "$trainerDetails.image",
                            trainerSpecialization: "$trainerDetails.specialization",
                        },
                    },
                ]).toArray();
                res.send(bookings);
            } catch (error) {
                console.error("Failed to fetch bookings:", error);
                res.status(500).send({ error: "Failed to fetch bookings" });
            }
        });

        app.get("/bookings/user/:email", verifyFBToken, async (req, res) => {
            const email = req.params.email;

            if (req.decoded.role !== "admin" && req.decoded.email !== email) {
                return res.status(403).send({ message: "Forbidden: Cannot access other user's bookings" });
            }

            try {
                const bookings = await bookingsCollection.aggregate([
                    { $match: { email } },
                    {
                        $lookup: {
                            from: "users",
                            localField: "email",
                            foreignField: "email",
                            as: "userDetails",
                        },
                    },
                    { $unwind: "$userDetails" },
                    {
                        $lookup: {
                            from: "trainers",
                            localField: "trainerId",
                            foreignField: "_id",
                            as: "trainerDetails",
                        },
                    },
                    { $unwind: "$trainerDetails" },
                    {
                        $project: {
                            _id: 1,
                            email: 1,
                            trainerId: 1,
                            slotId: 1,
                            slotName: 1,
                            slotTime: 1,
                            slotDay: 1,
                            packageId: 1,
                            packageName: 1,
                            packagePrice: 1,
                            sessionType: 1,
                            price: 1,
                            transactionId: 1,
                            paymentStatus: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            userName: "$userDetails.displayName",
                            userEmail: "$userDetails.email",
                            userPhotoURL: "$userDetails.photoURL",
                            userRole: "$userDetails.role",
                            userLastSignInTime: "$userDetails.lastSignInTime",
                            trainerName: "$trainerDetails.name",
                            trainerEmail: "$trainerDetails.email",
                            trainerImage: "$trainerDetails.image",
                            trainerSpecialization: "$trainerDetails.specialization",
                        },
                    },
                ]).toArray();

                res.send(bookings);
            } catch (error) {
                console.error("Failed to fetch user bookings:", error);
                res.status(500).send({ error: "Failed to fetch bookings" });
            }
        });

        app.post('/bookings', verifyFBToken, async (req, res) => {
            try {
                const { email, trainerId, slotId, slotName, slotTime, slotDay, packageId, packageName, packagePrice, sessionType, price, transactionId, paymentStatus } = req.body;

                if (!email || !trainerId || !slotId || !price || !transactionId) {
                    return res.status(400).json({ message: 'Missing required booking data (email, trainerId, slotId, price, transactionId).' });
                }
                if (!ObjectId.isValid(trainerId)) {
                    return res.status(400).json({ message: 'Invalid trainer ID format.' });
                }
                if (typeof price !== 'number' || price <= 0) {
                    return res.status(400).json({ message: 'Price must be a positive number.' });
                }

                if (req.decoded.email !== email) {
                    return res.status(403).json({ message: 'Forbidden: You can only book for your own account.' });
                }

                const bookingDocument = {
                    email,
                    trainerId: new ObjectId(trainerId),
                    slotId,
                    slotName,
                    slotTime: slotTime || null,
                    slotDay: slotDay || null,
                    packageId: packageId || null,
                    packageName: packageName || null,
                    packagePrice: packagePrice || null,
                    sessionType: sessionType || null,
                    price,
                    transactionId,
                    paymentStatus: paymentStatus || "paid",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };

                const bookingResult = await bookingsCollection.insertOne(bookingDocument);
                const newBooking = { _id: bookingResult.insertedId, ...bookingDocument };

                const trainer = await trainerCollection.findOne({ _id: new ObjectId(trainerId) });

                if (!trainer) {
                    await bookingsCollection.deleteOne({ _id: bookingResult.insertedId });
                    return res.status(404).json({ message: 'Trainer not found.' });
                }

                if (trainer.status !== 'accepted') {
                    await bookingsCollection.deleteOne({ _id: bookingResult.insertedId });
                    return res.status(403).json({ message: 'Cannot book this trainer. Trainer is not yet active.' });
                }

                const slotIndex = trainer.slots.findIndex(slot => slot.id === slotId);

                if (slotIndex === -1) {
                    await bookingsCollection.deleteOne({ _id: bookingResult.insertedId });
                    return res.status(404).json({ message: 'Slot not found for this trainer.' });
                }

                if (trainer.slots[slotIndex].isBooked) {
                    await bookingsCollection.deleteOne({ _id: bookingResult.insertedId });
                    return res.status(409).json({ message: 'Slot is already booked.' });
                }

                const updateTrainerResult = await trainerCollection.updateOne(
                    { "_id": new ObjectId(trainerId), "slots.id": slotId },
                    {
                        "$set": {
                            "slots.$.isBooked": true,
                            "updatedAt": new Date()
                        }
                    }
                );

                if (updateTrainerResult.modifiedCount === 0) {
                    await bookingsCollection.deleteOne({ _id: bookingResult.insertedId });
                    return res.status(500).json({ message: 'Failed to update trainer slot status. Booking rolled back.' });
                }

                res.status(201).json({ message: 'Booking successful and slot updated!', booking: newBooking });

            } catch (error) {
                console.error('Booking creation or slot update error:', error);
                res.status(500).json({ message: 'Failed to create booking or update slot.', error: error.message });
            }
        });

        app.patch("/bookings/:id", verifyFBToken, async (req, res) => {
            try {
                const id = req.params.id;
                const { transactionId, paymentStatus } = req.body;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid booking ID format." });
                }

                const booking = await bookingsCollection.findOne({ _id: new ObjectId(id) });
                if (!booking) return res.status(404).send({ message: "Booking not found" });

                if (booking.email !== req.decoded.email && req.decoded.role !== "admin") {
                    return res.status(403).send({ message: "Forbidden: Cannot update others' bookings" });
                }

                const updateFields = { updatedAt: new Date() };
                if (transactionId) updateFields.transactionId = transactionId;
                if (paymentStatus) updateFields.paymentStatus = paymentStatus;

                if (Object.keys(updateFields).length === 1 && updateFields.updatedAt) {
                    return res.status(400).send({ message: "No valid fields to update (transactionId or paymentStatus)." });
                }

                const result = await bookingsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updateFields }
                );

                if (result.modifiedCount === 0 && result.matchedCount === 0) {
                    return res.status(404).send({ message: "Booking found but no changes made." });
                }

                res.send(result);
            } catch (error) {
                console.error("Failed to update booking:", error);
                res.status(500).send({ message: "Failed to update booking" });
            }
        });

        // ================= Payment Routes =================
        app.post("/create-payment-intent", verifyFBToken, async (req, res) => {
            const { amount } = req.body;

            if (!amount || typeof amount !== 'number' || amount <= 0) {
                return res.status(400).send({ message: "Invalid payment amount. Must be a positive number." });
            }

            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: Math.round(amount * 100),
                    currency: "usd",
                    payment_method_types: ["card"],
                });

                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                console.error("Stripe payment intent error:", error);
                res.status(500).send({ message: "Failed to create payment intent" });
            }
        });

        app.post("/payments", verifyFBToken, async (req, res) => {
            try {
                const paymentData = req.body;
                if (!paymentData.transactionId || !paymentData.amount) {
                    return res.status(400).send({ message: "Missing required payment data (transactionId, amount)." });
                }

                const payment = {
                    ...paymentData,
                    email: req.decoded.email,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };

                const result = await paymentsCollection.insertOne(payment);
                res.status(201).send(result);
            } catch (error) {
                console.error("Failed to store payment:", error);
                res.status(500).send({ message: "Failed to store payment" });
            }
        });

    } finally {
    }
}

run().catch(console.dir);

app.get("/", (req, res) => {
    res.send("FitFlow Backend Server Running");
});

app.listen(port, () => {
    console.log(`FitFlow Backend Server Running on port ${port}`);
});