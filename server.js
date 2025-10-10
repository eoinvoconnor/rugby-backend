// ==================== IMPORTS ====================
require("dotenv").config();
const express = require("express");
const fs = require("fs").promises;
const path = require("path");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");
const { updateResultsFromSources } = require("./utils/resultsUpdater");

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "default_secret_key";
const DATA_DIR = path.join(__dirname, "data");

// ==================== MIDDLEWARE ====================
app.use(express.json());

// ✅ Robust CORS configuration
const allowedOrigins = [
  "https://rugby-frontend.onrender.com",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn("❌ CORS blocked origin:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ✅ Handle preflight requests cleanly
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");
  return res.sendStatus(204);
});

// ==================== HELPER FUNCTIONS ====================
async function readJSON(filename) {
  const filePath = path.join(DATA_DIR, filename);
  const data = await fs.readFile(filePath, "utf8");
  return JSON.parse(data || "[]");
}

async function writeJSON(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// ==================== AUTH MIDDLEWARE ====================
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    console.error("❌ No Authorization header");
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    console.error("❌ Token missing after Bearer");
    return res.status(401).json({ error: "Token missing" });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.error("❌ JWT verification failed:", err.message);
      return res.status(403).json({ error: "Invalid or expired token" });
    }
    req.user = user;
    next();
  });
}

// ==================== HEALTH CHECK ====================
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ==================== USERS ====================
app.get("/api/users", authenticateToken, async (req, res) => {
  const users = await readJSON("users.json");
  res.json(users);
});
// Add new user (Admin only)
app.post("/api/users", authenticateToken, async (req, res) => {
  try {
    const { firstname, surname, email, isAdmin } = req.body;
    if (!firstname || !surname || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const users = await readJSON("users.json");

    // Check for duplicates by email
    if (users.some((u) => u.email === email)) {
      return res.status(400).json({ error: "User with that email already exists" });
    }

    const newUser = {
      id: users.length ? Math.max(...users.map((u) => u.id)) + 1 : 1,
      firstname,
      surname,
      email,
      isAdmin: !!isAdmin,
      createdAt: new Date().toISOString(),
    };

    users.push(newUser);
    await writeJSON("users.json", users);

    res.status(201).json(newUser);
  } catch (err) {
    console.error("❌ Error adding user:", err);
    res.status(500).json({ error: "Failed to add user" });
  }
});

app.post("/api/users/login", async (req, res) => {
  const { email, firstname, surname } = req.body;
  const users = await readJSON("users.json");
  let user = users.find((u) => u.email === email);

  if (!user) {
    user = {
      id: users.length + 1,
      email,
      firstname,
      surname,
      isAdmin: false,
    };
    users.push(user);
    await writeJSON("users.json", users);
  }

  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token, user });
});
app.delete("/api/users/:id", authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) return res.status(400).json({ error: "Invalid user ID" });

    const users = await readJSON("users.json");
    const updatedUsers = users.filter((u) => u.id !== userId);
    if (updatedUsers.length === users.length) {
      return res.status(404).json({ error: "User not found" });
    }

    await writeJSON("users.json", updatedUsers);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error deleting user:", err);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ==================== COMPETITIONS ====================
app.get("/api/competitions", async (req, res) => {
  const competitions = await readJSON("competitions.json");
  res.json(competitions);
});

app.put("/api/competitions/:id", authenticateToken, async (req, res) => {
  const competitions = await readJSON("competitions.json");
  const index = competitions.findIndex((c) => c.id === parseInt(req.params.id));
  if (index !== -1) {
    competitions[index] = { ...competitions[index], ...req.body };
    await writeJSON("competitions.json", competitions);
    res.json(competitions[index]);
  } else {
    res.status(404).json({ error: "Competition not found" });
  }
});

// ==================== MATCHES ====================
app.get("/api/matches", async (req, res) => {
  const matches = await readJSON("matches.json");
  res.json(matches);
});

// ==================== PREDICTIONS ====================
app.get("/api/predictions", authenticateToken, async (req, res) => {
  const predictions = await readJSON("predictions.json");
  res.json(predictions.filter((p) => p.userId === req.user.id));
});

app.post("/api/predictions", authenticateToken, async (req, res) => {
  let predictions = await readJSON("predictions.json");
  const newPrediction = { ...req.body, userId: req.user.id };

  // Replace any existing prediction for same match + user
  predictions = predictions.filter(
    (p) => !(p.userId === req.user.id && p.matchId === newPrediction.matchId)
  );

  predictions.push(newPrediction);
  await writeJSON("predictions.json", predictions);
  res.json({ success: true });
});

// ==================== RESULTS UPDATE CRON ====================
cron.schedule("0 */6 * * *", async () => {
  console.log("🕒 Scheduled task: updating results...");
  await updateResultsFromSources();
});

// ==================== DEBUG ROUTES ====================
app.get("/api/debug/files", async (req, res) => {
  try {
    const files = await fs.readdir(DATA_DIR);
    const details = await Promise.all(
      files.map(async (file) => {
        const stat = await fs.stat(path.join(DATA_DIR, file));
        const preview = await fs
          .readFile(path.join(DATA_DIR, file), "utf8")
          .then((content) => content.slice(0, 200));
        return {
          file,
          size: stat.size,
          modified: stat.mtime,
          preview,
        };
      })
    );
    res.json({ files: details });
  } catch (err) {
    res.status(500).json({ error: "Unable to list files", details: err });
  }
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});