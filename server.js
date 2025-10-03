// server.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");

const { updateResultsFromSources } = require("./updateResultsFromBBC"); // keep your updater

const app = express();
const PORT = process.env.PORT || 10000;
const DATA_DIR = path.join(__dirname, "data");

const JWT_SECRET = process.env.JWT_SECRET || "supersecret"; // change in production

// Middleware
app.use(cors());
app.use(bodyParser.json());

// ✅ Helper: Read/write JSON
function readJSON(filename) {
  const file = path.join(DATA_DIR, filename);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}
function writeJSON(filename, data) {
  const file = path.join(DATA_DIR, filename);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ✅ Middleware: authenticate JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token missing" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
}

// ✅ Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ✅ Debug files (admin/dev)
app.get("/api/debug/files", (req, res) => {
  const files = fs.readdirSync(DATA_DIR).map((file) => {
    const stats = fs.statSync(path.join(DATA_DIR, file));
    return {
      file,
      size: stats.size,
      modified: stats.mtime,
      preview: fs.readFileSync(path.join(DATA_DIR, file), "utf-8").substring(0, 200),
    };
  });
  res.json({ files });
});

// ==================== USERS ====================

// Register
app.post("/api/users/register", (req, res) => {
  const { email, firstname, surname } = req.body;
  if (!email || !firstname || !surname) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  let users = readJSON("users.json");
  if (users.find((u) => u.email === email)) {
    return res.status(400).json({ error: "User already exists" });
  }

  const newUser = {
    id: users.length ? Math.max(...users.map((u) => u.id)) + 1 : 1,
    email,
    firstname,
    surname,
    isAdmin: false,
  };

  users.push(newUser);
  writeJSON("users.json", users);

  const token = jwt.sign({ id: newUser.id, email, isAdmin: false }, JWT_SECRET, {
    expiresIn: "7d",
  });

  res.json({ message: "User registered", token, user: newUser });
});

// Login
app.post("/api/users/login", (req, res) => {
  const { email } = req.body;
  let users = readJSON("users.json");
  const user = users.find((u) => u.email === email);

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, isAdmin: user.isAdmin },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ message: "Login successful", token, user });
});

// ✅ Get all users (admin)
app.get("/api/users", authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: "Admin only" });
  res.json(readJSON("users.json"));
});

// ✅ Update user (admin)
app.put("/api/users/:id", authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: "Admin only" });

  let users = readJSON("users.json");
  const id = parseInt(req.params.id, 10);
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return res.status(404).json({ error: "User not found" });

  users[idx] = { ...users[idx], ...req.body };
  writeJSON("users.json", users);
  res.json(users[idx]);
});

// ✅ Delete user (admin)
app.delete("/api/users/:id", authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: "Admin only" });

  let users = readJSON("users.json");
  const id = parseInt(req.params.id, 10);
  users = users.filter((u) => u.id !== id);
  writeJSON("users.json", users);

  res.json({ message: "User deleted" });
});

// ==================== COMPETITIONS ====================
app.get("/api/competitions", (req, res) => {
  res.json(readJSON("competitions.json"));
});

app.post("/api/competitions", authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: "Admin only" });

  let competitions = readJSON("competitions.json");
  const newComp = { id: Date.now(), ...req.body };
  competitions.push(newComp);
  writeJSON("competitions.json", competitions);
  res.json(newComp);
});

app.put("/api/competitions/:id", authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: "Admin only" });

  let competitions = readJSON("competitions.json");
  const id = parseInt(req.params.id, 10);
  const idx = competitions.findIndex((c) => c.id === id);
  if (idx === -1) return res.status(404).json({ error: "Competition not found" });

  competitions[idx] = { ...competitions[idx], ...req.body };
  writeJSON("competitions.json", competitions);
  res.json(competitions[idx]);
});

app.delete("/api/competitions/:id", authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: "Admin only" });

  let competitions = readJSON("competitions.json");
  const id = parseInt(req.params.id, 10);
  competitions = competitions.filter((c) => c.id !== id);
  writeJSON("competitions.json", competitions);

  res.json({ message: "Competition deleted" });
});

// ==================== MATCHES ====================
app.get("/api/matches", (req, res) => {
  res.json(readJSON("matches.json"));
});

app.put("/api/matches/:id", authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: "Admin only" });

  let matches = readJSON("matches.json");
  const id = parseInt(req.params.id, 10);
  const idx = matches.findIndex((m) => m.id === id);
  if (idx === -1) return res.status(404).json({ error: "Match not found" });

  matches[idx] = { ...matches[idx], ...req.body };
  writeJSON("matches.json", matches);
  res.json(matches[idx]);
});

// ==================== PREDICTIONS ====================
app.get("/api/predictions", authenticateToken, (req, res) => {
  let predictions = readJSON("predictions.json");
  predictions = predictions.filter((p) => p.userId === req.user.id);
  res.json(predictions);
});

app.post("/api/predictions", authenticateToken, (req, res) => {
  let predictions = readJSON("predictions.json");
  const newPred = { id: Date.now(), userId: req.user.id, ...req.body };
  predictions.push(newPred);
  writeJSON("predictions.json", predictions);
  res.json(newPred);
});

// ==================== LEADERBOARD ====================
app.get("/api/leaderboard", (req, res) => {
  const predictions = readJSON("predictions.json");
  const users = readJSON("users.json");
  const matches = readJSON("matches.json");

  let leaderboard = users.map((u) => {
    const userPreds = predictions.filter((p) => p.userId === u.id);
    let points = 0;
    let correct = 0;

    userPreds.forEach((p) => {
      const match = matches.find((m) => m.id === p.matchId);
      if (match && match.result) {
        const margin = Math.abs(match.result.margin);
        const predMargin = Math.abs(p.margin);
        if (match.result.winner === p.winner) {
          points += 3;
          correct++;
          if (margin === predMargin) points += 2; // exact margin bonus
        }
      }
    });

    return {
      userId: u.id,
      name: `${u.firstname} ${u.surname}`,
      points,
      accuracy: userPreds.length ? ((correct / userPreds.length) * 100).toFixed(1) : 0,
    };
  });

  leaderboard.sort((a, b) => b.points - a.points);
  res.json(leaderboard);
});

// ==================== CRON JOB ====================
cron.schedule("0 * * * *", async () => {
  console.log("⏰ Running hourly match updater...");
  await updateResultsFromSources();
});

// ==================== STATIC FRONTEND ====================
app.use(express.static(path.join(__dirname, "frontend", "build")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "build", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});