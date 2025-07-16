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

// ================= Verify Firebase Token Middleware =================
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

// ================= Verify Admin Role Middleware =================
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
        const classesCollection = db.collection("classes");
        const newsLetterCollection = db.collection("newsletters");
        const reviewsCollection = db.collection("reviews");

        // ================= Trainer Routes =================
        app.get("/trainers", async (req, res) => {
            try {
                const { status, email } = req.query;
                let query = {};

                if (status) {
                    query.status = status;
                }
                if (email) {
                    query.email = email;
                }

                const trainers = await trainerCollection.find(query).toArray();

                const trainersWithTotalBookings = trainers.map(trainer => {
                    const totalBookings = (trainer.slots || []).reduce((acc, slot) => acc + (slot.bookingCount || 0), 0);
                    return { ...trainer, totalBookings };
                });

                res.send(trainersWithTotalBookings);
            } catch (error) {
                console.error("Failed to fetch trainers:", error);
                res.status(500).send({ message: "Failed to fetch trainers" });
            }
        });

        app.get("/trainers/slots/byEmail/:email", async (req, res) => {
            try {
                const { email } = req.params;

                const trainer = await trainerCollection.findOne(
                    { email: email },
                    { projection: { slots: 1, _id: 0 } }
                );

                if (!trainer) {
                    return res.status(404).send({ message: "Trainer not found for the given email." });
                }

                if (!trainer.slots) {
                    return res.status(200).send([]);
                }

                res.status(200).send(trainer.slots);

            } catch (error) {
                console.error("Error fetching trainer slots by email:", error.message, error.stack);
                res.status(500).send({ message: "Failed to fetch trainer slots by email." });
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
                    slots
                } = req.body;

                if (!email || !name || !specialization || !description || !photoURL) {
                    return res.status(400).send({ message: "Missing required application fields (email, name, specialization, description, photoURL)." });
                }

                if (slots !== undefined && !Array.isArray(slots)) {
                    return res.status(400).send({ message: "If provided, 'slots' must be an array for trainer application." });
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

        app.get("/trainers/slots/:trainerId", async (req, res) => {
            try {
                const { trainerId } = req.params;

                if (!trainerId || !ObjectId.isValid(trainerId)) {
                    return res.status(400).send({ message: "Invalid trainer ID format." });
                }

                const trainer = await trainerCollection.findOne(
                    { _id: new ObjectId(trainerId) },
                    { projection: { slots: 1, _id: 0 } }
                );

                if (!trainer) {
                    return res.status(404).send({ message: "Trainer not found." });
                }

                if (!trainer.slots) {
                    return res.status(200).send([]);
                }

                res.status(200).send(trainer.slots);

            } catch (error) {
                console.error("Error fetching trainer slots:", error.message, error.stack);
                res.status(500).send({ message: "Failed to fetch trainer slots." });
            }
        });

        app.post("/trainers/slots", verifyFBToken, async (req, res) => {
            try {
                const {
                    slotName,
                    slotTime,
                    days,
                    duration,
                    classType,
                    maxParticipants,
                    description,
                    trainerId,
                    email
                } = req.body;

                if (!slotName || !slotTime || !days || !Array.isArray(days) || days.length === 0 || !duration || !classType || !trainerId || !email) {
                    return res.status(400).send({ message: "Missing required slot details or invalid 'days' format. Required: slotName, slotTime, days (array), duration, classType, trainerId, email." });
                }

                if (req.decoded.email !== email) {
                    return res.status(403).send({ message: "Forbidden: You can only add slots for your own trainer profile." });
                }

                const trainer = await trainerCollection.findOne({ _id: new ObjectId(trainerId) });

                if (!trainer) {
                    return res.status(404).send({ message: "Trainer not found." });
                }

                if (trainer.email !== email) {
                    return res.status(403).send({ message: "Unauthorized: Trainer email mismatch for provided ID." });
                }

                const newSlot = {
                    id: Date.now().toString(),
                    slotName,
                    slotTime,
                    days,
                    duration,
                    classType,
                    maxParticipants: parseInt(maxParticipants) || 10,
                    description: description || "",
                    bookingCount: 0,
                    bookedMembers: [],
                    createdAt: new Date(),
                };

                const result = await trainerCollection.updateOne(
                    { _id: new ObjectId(trainerId) },
                    {
                        $push: { slots: newSlot },
                        $set: { updatedAt: new Date() }
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ message: "Trainer not found or update failed." });
                }
                if (result.modifiedCount === 0) {
                    return res.status(500).send({ message: "Failed to add slot (no modification occurred on trainer document)." });
                }

                res.status(201).send({ message: "Slot added successfully!", slot: newSlot });

            } catch (error) {
                console.error("Error adding slot to trainer profile:", error.message, error.stack);
                res.status(500).send({ message: "Failed to add slot to trainer profile." });
            }
        });

        app.delete("/trainers/slots/:slotId", verifyFBToken, async (req, res) => {
            try {
                const { slotId } = req.params;
                const trainerEmail = req.decoded.email;
                const trainer = await trainerCollection.findOne({
                    email: trainerEmail,
                    "slots.id": slotId
                });

                if (!trainer) {
                    return res.status(404).send({ message: "Slot not found or you are not authorized to delete this slot." });
                }

                const result = await trainerCollection.updateOne(
                    { _id: trainer._id },
                    { $pull: { slots: { id: slotId } } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ message: "Trainer not found or slot already deleted." });
                }

                if (result.modifiedCount === 0) {
                    return res.status(500).send({ message: "Failed to delete slot (no modification occurred)." });
                }

                res.status(200).send({ message: "Slot deleted successfully!" });

            } catch (error) {
                console.error("Error deleting slot:", error.message, error.stack);
                res.status(500).send({ message: "Failed to delete slot." });
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

        // ================= Review Routes =================
        app.post('/reviews', verifyFBToken, async (req, res) => {
            try {
                const { trainerId, reviewerEmail, reviewerName, trainerEmail, trainerName, rating, createdAt, } = req.body;
                const comment = req.body.comment;

                if (req.decoded.email !== reviewerEmail) {
                    return res.status(403).send({ message: "Forbidden: You can only submit reviews for your own account." });
                }

                if (!trainerId || !reviewerEmail || !reviewerName ||
                    !trainerEmail || !trainerName || typeof rating === 'undefined') {
                    return res.status(400).send({ message: "Missing required review data (trainerId, reviewerEmail, reviewerName, trainerEmail, trainerName, rating)." });
                }
                if (!ObjectId.isValid(trainerId)) {
                    return res.status(400).send({ message: "Invalid Trainer ID format." });
                }
                if (typeof rating !== 'number' || rating < 1 || rating > 5) {
                    return res.status(400).send({ message: "Rating must be a number between 1 and 5." });
                }

                const existingDetailedReview = await reviewsCollection.findOne({
                    reviewerEmail: reviewerEmail,
                });

                if (existingDetailedReview) {
                    return res.status(409).send({ message: "A detailed review for this booking by your account already exists." });
                }

                const reviewDocument = {
                    trainerId: new ObjectId(trainerId),
                    reviewerEmail: reviewerEmail,
                    reviewerName: reviewerName,
                    trainerEmail: trainerEmail,
                    trainerName: trainerName,
                    rating: rating,
                    createdAt: new Date(createdAt || Date.now()),
                    updatedAt: new Date(),
                };

                if (comment && comment.trim() !== '') {
                    reviewDocument.comment = comment.trim();
                }

                const result = await reviewsCollection.insertOne(reviewDocument);
                const newReview = { _id: result.insertedId, ...reviewDocument };

                const updateBookingResult = await bookingsCollection.updateOne(
                    { $set: { hasReviewed: true, reviewSubmittedAt: new Date() } }
                );

                res.status(201).send({ message: "Detailed review submitted successfully!", review: newReview });

            } catch (error) {
                console.error("Error submitting detailed review:", error);
                if (error.code === 11000) {
                    return res.status(409).send({ message: "A detailed review for this booking by your account already exists (database conflict)." });
                }
                res.status(500).send({ message: "Failed to submit detailed review.", error: error.message });
            }
        });

        app.get("/reviews", async (req, res) => {
            try {
                const trainerId = req.query.trainerId;

                let query = {};
                if (trainerId) {
                    if (!ObjectId.isValid(trainerId)) {
                        return res.status(400).send({ message: "Invalid Trainer ID format for query." });
                    }
                    query.trainerId = new ObjectId(trainerId);
                }

                const reviews = await reviewsCollection.find(query).sort({ createdAt: -1 }).toArray();

                res.status(200).send(reviews);

            } catch (error) {
                console.error("Error fetching reviews:", error);
                res.status(500).send({ message: "Failed to fetch reviews.", error: error.message });
            }
        });

        // ================= Class Routes =================
        app.get("/classes", async (req, res) => {
            try {
                const classes = await classesCollection.find().toArray();
                res.send(classes);
            } catch (error) {
                console.error("Failed to fetch classes:", error);
                res.status(500).send({ message: "Failed to fetch classes" });
            }
        });

        app.get("/classes/:id", async (req, res) => {
            try {
                const id = req.params.id;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid class ID." });
                }

                const classItem = await classesCollection.findOne({ _id: new ObjectId(id) });

                if (!classItem) {
                    return res.status(404).send({ message: "Class not found." });
                }

                classItem._id = classItem._id.toString();

                res.send(classItem);
            } catch (error) {
                console.error("Failed to fetch class by ID:", error);
                res.status(500).send({ message: "Failed to fetch class." });
            }
        });

        app.post("/classes", verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const {
                    name,
                    image,
                    description,
                    duration,
                    difficulty,
                    category,
                    maxParticipants,
                    equipment,
                    prerequisites,
                    benefits,
                    schedule,
                    trainers
                } = req.body;

                if (!name || !category || !description || !duration || !image || !difficulty || !Array.isArray(trainers) || trainers.length === 0) {
                    return res.status(400).send({ message: "Missing required class fields: name, category, description, duration, image, difficulty, and at least one trainer." });
                }

                const invalidTrainers = trainers.filter(trainer =>
                    !trainer.name || !trainer.email || !trainer.id || typeof trainer.bookingsCount !== 'number'
                );

                if (invalidTrainers.length > 0) {
                    return res.status(400).send({ message: "Each trainer must have a name (string), email (string), id (string), and bookingsCount (number)." });
                }

                const totalTrainerBookings = trainers.reduce((sum, trainer) => {
                    return sum + (trainer.bookingsCount || 0);
                }, 0);

                const newClass = {
                    name,
                    image,
                    description,
                    duration,
                    difficulty,
                    category,
                    maxParticipants: maxParticipants || null,
                    equipment: equipment || null,
                    prerequisites: prerequisites || null,
                    benefits: benefits || null,
                    schedule: schedule || null,
                    trainers: trainers.map(trainer => ({
                        name: trainer.name,
                        email: trainer.email,
                        id: trainer.id,
                        bookingsCount: trainer.bookingsCount
                    })),
                    bookings: totalTrainerBookings,
                    createdBy: req.decoded.email,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };

                const result = await classesCollection.insertOne(newClass);
                res.status(201).send({ message: "Class added successfully!", insertedId: result.insertedId });

            } catch (error) {
                console.error("Error adding class:", error);
                res.status(500).send({ message: "Failed to add class." });
            }
        });

        // ================= Community Routes =================
        app.get("/community", async (req, res) => {
            try {
                const posts = await communityCollection.find().sort({ createdAt: -1 }).toArray();
                res.status(200).send(posts);
            } catch (error) {
                console.error("Error fetching community posts:", error);
                res.status(500).send({ message: "Failed to fetch posts." });
            }
        });

        app.get('/community/pagination', async (req, res) => {
            try {
                const page = parseInt(req.query.page);
                const limit = parseInt(req.query.limit);

                if (!isNaN(page) && !isNaN(limit)) {
                    const skip = (page - 1) * limit;

                    const totalPostsCount = await communityCollection.countDocuments();

                    const posts = await communityCollection
                        .find()
                        .sort({ createdAt: -1 })
                        .skip(skip)
                        .limit(limit)
                        .toArray();

                    const totalPages = Math.ceil(totalPostsCount / limit);

                    return res.send({
                        posts,
                        totalCount: totalPostsCount,
                        totalPages,
                        currentPage: page,
                    });
                }

                const posts = await communityCollection
                    .find()
                    .sort({ createdAt: -1 })
                    .toArray();

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

        // ================ Newsletter Routes ================
        app.get('/newsletter', async (req, res) => {
            try {
                const subscribers = await newsLetterCollection.find().sort({ createdAt: -1 }).toArray();

                const subscribersWithRole = await Promise.all(
                    subscribers.map(async (subscriber) => {
                        const user = await usersCollection.findOne({ email: subscriber.email });
                        return {
                            ...subscriber,
                            userRole: user?.role || 'Subscriber',
                        };
                    })
                );

                res.status(200).json(subscribersWithRole);
            } catch (err) {
                console.error('GET /newsletter error:', err);
                res.status(500).json({ message: 'Failed to retrieve subscribers' });
            }
        });

        app.post('/newsletter', async (req, res) => {
            try {
                const { name, email } = req.body;

                if (!name || !email) {
                    return res.status(400).json({ message: 'Name and email are required.' });
                }

                const exists = await newsLetterCollection.findOne({ email });
                if (exists) {
                    return res.status(409).json({ message: 'You are already subscribed.' });
                }

                const newSubscriber = {
                    name,
                    email,
                    createdAt: new Date(),
                };

                await newsLetterCollection.insertOne(newSubscriber);

                res.status(201).json({ message: 'Successfully subscribed!' });
            } catch (err) {
                console.error('POST /newsletter error:', err);
                res.status(500).json({ message: 'Server error' });
            }
        });

        app.delete('/newsletter/:id', async (req, res) => {
            try {
                const { id } = req.params;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ message: "Invalid subscriber ID format." });
                }

                const result = await newsLetterCollection.deleteOne({ _id: new ObjectId(id) });

                if (result.deletedCount === 1) {
                    res.status(200).json({ message: 'Subscriber deleted successfully.' });
                } else {
                    res.status(404).json({ message: 'Subscriber not found.' });
                }
            } catch (err) {
                console.error('DELETE /newsletter/:id error:', err);
                res.status(500).json({ message: 'Failed to delete subscriber.' });
            }
        });

        // ================= User Routes =================
        app.get("/users", async (req, res) => {
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
                const {
                    email,
                    displayName,
                    photoURL,
                    lastSignInTime,
                    role = "member",
                    location = "",
                    bio = "",
                    fitnessGoals = ""
                } = req.body;

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
                            location,
                            bio,
                            fitnessGoals,
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

        app.patch("/users", async (req, res) => {
            try {
                const {
                    email,
                    lastSignInTime,
                    role,
                    location,
                    bio,
                    fitnessGoals
                } = req.body;

                if (!email) {
                    return res.status(400).send({ message: "Email is required for update." });
                }

                const updateFields = { updatedAt: new Date() };
                if (lastSignInTime !== undefined) updateFields.lastSignInTime = lastSignInTime;
                if (role !== undefined) updateFields.role = role;
                if (location !== undefined) updateFields.location = location;
                if (bio !== undefined) updateFields.bio = bio;
                if (fitnessGoals !== undefined) updateFields.fitnessGoals = fitnessGoals;

                if (Object.keys(updateFields).length === 1 && updateFields.updatedAt) {
                    return res.status(400).send({ message: "No valid fields to update." });
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
                const {
                    email,
                    displayName,
                    photoURL,
                    lastSignInTime,
                    location = "",
                    bio = "",
                    fitnessGoals = ""
                } = req.body;

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
                            location,
                            bio,
                            fitnessGoals,
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
                        photoURL: user.photoURL,
                        location: user.location || "",
                        bio: user.bio || "",
                        fitnessGoals: user.fitnessGoals || "",
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
                        photoURL: user.photoURL,
                        location: user.location || "",
                        bio: user.bio || "",
                        fitnessGoals: user.fitnessGoals || "",
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
        app.get("/bookings", async (req, res) => {
            try {
                const queryEmail = req.query.email;
                const queryRole = req.query.role;

                let pipeline = [
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
                            hasReviewed: 1,
                            reviewSubmittedAt: 1,
                            userName: "$userDetails.displayName",
                            userEmail: "$userDetails.email",
                            userPhotoURL: "$userDetails.photoURL",
                            userRole: "$userDetails.role",
                            userLastSignInTime: "$userDetails.lastSignInTime",
                            trainerName: "$trainerDetails.name",
                            trainerEmail: "$trainerDetails.email",
                            trainerPhotoURL: "$trainerDetails.photoURL",
                            trainerSpecialization: "$trainerDetails.specialization",
                        },
                    },
                ];

                if (queryEmail) {
                    if (queryRole === 'trainer') {
                        pipeline.unshift({
                            $match: { trainerEmail: queryEmail }
                        });
                    } else {
                        pipeline.unshift({
                            $match: { email: queryEmail }
                        });
                    }
                }

                const bookings = await bookingsCollection.aggregate(pipeline).toArray();

                const totalRevenue = bookings.reduce((sum, b) => sum + (b.price || 0), 0);

                res.send({ bookings, totalRevenue });
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
                    { $match: { email: email } },
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
                            hasReviewed: 1,
                            reviewSubmittedAt: 1,
                            userName: "$userDetails.displayName",
                            userEmail: "$userDetails.email",
                            userPhotoURL: "$userDetails.photoURL",
                            userRole: "$userDetails.role",
                            userLastSignInTime: "$userDetails.lastSignInTime",
                            trainerName: "$trainerDetails.name",
                            trainerEmail: "$trainerDetails.email",
                            trainerPhotoURL: "$trainerDetails.photoURL",
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
                const {
                    email, trainerId, slotId, slotName, slotTime,
                    slotDuration,
                    description,
                    slotDay, packageId, packageName, packagePrice, sessionType,
                    price, transactionId, paymentStatus, memberInfo
                } = req.body;

                if (!email || !trainerId || !slotId || typeof price === 'undefined' || !transactionId) {
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

                const trainerAndSlot = await trainerCollection.aggregate([
                    {
                        $match: {
                            _id: new ObjectId(trainerId),
                            status: 'accepted'
                        }
                    },
                    {
                        $unwind: '$slots'
                    },
                    {
                        $match: {
                            'slots.id': slotId
                        }
                    },
                    {
                        $project: {
                            trainerStatus: '$status',
                            targetSlot: '$slots',
                            _id: 0
                        }
                    }
                ]).toArray();

                if (trainerAndSlot.length === 0) {
                    return res.status(404).json({ message: 'Trainer not found or is not active, or slot not found.' });
                }

                const { targetSlot } = trainerAndSlot[0];

                targetSlot.bookingCount = targetSlot.bookingCount || 0;

                if (targetSlot.bookingCount >= targetSlot.maxParticipants) {
                    return res.status(409).json({ message: 'This slot is fully booked. Please choose another one.' });
                }

                const bookingDocument = {
                    email,
                    trainerId: new ObjectId(trainerId),
                    slotId,
                    slotName,
                    slotTime: slotTime || null,
                    duration: slotDuration || null,
                    description: description || null,
                    slotDay: Array.isArray(slotDay) ? slotDay : (slotDay ? [String(slotDay)] : []),
                    packageId: packageId || null,
                    packageName: packageName || null,
                    packagePrice: packagePrice || null,
                    sessionType: sessionType || null,
                    price,
                    transactionId,
                    paymentStatus: paymentStatus || "Completed",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    hasReviewed: false,
                    reviewSubmittedAt: null,
                };

                const bookingResult = await bookingsCollection.insertOne(bookingDocument);
                const newBooking = { _id: bookingResult.insertedId, ...bookingDocument };

                const memberDetailsForSlot = memberInfo || {
                    name: req.decoded.displayName || email,
                    email: email,
                    package: packageName || "N/A",
                };

                let isSlotFullyBooked = false;
                if (targetSlot.maxParticipants === 1 || (targetSlot.bookingCount + 1 >= targetSlot.maxParticipants)) {
                    isSlotFullyBooked = true;
                }

                const updateFieldsForSlot = {
                    "$inc": { "slots.$.bookingCount": 1 },
                    "$push": { "slots.$.bookedMembers": memberDetailsForSlot },
                    "$set": { "updatedAt": new Date() }
                };

                if (isSlotFullyBooked) {
                    updateFieldsForSlot["$set"]["slots.$.isBooked"] = true;
                    updateFieldsForSlot["$set"]["slots.$.status"] = "booked";
                }

                const updateTrainerResult = await trainerCollection.updateOne(
                    { "_id": new ObjectId(trainerId), "slots.id": slotId },
                    updateFieldsForSlot
                );

                if (updateTrainerResult.modifiedCount === 0) {
                    await bookingsCollection.deleteOne({ _id: bookingResult.insertedId });
                    return res.status(500).json({ message: 'Failed to update trainer slot. Booking rolled back.' });
                }

                res.status(201).json({ message: 'Booking successful and slot booking count updated!', booking: newBooking });

            } catch (error) {
                console.error('Booking creation or slot update error:', error);
                if (error.code === 11000) {
                    res.status(409).json({ message: 'This booking already exists or a similar entry was made.' });
                } else {
                    res.status(500).json({ message: 'An internal server error occurred during booking. Please try again later.' });
                }
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

        // ================= Payment Routes (Stripe) =================
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
                    description: `Membership payment for ${req.decoded.email}`,
                    receipt_email: req.decoded.email,
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
        // Ensures that the client will close when you finish/error
        // Commented out to keep connection open for ongoing API requests
        // await client.close();
    }
}

run().catch(console.dir);

app.get("/", (req, res) => {
    res.send("FitFlow Backend Server Running");
});

app.listen(port, () => {
    console.log(`FitFlow Backend Server Running on port ${port}`);
});