const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const dotenv = require("dotenv");
dotenv.config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const app = express();
const port = process.env.PORT || 3000;

// Firebase Admin Initialization
const serviceAccount = require("./firebase-service-account.json");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

// MongoDB connection URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.hqacvhm.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

// Middleware
app.use(cors({
    origin: ["http://localhost:5173"], // adjust for your frontend URL
    credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// ---------- Middleware Utilities ----------

// Verify Firebase Token
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
        console.error("Firebase token error:", error);
        res.status(403).send({ message: "Forbidden: Invalid Firebase token" });
    }
};

// Verify JWT Token
const verifyJWT = (req, res, next) => {
    const token = req.cookies?.token;
    if (!token) return res.status(401).send({ message: "Unauthorized: No JWT token" });

    jwt.verify(token, process.env.JWT_ACCESS_SECRET, (err, decoded) => {
        if (err) return res.status(403).send({ message: "Forbidden: Invalid JWT token" });
        req.decoded = decoded;
        next();
    });
};

// Verify Admin Middleware
const verifyAdmin = async (req, res, next) => {
    const email = req.decoded?.email;
    const user = await req.usersCollection.findOne({ email });
    if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden: Not an admin" });
    }
    next();
};

// ---------- MongoDB + Routes ----------
async function run() {
    try {
        await client.connect();
        const db = client.db("fitflowDB");
        const usersCollection = db.collection("users");

        // Make usersCollection accessible in req
        app.use((req, res, next) => {
            req.usersCollection = usersCollection;
            next();
        });

        // GET all users
        app.get("/users", async (req, res) => {
            try {
                const users = await usersCollection.find().toArray();
                res.send(users);
            } catch (error) {
                res.status(500).send({ error: "Failed to fetch users" });
            }
        });

        // GET user by email
        app.get("/users/:email", async (req, res) => {
            try {
                const email = req.params.email;
                const user = await usersCollection.findOne({ email });
                if (!user) return res.status(404).send({ message: "User not found" });
                res.send(user);
            } catch (error) {
                res.status(500).send({ error: "Failed to fetch user" });
            }
        });

        // NEW: GET user role by email
        app.get("/users/role/:email", async (req, res) => {
            try {
                const email = req.params.email;
                const user = await usersCollection.findOne({ email });
                if (!user) return res.status(404).send({ message: "User not found" });
                res.send({ role: user.role || "member" });
            } catch (error) {
                res.status(500).send({ error: "Failed to fetch user role" });
            }
        });

        // POST add or update user with role support
        app.post("/users", async (req, res) => {
            const { email, displayName, photoURL, lastSignInTime, role = "member" } = req.body;
            if (!email) return res.status(400).send({ error: "Email is required" });

            try {
                const result = await usersCollection.updateOne(
                    { email },
                    { $set: { displayName, photoURL, lastSignInTime, role } },
                    { upsert: true }
                );
                res.send(result.upsertedCount > 0
                    ? { message: "New user added", result }
                    : { message: "User updated", result });
            } catch (error) {
                res.status(500).send({ error: "Failed to add/update user" });
            }
        });

        // PATCH update user lastSignInTime and/or role
        app.patch("/users", async (req, res) => {
            try {
                const { email, lastSignInTime, role } = req.body;
                if (!email) return res.status(400).send({ error: "Email is required" });

                const updateFields = {};
                if (lastSignInTime) updateFields.lastSignInTime = lastSignInTime;
                if (role) updateFields.role = role;

                const result = await usersCollection.updateOne(
                    { email },
                    { $set: updateFields }
                );
                res.send(result);
            } catch (error) {
                res.status(500).send({ error: "Failed to update user" });
            }
        });

        // DELETE user by email
        app.delete("/users/:email", async (req, res) => {
            const email = req.params.email;
            try {
                const result = await usersCollection.deleteOne({ email: { $regex: `^${email}$`, $options: "i" } });
                if (result.deletedCount === 0) return res.status(404).send({ message: "User not found" });
                res.send({ message: "User deleted", result });
            } catch (error) {
                res.status(500).send({ error: "Failed to delete user" });
            }
        });

        // JWT Login route: creates JWT including role, sets cookie
        app.post("/login", async (req, res) => {
            const { email } = req.body;
            if (!email) return res.status(400).send({ message: "Email required" });

            try {
                const user = await usersCollection.findOne({ email });
                if (!user) return res.status(401).send({ message: "Invalid user" });

                const payload = {
                    email: user.email,
                    id: user._id.toString(),
                    role: user.role || "member",
                };
                const token = jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: "1h" });

                res.cookie("token", token, {
                    httpOnly: true,
                    secure: process.env.NODE_ENV === "production",
                    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
                    maxAge: 3600000,
                });

                res.send({ message: "Login successful", user: { email: user.email, role: user.role } });
            } catch (error) {
                console.error("Login error:", error);
                res.status(500).send({ message: "Login failed" });
            }
        });

        // JWT Logout route: clears cookie
        app.post("/logout", (req, res) => {
            res.clearCookie("token", {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
            });
            res.send({ message: "Logged out successfully" });
        });

        // Ping MongoDB
        await db.command({ ping: 1 });
        console.log("Connected to MongoDB and server running");

    } catch (error) {
        console.error("MongoDB connection failed:", error);
    }
}

run().catch(console.dir);

// Root route
app.get("/", (req, res) => {
    res.send("FitFlow server is up and running.");
});

// Start server
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
