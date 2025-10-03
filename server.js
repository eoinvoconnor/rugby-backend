// ==================== Imports ====================
const express = require("express");
const fs = require("fs").promises;
const path = require("path");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cron = require("node-cron");
require("dotenv").config();

const { updateResultsFromSources } = require("./utils/updateResultsFromSources");

const app = express();
const PORT = process.env.PORT || 10000;
const DATA_DIR = path.join(__dirname, "data");
const JWT_SECRET = process.env.JWT_SECRET || "secret";

// ==================== Middleware ====================
app.use(express.json());

// ✅ CORS configuration — allow frontend + localhost
const allowedOrigins = [
  "https://rugby-frontend.onrender.com",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ✅ Explicit preflight handler
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin);
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");
  res.sendStatus(200);
});
// ==================== Helpers ====================
async function readJSON(file) {
  const filePath = path.join(DATA_DIR, file);
  try {
    const data = await fs.readFile(filePath, "utf8");
    return JSON.parse(data);
  } catch (err) {
    console.error(`Error reading ${file}:`, err);
    return [];
  }
}

async function writeJSON(file, data) {
  const filePath = path.join(DATA_DIR, file);
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`Error writing ${file}:`, err);
  }
}

// ==================== Auth Middleware ====================
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// ==================== Routes ====================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Debug: list data files
app.get("/api/debug/files", async (req, res) => {
  try {
    const files = await fs.readdir(DATA_DIR);
    const details = await Promise.all(
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
    res.json({ files: details });
  } catch (err) {
    res.status(500).json({ error: "Failed to list files" });
  }
});

// ==================== USERS ====================
app.post("/api/users/register", async (req, res) => {
  const { email, firstname, surname, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Missing fields" });

  let users = await readJSON("users.json");
  if (users.find((u) => u.email === email)) {
    return res.status(400).json({ error: "User already exists" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: users.length ? users[users.length - 1].id + 1 : 1,
    email,
    firstname,
    surname,
    password: hashedPassword,
    isAdmin: false,
  };

  users.push(newUser);
  await writeJSON("users.json", users);

  const token = jwt.sign(
    { id: newUser.id, email: newUser.email, isAdmin: newUser.isAdmin },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({
    token,
    user: { id: newUser.id, email, firstname, surname, isAdmin: false },
  });
});

app.post("/api/users/login", async (req, res) => {
  const { email, password } = req.body;
  let users = await readJSON("users.json");
  const user = users.find((u) => u.email === email);
  if (!user) return res.status(400).json({ error: "Invalid credentials" });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ error: "Invalid credentials" });

  const token = jwt.sign(
    { id: user.id, email: user.email, isAdmin: user.isAdmin },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      firstname: user.firstname,
      surname: user.surname,
      isAdmin: user.isAdmin,
    },
  });
});

// ==================== COMPETITIONS ====================
app.get("/api/competitions", async (req, res) => {
  const competitions = await readJSON("competitions.json");
  res.json(competitions);
});

app.post("/api/competitions", authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.sendStatus(403);
  let competitions = await readJSON("competitions.json");
  competitions.push(req.body);
  await writeJSON("competitions.json", competitions);
  res.json({ success: true });
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

// Save predictions (single or batch)
app.post("/api/predictions", authenticateToken, async (req, res) => {
  let predictions = await readJSON("predictions.json");

  // ✅ Handle both single object and array
  const incoming = Array.isArray(req.body) ? req.body : [req.body];

  const newPredictions = incoming.map((pred) => ({
    ...pred,
    userId: req.user.id,
  }));

  // Remove old predictions for same matches from same user
  predictions = predictions.filter(
    (p) =>
      !(p.userId === req.user.id &&
        newPredictions.some((np) => np.matchId === p.matchId))
  );

  // Add new ones
  predictions.push(...newPredictions);

  await writeJSON("predictions.json", predictions);
  res.json({ success: true });
});

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});