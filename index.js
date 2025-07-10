// ✅ imports
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const dotenv = require("dotenv");
dotenv.config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

// ✅ Firebase Admin Init
const serviceAccount = require("./firebase-service-account.json");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

// ✅ Mongo URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.hqacvhm.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

// ✅ Middleware
app.use(
    cors({
        origin: ["http://localhost:5173"],
        credentials: true,
    })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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
        res.status(403).send({ message: "Forbidden: Invalid Firebase token" });
    }
};

const verifyJWT = (req, res, next) => {
    const token = req.cookies?.token;
    if (!token) return res.status(401).send({ message: "Unauthorized: No JWT token" });
    jwt.verify(token, process.env.JWT_ACCESS_SECRET, (err, decoded) => {
        if (err) return res.status(403).send({ message: "Forbidden: Invalid JWT token" });
        req.decoded = decoded;
        next();
    });
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
        await client.connect();
        const db = client.db("fitflowDB");
        const usersCollection = db.collection("users");
        const trainerCollection = db.collection("trainers");
        const bookingsCollection = db.collection("bookings");
        const paymentsCollection = db.collection("payments");
        const communityCollection = db.collection("community")

        // Attach to req for middleware
        app.use((req, res, next) => {
            req.usersCollection = usersCollection;
            next();
        });

        // ================= Trainers routes =================
        app.get("/trainers", async (req, res) => {
            const trainers = await trainerCollection.find({}).toArray();
            res.send(trainers);
        });

        app.post("/trainers", async (req, res) => {
            const trainer = { ...req.body, status: "pending" };
            const result = await trainerCollection.insertOne(trainer);
            res.status(201).send(result);
        });

        app.get("/trainers/:id", async (req, res) => {
            const trainer = await trainerCollection.findOne({ _id: new ObjectId(req.params.id) });
            if (!trainer) return res.status(404).send({ message: "Trainer not found" });
            res.send(trainer);
        });

        // ========== Trainer Ratings ==========
        app.get("/trainers/rating/:id", verifyJWT, async (req, res) => {
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

                // Find logged-in user's rating if exists
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

        app.post("/trainers/rating/:id", verifyJWT, async (req, res) => {
            const trainerId = req.params.id;
            const { rating } = req.body;
            const userEmail = req.decoded.email;

            try {
                const trainer = await trainerCollection.findOne({ _id: new ObjectId(trainerId) });

                if (!trainer) {
                    return res.status(404).send({ success: false, message: "Trainer not found" });
                }

                // Check if user already rated
                const alreadyRated = trainer.ratings?.find((r) => r.email === userEmail);
                if (alreadyRated) {
                    return res.send({ success: false, message: "You already rated this trainer." });
                }

                // Add new rating
                const newRating = {
                    email: userEmail,
                    name: req.decoded.name || "Anonymous",
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
                const post = await communityCollection.findOne({ _id: new ObjectId(id) });

                if (!post) {
                    return res.status(404).send({ message: 'Post not found.' });
                }

                res.send(post);
            } catch (error) {
                console.error('Error fetching post by ID:', error);
                res.status(500).send({ message: 'Failed to fetch post.' });
            }
        });

        app.post("/community", verifyJWT, async (req, res) => {
            try {
                const { title, content, category, tags, author, authorPhoto, authorRole, email, createdAt } = req.body;

                const post = {
                    title,
                    content,
                    category,
                    tags, // should be an array of strings
                    author,
                    authorPhoto,
                    authorRole,
                    email,
                    createdAt,
                    likes: 0,
                    dislikes: 0,
                    comments: [], // initialize empty
                };

                const result = await communityCollection.insertOne(post);
                res.send({ insertedId: result.insertedId });
            } catch (error) {
                console.error("Error adding post:", error);
                res.status(500).send({ message: "Failed to add post." });
            }
        });

        app.post("/community/:postId/comments", verifyJWT, async (req, res) => {
            try {
                const { postId } = req.params;
                const { commentText } = req.body;
                const userEmail = req.decoded.email;

                // Get user info from DB to attach with comment
                const user = await req.usersCollection.findOne({ email: userEmail });

                if (!user) return res.status(404).send({ message: "User not found" });

                const newComment = {
                    _id: new ObjectId(), // unique id for comment
                    text: commentText,
                    author: user.displayName || "Anonymous",
                    authorPhoto: user.photoURL || "",
                    authorRole: user.role || "member",
                    email: user.email,
                    createdAt: new Date().toISOString(),
                };

                const result = await communityCollection.updateOne(
                    { _id: new ObjectId(postId) },
                    { $push: { comments: newComment } }
                );

                if (result.modifiedCount === 0) {
                    return res.status(404).send({ message: "Post not found or comment not added" });
                }

                res.status(201).send({ message: "Comment added", comment: newComment });
            } catch (error) {
                console.error("Error adding comment:", error);
                res.status(500).send({ message: "Failed to add comment" });
            }
        });

        // ✅ Like/Dislike a post
        app.post("/community/vote", verifyJWT, async (req, res) => {
            try {
                const { postId, voteType } = req.body;
                const userEmail = req.decoded.email;

                if (!postId || (voteType !== "like" && voteType !== "dislike" && voteType !== null)) {
                    return res.status(400).json({ message: "Invalid vote type or missing postId" });
                }

                const post = await communityCollection.findOne({ _id: new ObjectId(postId) });
                if (!post) return res.status(404).json({ message: "Post not found" });

                const existingVote = post.votes?.find((v) => v.email === userEmail);

                let updateQuery = {};
                let options = {};

                if (existingVote) {
                    if (voteType === null || existingVote.type === voteType) {
                        // Toggle OFF or remove same vote
                        updateQuery = {
                            $inc: { [existingVote.type === "like" ? "likes" : "dislikes"]: -1 },
                            $pull: { votes: { email: userEmail } },
                        };
                    } else {
                        // Switch vote type
                        updateQuery = {
                            $inc: {
                                [voteType === "like" ? "likes" : "dislikes"]: 1,
                                [voteType === "like" ? "dislikes" : "likes"]: -1,
                            },
                            $set: { "votes.$[elem].type": voteType },
                        };
                        options = { arrayFilters: [{ "elem.email": userEmail }] };
                    }
                } else if (voteType !== null) {
                    // New vote
                    updateQuery = {
                        $inc: { [voteType === "like" ? "likes" : "dislikes"]: 1 },
                        $push: { votes: { email: userEmail, type: voteType } },
                    };
                } else {
                    return res.status(400).json({ message: "Nothing to toggle off" });
                }

                const result = await communityCollection.updateOne(
                    { _id: new ObjectId(postId) },
                    updateQuery,
                    options
                );

                res.send({ message: "Vote processed", result });
            } catch (err) {
                console.error("Vote error:", err);
                res.status(500).send({ message: "Vote failed" });
            }
        });

        // ================= Users routes =================
        app.get("/users", async (req, res) => {
            const users = await usersCollection.find().toArray();
            res.send(users);
        });

        app.get("/users/:email", async (req, res) => {
            const user = await usersCollection.findOne({ email: req.params.email });
            if (!user) return res.status(404).send({ message: "User not found" });
            res.send(user);
        });

        app.get("/users/role/:email", async (req, res) => {
            const user = await usersCollection.findOne({ email: req.params.email });
            if (!user) return res.status(404).send({ message: "User not found" });
            res.send({ role: user.role || "member" });
        });

        app.post("/users", async (req, res) => {
            const { email, displayName, photoURL, lastSignInTime, role = "member" } = req.body;
            const result = await usersCollection.updateOne(
                { email },
                { $set: { displayName, photoURL, lastSignInTime, role } },
                { upsert: true }
            );
            res.send(result);
        });

        app.patch("/users", async (req, res) => {
            const { email, lastSignInTime, role } = req.body;
            const updateFields = {};
            if (lastSignInTime) updateFields.lastSignInTime = lastSignInTime;
            if (role) updateFields.role = role;
            const result = await usersCollection.updateOne({ email }, { $set: updateFields });
            res.send(result);
        });

        app.delete("/users/:email", async (req, res) => {
            const result = await usersCollection.deleteOne({ email: { $regex: `^${req.params.email}$`, $options: "i" } });
            if (result.deletedCount === 0) return res.status(404).send({ message: "User not found" });
            res.send({ message: "User deleted", result });
        });

        // ================= JWT Auth routes =================
        app.post("/register", async (req, res) => {
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
                    },
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
                {
                    expiresIn: "1h",
                }
            );


            res.cookie("token", token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
                maxAge: 3600000,
            });

            res.json({ message: "User registered and logged in", user: { email: user.email, role: user.role } });
        });

        app.post("/login", async (req, res) => {
            const { email } = req.body;
            if (!email) {
                return res.status(400).json({ error: "Email required" });
            }

            const user = await usersCollection.findOne({ email });

            if (!user) {
                return res.status(401).json({ error: "User not found" });
            }

            // ✅ Include name in the JWT payload
            const token = jwt.sign(
                {
                    email: user.email,
                    role: user.role,
                    name: user.displayName || "Anonymous", // Include the name
                },
                process.env.JWT_ACCESS_SECRET,
                {
                    expiresIn: "1h",
                }
            );

            // ✅ Set cookie
            res.cookie("token", token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
                maxAge: 3600000,
            });

            // ✅ Return response
            res.json({
                message: "Login successful",
                user: {
                    email: user.email,
                    role: user.role,
                    displayName: user.displayName,
                },
            });
        });

        app.post("/logout", (req, res) => {
            res.clearCookie("token", {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
            });
            res.json({ message: "Logged out" });
        });

        // ================= Bookings =================
        // Get all bookings with user data (admin only)
        app.get("/bookings", verifyJWT, verifyAdmin, async (req, res) => {
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
                        $project: {
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
                            userName: "$userDetails.displayName",
                            userEmail: "$userDetails.email",
                            userPhotoURL: "$userDetails.photoURL",
                            userRole: "$userDetails.role",
                            userLastSignInTime: "$userDetails.lastSignInTime",
                        },
                    },
                ]).toArray();

                res.send(bookings);
            } catch (error) {
                console.error("Failed to fetch bookings:", error);
                res.status(500).send({ error: "Failed to fetch bookings" });
            }
        });

        // Get bookings by user email (self or admin)
        app.get("/bookings/user/:email", verifyJWT, async (req, res) => {
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
                        $project: {
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
                            userName: "$userDetails.displayName",
                            userEmail: "$userDetails.email",
                            userPhotoURL: "$userDetails.photoURL",
                            userRole: "$userDetails.role",
                            userLastSignInTime: "$userDetails.lastSignInTime",
                        },
                    },
                ]).toArray();

                res.send(bookings);
            } catch (error) {
                console.error("Failed to fetch user bookings:", error);
                res.status(500).send({ error: "Failed to fetch user bookings" });
            }
        });

        // Create a booking (authenticated user)
        app.post("/bookings", verifyJWT, async (req, res) => {
            try {
                let booking = req.body;
                booking.email = req.decoded.email;
                booking.createdAt = new Date().toISOString();
                booking.paymentStatus = booking.paymentStatus || "pending";

                // Get user info
                const user = await usersCollection.findOne({ email: booking.email });

                // Get trainer info
                const trainer = await trainerCollection.findOne({ _id: new ObjectId(booking.trainerId) });
                if (!trainer) return res.status(400).send({ error: "Trainer not found" });

                // Find slot info inside trainer
                const slot = trainer.slots.find((s) => s.id === booking.slotId);
                if (!slot) return res.status(400).send({ error: "Slot not found" });

                // Package info (static)
                const packages = [
                    { id: "basic", name: "Basic Membership", price: 10, sessionType: "Group Training" },
                    { id: "standard", name: "Standard Membership", price: 50, sessionType: "Group & Personal Training" },
                    { id: "premium", name: "Premium Membership", price: 100, sessionType: "Personal Training" },
                ];

                const pkg = packages.find((p) => p.id === booking.packageId);
                if (!pkg) return res.status(400).send({ error: "Package not found" });

                // Enrich booking
                booking = {
                    ...booking,
                    clientName: user?.displayName || "Unknown",
                    clientInitial: user?.displayName ? user.displayName.charAt(0) : "U",
                    clientPhotoURL: user?.photoURL || "",
                    slotName: slot.name,
                    slotTime: slot.time,
                    slotDay: slot.day,
                    packageName: pkg.name,
                    packagePrice: pkg.price,
                    sessionType: pkg.sessionType,
                };

                // Insert booking
                const result = await bookingsCollection.insertOne(booking);

                // Mark slot as booked
                await trainerCollection.updateOne(
                    { _id: new ObjectId(booking.trainerId), "slots.id": booking.slotId },
                    { $set: { "slots.$.isBooked": true } }
                );

                res.status(201).send({ message: "Booking created", bookingId: result.insertedId });
            } catch (error) {
                console.error("Failed to create booking:", error);
                res.status(500).send({ error: "Failed to create booking" });
            }
        });

        // ================= Stripe Payment Intent =================
        app.post("/create-payment-intent", async (req, res) => {
            const { price } = req.body;
            if (!price) return res.status(400).send({ error: "Price is required" });

            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: price * 100,
                    currency: "usd",
                    payment_method_types: ["card"],
                });
                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (err) {
                console.error("Stripe error:", err);
                res.status(500).send({ error: "Failed to create payment intent" });
            }
        });

        // ================= Payment Routes (with JWT auth) =================

        // Get all payments (admin only)
        app.get("/payments", verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const payments = await paymentsCollection.find().toArray();
                res.send(payments);
            } catch (error) {
                console.error("Failed to fetch payments:", error);
                res.status(500).send({ error: "Failed to fetch payments" });
            }
        });

        // Get payment by payment ID (admin or owner)
        app.get("/payments/:id", verifyJWT, async (req, res) => {
            const paymentId = req.params.id;

            try {
                const payment = await paymentsCollection.findOne({ _id: new ObjectId(paymentId) });
                if (!payment) return res.status(404).send({ message: "Payment not found" });

                if (req.decoded.role !== "admin" && req.decoded.email !== payment.email) {
                    return res.status(403).send({ message: "Forbidden: Access denied" });
                }

                res.send(payment);
            } catch (error) {
                console.error("Failed to fetch payment:", error);
                res.status(500).send({ error: "Failed to fetch payment" });
            }
        });

        // Get payments by user email (self or admin)
        app.get("/payments/user/:email", verifyJWT, async (req, res) => {
            const email = req.params.email;

            if (req.decoded.role !== "admin" && req.decoded.email !== email) {
                return res.status(403).send({ message: "Forbidden: Cannot access other user's payments" });
            }

            try {
                const userPayments = await paymentsCollection.find({ email }).toArray();
                res.send(userPayments);
            } catch (error) {
                console.error("Failed to fetch user payments:", error);
                res.status(500).send({ error: "Failed to fetch user payments" });
            }
        });

        // Add payment record (authenticated user)
        app.post("/payments", verifyJWT, async (req, res) => {
            const paymentData = req.body;

            // Force payment email to logged-in user's email
            paymentData.email = req.decoded.email;

            try {
                const result = await paymentsCollection.insertOne(paymentData);
                res.status(201).send(result);
            } catch (error) {
                console.error("Failed to save payment:", error);
                res.status(500).send({ error: "Failed to save payment" });
            }
        });

        // Update payment by ID (admin or owner)
        app.patch("/payments/:id", verifyJWT, async (req, res) => {
            const paymentId = req.params.id;
            const updateFields = req.body;

            try {
                const payment = await paymentsCollection.findOne({ _id: new ObjectId(paymentId) });
                if (!payment) return res.status(404).send({ message: "Payment not found" });

                if (req.decoded.role !== "admin" && req.decoded.email !== payment.email) {
                    return res.status(403).send({ message: "Forbidden: Access denied" });
                }

                const result = await paymentsCollection.updateOne(
                    { _id: new ObjectId(paymentId) },
                    { $set: updateFields }
                );

                res.send(result);
            } catch (error) {
                console.error("Failed to update payment:", error);
                res.status(500).send({ error: "Failed to update payment" });
            }
        });

        // Delete payment by ID (admin or owner)
        app.delete("/payments/:id", verifyJWT, async (req, res) => {
            const paymentId = req.params.id;

            try {
                const payment = await paymentsCollection.findOne({ _id: new ObjectId(paymentId) });
                if (!payment) return res.status(404).send({ message: "Payment not found" });

                if (req.decoded.role !== "admin" && req.decoded.email !== payment.email) {
                    return res.status(403).send({ message: "Forbidden: Access denied" });
                }

                const result = await paymentsCollection.deleteOne({ _id: new ObjectId(paymentId) });
                res.send({ message: "Payment deleted", result });
            } catch (error) {
                console.error("Failed to delete payment:", error);
                res.status(500).send({ error: "Failed to delete payment" });
            }
        });

        // Confirm DB connection
        await db.command({ ping: 1 });
        console.log("✅ Connected to MongoDB and server running.");
    } catch (error) {
        console.error("❌ MongoDB connection failed:", error);
    }
}

run().catch(console.dir);

// ✅ Root route
app.get("/", (req, res) => {
    res.send("FitFlow server is up and running.");
});

// ✅ Start server
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
