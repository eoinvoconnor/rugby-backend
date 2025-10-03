// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { updateResultsFromSources } = require("./utils/updateResultsFromSources");

const app = express();
const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || "secret";

// Middleware
app.use(bodyParser.json());
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://rugby-frontend.onrender.com",
    ],
    credentials: true,
  })
);

// ✅ Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// === Utility to read/write JSON files with logging ===
function readJSON(filename) {
  const filepath = path.join(__dirname, "data", filename);
  console.log(`📖 Reading JSON file: ${filepath}`);

  if (!fs.existsSync(filepath)) {
    console.warn(`⚠️ File not found: ${filepath}`);
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(filepath, "utf8"));
    console.log(`✅ Loaded ${filename} (${data.length || 0} records)`);
    return data;
  } catch (err) {
    console.error(`❌ Error parsing ${filename}:`, err);
    return [];
  }
}

function writeJSON(filename, data) {
  const filepath = path.join(__dirname, "data", filename);
  console.log(`✍️ Writing JSON file: ${filepath} (${data.length || 0} records)`);

  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    console.log(`✅ Saved ${filename}`);
  } catch (err) {
    console.error(`❌ Error writing ${filename}:`, err);
  }
}

// === Debug endpoint ===
app.get("/api/debug/files", (req, res) => {
  const dataDir = path.join(__dirname, "data");

  try {
    if (!fs.existsSync(dataDir)) {
      return res.status(404).json({ error: "Data directory not found" });
    }

    const files = fs.readdirSync(dataDir);
    const details = files.map((file) => {
      const filepath = path.join(dataDir, file);
      const stat = fs.statSync(filepath);

      let preview = "";
      try {
        const content = fs.readFileSync(filepath, "utf8");
        preview = content.substring(0, 200); // first 200 chars
      } catch {
        preview = "(unreadable)";
      }

      return {
        file,
        size: stat.size,
        modified: stat.mtime,
        preview,
      };
    });

    res.json({ files: details });
  } catch (err) {
    console.error("❌ Error in /api/debug/files:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Auth middleware ===
function authenticateToken(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// === API Routes ===

// Competitions
app.get("/api/competitions", (req, res) => {
  res.json(readJSON("competitions.json"));
});

// Matches
app.get("/api/matches", (req, res) => {
  res.json(readJSON("matches.json"));
});

// Users (login/register)
app.post("/api/users/login", (req, res) => {
  const { email, firstname, surname } = req.body;
  let users = readJSON("users.json");
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
    writeJSON("users.json", users);
  }

  const token = jwt.sign(user, JWT_SECRET, { expiresIn: "7d" });
  res.json({ ...user, token });
});

// =============================
// ✅ USERS API
// =============================
const usersFile = path.join(DATA_DIR, "users.json");

// Load users helper
const loadUsers = () => {
  try {
    return JSON.parse(fs.readFileSync(usersFile, "utf8"));
  } catch {
    return [];
  }
};

// Save users helper
const saveUsers = (users) => {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
};

// GET all users
app.get("/api/users", (req, res) => {
  res.json(loadUsers());
});

// POST new user
app.post("/api/users", (req, res) => {
  const users = loadUsers();
  const newUser = {
    id: Date.now(),
    firstname: req.body.firstname || "",
    surname: req.body.surname || "",
    email: req.body.email || "",
    isAdmin: req.body.isAdmin || false,
  };
  users.push(newUser);
  saveUsers(users);
  res.status(201).json(newUser);
});

// PUT update user
app.put("/api/users/:id", (req, res) => {
  const users = loadUsers();
  const id = parseInt(req.params.id);
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return res.status(404).json({ error: "User not found" });

  users[idx] = { ...users[idx], ...req.body, id };
  saveUsers(users);
  res.json(users[idx]);
});

// DELETE user
app.delete("/api/users/:id", (req, res) => {
  let users = loadUsers();
  const id = parseInt(req.params.id);
  const before = users.length;
  users = users.filter((u) => u.id !== id);
  if (users.length === before)
    return res.status(404).json({ error: "User not found" });

  saveUsers(users);
  res.json({ success: true });
});

// Predictions
app.post("/api/predictions", authenticateToken, (req, res) => {
  const predictions = readJSON("predictions.json");
  predictions.push(req.body);
  writeJSON("predictions.json", predictions);
  res.json({ success: true });
});

app.get("/api/predictions/:userId", authenticateToken, (req, res) => {
  const predictions = readJSON("predictions.json");
  res.json(predictions.filter((p) => p.userId === req.params.userId));
});

// Leaderboard
app.get("/api/leaderboard", (req, res) => {
  const users = readJSON("users.json");
  const predictions = readJSON("predictions.json");
  const matches = readJSON("matches.json");

  const leaderboard = users.map((user) => {
    const userPreds = predictions.filter((p) => p.userId === user.id);
    let points = 0;
    let correct = 0;

    userPreds.forEach((p) => {
      const match = matches.find((m) => m.id === p.matchId && m.winner);
      if (!match) return;

      if (match.winner === p.predictedWinner) {
        points += 3;
        correct++;
        if (parseInt(match.margin) === parseInt(p.predictedMargin)) {
          points += 2;
        }
      }
    });

    return {
      userId: user.id,
      name: `${user.firstname} ${user.surname}`,
      points,
      accuracy: userPreds.length ? (correct / userPreds.length) * 100 : 0,
    };
  });

  leaderboard.sort((a, b) => b.points - a.points);
  res.json(leaderboard);
});

// Admin routes
app.post("/api/admin/force-logout", authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.sendStatus(403);
  res.json({ success: true, message: "All users logged out (not really persisted)." });
});

app.post("/api/admin/update-results", authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.sendStatus(403);
  try {
    const count = await updateResultsFromSources();
    res.json({ success: true, updated: count });
  } catch (err) {
    console.error("❌ Results updater failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cron job (daily results updater)
cron.schedule("0 * * * *", async () => {
  console.log("⏰ Running scheduled results update...");
  await updateResultsFromSources();
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});