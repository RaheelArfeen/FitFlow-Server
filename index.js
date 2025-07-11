// imports
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
dotenv.config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb"); // Keep ObjectId from mongodb
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

// Firebase Admin Init
// Make sure firebase-service-account.json is in the same directory as index.js
const serviceAccount = require("./firebase-service-account.json");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

// Mongo URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.hqacvhm.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// Middleware
app.use(
    cors({
        origin: ["http://localhost:5173", "https://your-frontend-domain.com"], // Add your production frontend URL here
        credentials: true,
    })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ================= Middleware Utils =================
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
        console.error("Firebase token verification error:", error); // Log error for debugging
        res.status(403).send({ message: "Forbidden: Invalid Firebase token" });
    }
};


const verifyAdmin = async (req, res, next) => {
    const email = req.decoded?.email;

    const user = await req.usersCollection.findOne({ email });

    if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden: Not an admin" });
    }

    next();
};


// ================= MongoDB connection and routes =================
async function run() {
    try {
        // Connect the client to the server (optional starting in v4.7)
        await client.connect();
        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });

        const db = client.db("fitflowDB");
        const usersCollection = db.collection("users");
        const trainerCollection = db.collection("trainers");
        const bookingsCollection = db.collection("bookings");
        const paymentsCollection = db.collection("payments");
        const communityCollection = db.collection("community");
        const applicationsCollection = db.collection("applications"); // For trainer applications

        // Global middleware to attach collections to request object
        app.use((req, res, next) => {
            req.usersCollection = usersCollection;
            req.trainerCollection = trainerCollection;
            req.bookingsCollection = bookingsCollection;
            req.paymentsCollection = paymentsCollection;
            req.communityCollection = communityCollection;
            req.applicationsCollection = applicationsCollection;
            next();
        });

        // ================= Trainers routes =================
        app.get("/trainers", async (req, res) => {
            try {
                const trainers = await req.trainerCollection.find({}).toArray();
                res.send(trainers);
            } catch (error) {
                console.error("Failed to fetch trainers:", error);
                res.status(500).send({ message: "Failed to fetch trainers" });
            }
        });

        // Add a new trainer (from approved application)
        app.post("/trainers", async (req, res) => {
            try {
                const trainerData = req.body;

                console.log("Received trainer data:", trainerData);

                // Basic validation
                if (!trainerData?.email || !trainerData?.name) {
                    return res.status(400).send({ message: "Missing required trainer fields." });
                }

                const newTrainer = {
                    ...trainerData,
                    role: "trainer",
                    status: "accepted",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };

                const result = await req.trainerCollection.insertOne(newTrainer);
                res.status(201).send(result);
            } catch (error) {
                console.error("Error adding new trainer:", error.message, error.stack);
                res.status(500).send({ message: "Failed to add trainer." });
            }
        });

        app.get("/trainers/:id", async (req, res) => {
            try {
                const trainer = await req.trainerCollection.findOne({ _id: new ObjectId(req.params.id) });
                if (!trainer) return res.status(404).send({ message: "Trainer not found" });
                res.send(trainer);
            } catch (error) {
                console.error("Failed to fetch trainer by ID:", error);
                res.status(500).send({ message: "Failed to fetch trainer" });
            }
        });

        // ========== Trainer Ratings ==========
        app.get("/trainers/rating/:id", verifyFBToken, async (req, res) => {
            const trainerId = req.params.id;
            const userEmail = req.decoded.email;

            try {
                const trainer = await req.trainerCollection.findOne(
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

            try {
                const trainer = await req.trainerCollection.findOne({ _id: new ObjectId(trainerId) });

                if (!trainer) {
                    return res.status(404).send({ success: false, message: "Trainer not found" });
                }

                const alreadyRated = trainer.ratings?.find((r) => r.email === userEmail);
                if (alreadyRated) {
                    return res.send({ success: false, message: "You already rated this trainer." });
                }

                const newRating = {
                    email: userEmail,
                    name: req.decoded.name || "Anonymous",
                    rating,
                    date: new Date(),
                };

                const updatedRatings = [...(trainer.ratings || []), newRating];
                const avgRating =
                    updatedRatings.reduce((sum, r) => sum + r.rating, 0) / updatedRatings.length;

                const result = await req.trainerCollection.updateOne(
                    { _id: new ObjectId(trainerId) },
                    {
                        $set: {
                            ratings: updatedRatings,
                            rating: avgRating,
                            updatedAt: new Date(), // Update timestamp
                        },
                    }
                );

                res.send({ success: true, message: "Rating submitted", result });
            } catch (error) {
                console.error("Error submitting rating:", error);
                res.status(500).send({ success: false, message: "Failed to submit rating" });
            }
        });

        // ================= Community routes ====================
        app.get('/community', async (req, res) => {
            try {
                const posts = await req.communityCollection.find().sort({ createdAt: -1 }).toArray();
                res.send(posts);
            } catch (error) {
                console.error('Error fetching community posts:', error);
                res.status(500).send({ message: 'Failed to fetch posts.' });
            }
        });

        app.get('/community/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const post = await req.communityCollection.findOne({ _id: new ObjectId(id) });

                if (!post) {
                    return res.status(404).send({ message: 'Post not found.' });
                }

                res.send(post);
            } catch (error) {
                console.error('Error fetching post by ID:', error);
                res.status(500).send({ message: 'Failed to fetch post.' });
            }
        });

        app.post("/community", verifyFBToken, async (req, res) => {
            try {
                const { title, content, category, tags, author, authorPhoto, authorRole, email } = req.body;

                const post = {
                    title,
                    content,
                    category,
                    tags: tags || [], // Ensure tags is an array
                    author,
                    authorPhoto,
                    authorRole,
                    email,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    likes: 0,
                    dislikes: 0,
                    comments: [],
                    votes: [], // Initialize votes array
                };

                const result = await req.communityCollection.insertOne(post);
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

                if (!commentText || commentText.trim() === "") {
                    return res.status(400).send({ message: "Comment text is required" });
                }

                const user = await req.usersCollection.findOne({ email: userEmail });
                if (!user) return res.status(404).send({ message: "User not found" });

                const newComment = {
                    _id: new ObjectId(), // Unique ID for comment
                    text: commentText,
                    author: user.displayName || "Anonymous",
                    authorPhoto: user.photoURL || "",
                    authorRole: user.role || "member",
                    email: user.email,
                    createdAt: new Date(),
                };

                // Add comment and update updatedAt
                const result = await req.communityCollection.updateOne(
                    { _id: new ObjectId(postId) },
                    {
                        $push: { comments: newComment },
                        $set: { updatedAt: new Date() } // update post timestamp
                    }
                );

                if (result.modifiedCount === 0) {
                    return res.status(404).send({ message: "Post not found or comment not added" });
                }

                // Return updated post with sorted comments (newest first)
                const updatedPost = await req.communityCollection.findOne({ _id: new ObjectId(postId) });

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
                const userEmail = req.decoded.email; // Email of the currently authenticated user

                // 1. Find the post
                const post = await req.communityCollection.findOne({ _id: new ObjectId(postId) });

                if (!post) {
                    return res.status(404).send({ message: "Post not found." });
                }

                // 2. Find the comment within the post's comments array
                const commentIndex = post.comments.findIndex(
                    (comment) => comment._id.toString() === commentId // Convert ObjectId to string for comparison
                );

                if (commentIndex === -1) {
                    return res.status(404).send({ message: "Comment not found on this post." });
                }

                // 3. Authorization check: Ensure the user trying to delete is the comment author
                if (post.comments[commentIndex].email !== userEmail) {
                    return res.status(403).send({ message: "Forbidden: You are not the author of this comment." });
                }

                // 4. Remove the comment from the array
                post.comments.splice(commentIndex, 1);

                // 5. Update the post in the database
                const result = await req.communityCollection.updateOne(
                    { _id: new ObjectId(postId) },
                    {
                        $set: {
                            comments: post.comments,
                            updatedAt: new Date(), // Update the post's last modified timestamp
                        },
                    }
                );

                if (result.modifiedCount === 0) {
                    // This might happen if the post was found but not updated for some reason (e.g., no actual change)
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

                if (!postId || !["like", "dislike", null].includes(voteType)) {
                    return res.status(400).json({ message: "Invalid vote type or postId" });
                }

                const post = await communityCollection.findOne({ _id: new ObjectId(postId) });
                if (!post) return res.status(404).json({ message: "Post not found" });

                let votes = post.votes || [];
                const existingVote = votes.find((v) => v.email === email);
                let updatedVotes;

                if (existingVote) {
                    // Remove current vote
                    votes = votes.filter((v) => v.email !== email);
                }

                // Add new vote if not null
                if (voteType) {
                    votes.push({ email, type: voteType });
                }

                // Recalculate counts
                const likes = votes.filter((v) => v.type === "like").length;
                const dislikes = votes.filter((v) => v.type === "dislike").length;

                // Save to DB
                await communityCollection.updateOne(
                    { _id: new ObjectId(postId) },
                    {
                        $set: {
                            votes,
                            likes,
                            dislikes,
                        },
                    }
                );

                res.json({ message: "Vote updated" });
            } catch (err) {
                console.error("Vote error:", err);
                res.status(500).json({ message: "Internal server error" });
            }
        });

        // ================= Users routes =================
        app.get("/users", async (req, res) => {
            try {
                const users = await req.usersCollection.find().toArray();
                res.send(users);
            } catch (error) {
                console.error("Failed to fetch users:", error);
                res.status(500).send({ message: "Failed to fetch users" });
            }
        });

        app.get("/users/:email", async (req, res) => {
            try {
                const user = await req.usersCollection.findOne({ email: req.params.email });
                if (!user) return res.status(404).send({ message: "User not found" });
                res.send(user);
            } catch (error) {
                console.error("Failed to fetch user by email:", error);
                res.status(500).send({ message: "Failed to fetch user" });
            }
        });

        app.get("/users/role/:email", async (req, res) => {
            try {
                const user = await req.usersCollection.findOne({ email: req.params.email });
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
                const result = await req.usersCollection.updateOne(
                    { email },
                    {
                        $set: {
                            displayName,
                            photoURL,
                            lastSignInTime,
                            role,
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

        app.patch("/users", async (req, res) => {
            try {
                const { email, lastSignInTime, role } = req.body;

                if (!email) {
                    return res.status(400).send({ message: "Email is required" });
                }

                const updateFields = {};
                if (lastSignInTime) updateFields.lastSignInTime = lastSignInTime;
                if (role) updateFields.role = role;

                if (Object.keys(updateFields).length === 0) {
                    return res.status(400).send({ message: "No valid fields to update" });
                }

                const result = await req.usersCollection.updateOne(
                    { email },
                    { $set: updateFields }
                );

                res.send(result);
            } catch (error) {
                console.error("Failed to update user:", error);
                res.status(500).send({ message: "Failed to update user" });
            }
        });

        // ================= JWT Auth routes =================
        app.post("/register", async (req, res) => {
            try {
                const { email, displayName, photoURL, lastSignInTime } = req.body;
                if (!email) return res.status(400).json({ error: "Email required" });

                await req.usersCollection.updateOne(
                    { email },
                    {
                        $set: {
                            email,
                            displayName,
                            photoURL,
                            lastSignInTime: lastSignInTime || new Date().toISOString(),
                            role: "member",
                        },
                    },
                    { upsert: true }
                );

                const user = await req.usersCollection.findOne({ email });

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

                const user = await req.usersCollection.findOne({ email });
                if (!user) return res.status(401).json({ error: "User not found" });

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
            res.json({ message: "Logged out" });
        });

        // ================= Bookings =================
        // Get all bookings with user data (admin only)
        app.get("/bookings", verifyAdmin, async (req, res) => {
            try {
                const bookings = await req.bookingsCollection.aggregate([
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
                ]).toArray(); // .toArray() is necessary for native driver aggregate
                res.send(bookings);
            } catch (error) {
                console.error("Failed to fetch bookings:", error);
                res.status(500).send({ error: "Failed to fetch bookings" });
            }
        });

        // Get bookings by user email (self or admin)
        app.get("/bookings/user/:email", verifyFBToken, async (req, res) => {
            const email = req.params.email;

            if (req.decoded.role !== "admin" && req.decoded.email !== email) {
                return res.status(403).send({ message: "Forbidden: Cannot access other user's bookings" });
            }

            try {
                const bookings = await req.bookingsCollection.aggregate([
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

        // Create a booking
        app.post('/bookings', verifyFBToken, async (req, res) => {
            try {
                const { email, trainerId, slotId, slotName, slotTime, slotDay, packageId, packageName, packagePrice, sessionType, price, transactionId, paymentStatus } = req.body;

                // Input validation (basic)
                if (!email || !trainerId || !slotId || !price || !transactionId) {
                    return res.status(400).json({ message: 'Missing required booking data.' });
                }

                // Check if user is trying to book for themselves
                if (req.decoded.email !== email) {
                    return res.status(403).json({ message: 'Forbidden: You can only book for your own account.' });
                }

                // Prepare booking document
                const bookingDocument = {
                    email,
                    trainerId: new ObjectId(trainerId), // Ensure trainerId is an ObjectId
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

                // Insert the new booking
                const bookingResult = await req.bookingsCollection.insertOne(bookingDocument);
                const newBooking = { _id: bookingResult.insertedId, ...bookingDocument }; // Construct the inserted doc

                // Find the trainer and update the slot status
                const trainer = await req.trainerCollection.findOne({ _id: new ObjectId(trainerId) });

                if (!trainer) {
                    // Rollback the booking if trainer is not found
                    await req.bookingsCollection.deleteOne({ _id: bookingResult.insertedId });
                    return res.status(404).json({ message: 'Trainer not found.' });
                }

                // Find the index of the slot to update
                const slotIndex = trainer.slots.findIndex(slot => slot.id === slotId);

                if (slotIndex === -1) {
                    // Rollback the booking if slot is not found
                    await req.bookingsCollection.deleteOne({ _id: bookingResult.insertedId });
                    return res.status(404).json({ message: 'Slot not found for this trainer.' });
                }

                if (trainer.slots[slotIndex].isBooked) {
                    // This is a race condition. If already booked, prevent double booking
                    // Rollback the newBooking
                    await req.bookingsCollection.deleteOne({ _id: bookingResult.insertedId });
                    return res.status(409).json({ message: 'Slot is already booked.' });
                }

                // Update the specific slot's isBooked status
                const updateTrainerResult = await req.trainerCollection.updateOne(
                    { "_id": new ObjectId(trainerId), "slots.id": slotId },
                    {
                        "$set": {
                            "slots.$.isBooked": true, // Using positional operator to update the matched element
                            "updatedAt": new Date()
                        }
                    }
                );

                if (updateTrainerResult.modifiedCount === 0) {
                    // If for some reason the slot wasn't updated (e.g., another process changed it)
                    await req.bookingsCollection.deleteOne({ _id: bookingResult.insertedId });
                    return res.status(500).json({ message: 'Failed to update trainer slot status.' });
                }

                res.status(201).json({ message: 'Booking successful and slot updated!', booking: newBooking });

            } catch (error) {
                console.error('Booking creation or slot update error:', error);
                res.status(500).json({ message: 'Failed to create booking or update slot.', error: error.message });
            }
        });

        // Update booking payment status and transactionId
        app.patch("/bookings/:id", verifyFBToken, async (req, res) => {
            try {
                const id = req.params.id;
                const { transactionId, paymentStatus } = req.body;

                const booking = await req.bookingsCollection.findOne({ _id: new ObjectId(id) });
                if (!booking) return res.status(404).send({ message: "Booking not found" });

                // Allow user to update their own booking's payment status, or admin can
                if (booking.email !== req.decoded.email && req.decoded.role !== "admin") {
                    return res.status(403).send({ message: "Forbidden: Cannot update others' bookings" });
                }

                const result = await req.bookingsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { transactionId, paymentStatus, updatedAt: new Date() } }
                );

                res.send(result);
            } catch (error) {
                console.error("Failed to update booking:", error);
                res.status(500).send({ message: "Failed to update booking" });
            }
        });

        // ================= Payments =================
        app.post("/create-payment-intent", verifyFBToken, async (req, res) => {
            const { amount } = req.body;

            if (!amount || amount <= 0) {
                return res.status(400).send({ message: "Invalid payment amount" });
            }

            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: Math.round(amount * 100), // Stripe expects amount in cents
                    currency: "usd",
                    payment_method_types: ["card"],
                });

                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                console.error("Stripe payment intent error:", error);
                res.status(500).send({ message: "Failed to create payment intent" });
            }
        });

        // Store payment info after success
        app.post("/payments", verifyFBToken, async (req, res) => {
            try {
                const payment = {
                    ...req.body,
                    email: req.decoded.email,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };

                const result = await req.paymentsCollection.insertOne(payment);
                res.status(201).send(result);
            } catch (error) {
                console.error("Failed to store payment:", error);
                res.status(500).send({ message: "Failed to store payment" });
            }
        });

        // Application related routes (Trainer Application)
        app.post("/applications/trainer", verifyFBToken, async (req, res) => {
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
                    availableSlots,
                    availableDays,
                    sessions,
                    social,
                    rating,
                    comments,
                    slots,
                    ratings
                } = req.body;

                // Prevent duplicate application
                const existingApplication = await req.applicationsCollection.findOne({ email });
                if (existingApplication) {
                    return res.status(409).send({ message: "You have already submitted a trainer application." });
                }

                // Only allow self-application
                if (req.decoded.email !== email) {
                    return res.status(403).send({ message: "Forbidden: Cannot apply for others." });
                }

                const newApplication = {
                    email,
                    name,
                    age,
                    experience,
                    photoURL,
                    specialization,
                    description,
                    certifications: certifications || [],
                    availableSlots: availableSlots || [],
                    availableDays: availableDays || [],
                    sessions: sessions || 0,
                    social: social || { instagram: '', twitter: '', linkedin: '' },
                    rating: rating || 0,
                    comments: comments || [],
                    slots: slots || [],
                    ratings: ratings || [],
                    role: "trainer",
                    status: "pending",
                    appliedAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };

                const result = await req.applicationsCollection.insertOne(newApplication);
                res.status(201).send(result);
            } catch (error) {
                console.error("Error submitting trainer application:", error);
                res.status(500).send({ message: "Failed to submit application." });
            }
        });

        app.delete("/applications/trainer/:id", async (req, res) => {
            try {
                const id = req.params.id;
                const feedback = req.body?.feedback;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid application ID." });
                }

                const query = { _id: new ObjectId(id) };
                const applicationToDelete = await req.applicationsCollection.findOne(query);

                if (!applicationToDelete) {
                    return res.status(404).send({ message: "Application not found." });
                }

                const result = await req.applicationsCollection.deleteOne(query);

                if (result.deletedCount === 1) {
                    if (feedback) {
                        console.log(`Application ${id} rejected with feedback: ${feedback}`);
                    }
                    res.send({ message: "Application deleted successfully." });
                } else {
                    res.status(500).send({ message: "Failed to delete application." });
                }
            } catch (error) {
                console.error("Error deleting trainer application:", error);
                res.status(500).send({ message: "Failed to delete application." });
            }
        });

        // Get all trainer applications (Admin only)
        app.get("/applications/trainer",  async (req, res) => {
            try {
                const applications = await req.applicationsCollection.find({}).toArray();
                res.send(applications);
            } catch (error) {
                console.error("Error fetching trainer applications:", error);
                res.status(500).send({ message: "Failed to fetch applications." });
            }
        });

        // Send a ping to confirm a successful connection
        // await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close(); // Only close if you want to explicitly disconnect
    }
}

// Call the run function to connect to DB and start the server
run().catch(console.dir);


app.get("/", (req, res) => {
    res.send("FitFlow Backend Server Running");
});

app.listen(port, () => {
    console.log(`FitFlow Backend Server Running on port ${port}`);
});