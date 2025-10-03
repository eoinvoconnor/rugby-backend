// server.js
const express = require("express");
const fs = require("fs").promises;
const path = require("path");
const cron = require("node-cron");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const { updateResultsFromSources } = require("./utils/resultsUpdater");

const app = express();
const PORT = process.env.PORT || 10000;
const DATA_DIR = path.join(__dirname, "data");
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

// ==================== Middleware ====================
app.use(express.json());

// ✅ Fixed CORS configuration
app.use(
  cors({
    origin: "https://rugby-frontend.onrender.com",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());

// ==================== Helpers ====================
async function readJSON(filename) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    const data = await fs.readFile(filePath, "utf8");
    return JSON.parse(data || "[]");
  } catch (err) {
    console.error(`❌ Error reading ${filename}:`, err.message);
    return [];
  }
}

async function writeJSON(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`❌ Error writing ${filename}:`, err.message);
  }
}

// JWT Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Missing token" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
}

// ==================== Routes ====================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Debug: list available JSON files
app.get("/api/debug/files", async (req, res) => {
  try {
    const files = await fs.readdir(DATA_DIR);
    const fileData = await Promise.all(
      files.map(async (file) => {
        const stats = await fs.stat(path.join(DATA_DIR, file));
        const content = await fs.readFile(path.join(DATA_DIR, file), "utf8");
        return {
          file,
          size: stats.size,
          modified: stats.mtime,
          preview: content.substring(0, 200),
        };
      })
    );
    res.json({ files: fileData });
  } catch (err) {
    console.error("❌ Error listing files:", err.message);
    res.status(500).json({ error: "Failed to list files" });
  }
});

// Competitions
app.get("/api/competitions", async (req, res) => {
  const competitions = await readJSON("competitions.json");
  res.json(competitions);
});

app.post("/api/competitions", authenticateToken, async (req, res) => {
  let competitions = await readJSON("competitions.json");
  const newCompetition = { id: Date.now(), ...req.body };
  competitions.push(newCompetition);
  await writeJSON("competitions.json", competitions);
  res.json(newCompetition);
});

// Matches
app.get("/api/matches", async (req, res) => {
  const matches = await readJSON("matches.json");
  res.json(matches);
});

app.post("/api/matches", authenticateToken, async (req, res) => {
  let matches = await readJSON("matches.json");
  const newMatch = { id: Date.now(), ...req.body };
  matches.push(newMatch);
  await writeJSON("matches.json", matches);
  res.json(newMatch);
});

// Predictions
app.get("/api/predictions", authenticateToken, async (req, res) => {
  const predictions = await readJSON("predictions.json");
  res.json(predictions.filter((p) => p.userId === req.user.id));
});

app.post("/api/predictions", authenticateToken, async (req, res) => {
  let predictions = await readJSON("predictions.json");
  const newPredictions = req.body.map((pred) => ({
    ...pred,
    userId: req.user.id,
  }));

  predictions = predictions.filter(
    (p) =>
      !(
        p.userId === req.user.id &&
        newPredictions.some((np) => np.matchId === p.matchId)
      )
  );

  predictions.push(...newPredictions);
  await writeJSON("predictions.json", predictions);
  res.json({ success: true });
});

// Users
app.get("/api/users", authenticateToken, async (req, res) => {
  const users = await readJSON("users.json");
  res.json(users);
});

app.post("/api/users", async (req, res) => {
  let users = await readJSON("users.json");
  const newUser = { id: Date.now(), ...req.body };
  users.push(newUser);
  await writeJSON("users.json", users);
  res.json(newUser);
});

// Login
app.post("/api/users/login", async (req, res) => {
  const { email } = req.body;
  const users = await readJSON("users.json");
  const user = users.find((u) => u.email === email);

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, isAdmin: user.isAdmin || false },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({ token, user });
});

// ==================== Results Updater ====================
cron.schedule("0 * * * *", async () => {
  console.log("⏰ Scheduled task: updating results...");
  try {
    await updateResultsFromSources();
    console.log("✅ Results update finished");
  } catch (err) {
    console.error("❌ Results update failed:", err.message);
  }
});

// ==================== Start ====================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});