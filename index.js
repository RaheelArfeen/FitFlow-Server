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

            const token = jwt.sign({ email: user.email, role: user.role }, process.env.JWT_ACCESS_SECRET, {
                expiresIn: "1h",
            });

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
            if (!email) return res.status(400).json({ error: "Email required" });

            const user = await usersCollection.findOne({ email });
            if (!user) return res.status(401).json({ error: "User not found" });

            const token = jwt.sign({ email: user.email, role: user.role }, process.env.JWT_ACCESS_SECRET, {
                expiresIn: "1h",
            });

            res.cookie("token", token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
                maxAge: 3600000,
            });

            res.json({ message: "Login successful", user: { email: user.email, role: user.role } });
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
        app.post("/bookings", async (req, res) => {
            const booking = req.body;

            // Save booking
            const result = await bookingsCollection.insertOne(booking);

            // Mark the slot as booked
            await trainerCollection.updateOne(
                { _id: new ObjectId(booking.trainerId), "slots.id": booking.slotId },
                { $set: { "slots.$.isBooked": true } }
            );

            res.send(result);
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
