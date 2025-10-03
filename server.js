// server.js

const express = require("express");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");

// ⬇️ Replaced old BBC updater with new sources-based updater
const { updateResultsFromSources } = require("./utils/resultsUpdater");

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "secret";

// JSON data directory
const DATA_DIR = path.join(__dirname, "data");

// Middleware
app.use(bodyParser.json());
app.use(cors({ origin: true, credentials: true }));

// Helper: read JSON file
function readJson(file) {
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content);
}

// Helper: write JSON file
function writeJson(file, data) {
  const filePath = path.join(DATA_DIR, file);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Helper: auth middleware (JWT only now 🚀)
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

// ====== API ROUTES ======

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// Debug: list files in /data
app.get("/api/debug/files", (req, res) => {
  const files = fs.readdirSync(DATA_DIR).map((file) => {
    const filePath = path.join(DATA_DIR, file);
    const stats = fs.statSync(filePath);
    return {
      file,
      size: stats.size,
      modified: stats.mtime,
      preview: fs.readFileSync(filePath, "utf-8").substring(0, 200),
    };
  });
  res.json({ files });
});

// ====== USERS ======
app.get("/api/users", (req, res) => {
  res.json(readJson("users.json"));
});

app.post("/api/users", (req, res) => {
  const users = readJson("users.json");
  const newUser = { id: Date.now(), ...req.body };
  users.push(newUser);
  writeJson("users.json", users);
  res.status(201).json(newUser);
});

app.put("/api/users/:id", (req, res) => {
  let users = readJson("users.json");
  users = users.map((u) =>
    u.id === parseInt(req.params.id) ? { ...u, ...req.body } : u
  );
  writeJson("users.json", users);
  res.json({ success: true });
});

app.delete("/api/users/:id", (req, res) => {
  let users = readJson("users.json");
  users = users.filter((u) => u.id !== parseInt(req.params.id));
  writeJson("users.json", users);
  res.json({ success: true });
});

// ====== COMPETITIONS ======
app.get("/api/competitions", (req, res) => {
  res.json(readJson("competitions.json"));
});

app.post("/api/competitions", authenticateToken, (req, res) => {
  const competitions = readJson("competitions.json");
  const newCompetition = { id: Date.now(), ...req.body };
  competitions.push(newCompetition);
  writeJson("competitions.json", competitions);
  res.status(201).json(newCompetition);
});

app.put("/api/competitions/:id", authenticateToken, (req, res) => {
  let competitions = readJson("competitions.json");
  competitions = competitions.map((c) =>
    c.id === parseInt(req.params.id) ? { ...c, ...req.body } : c
  );
  writeJson("competitions.json", competitions);
  res.json({ success: true });
});

app.delete("/api/competitions/:id", authenticateToken, (req, res) => {
  let competitions = readJson("competitions.json");
  competitions = competitions.filter((c) => c.id !== parseInt(req.params.id));
  writeJson("competitions.json", competitions);
  res.json({ success: true });
});

// ====== MATCHES ======
app.get("/api/matches", (req, res) => {
  res.json(readJson("matches.json"));
});

app.post("/api/matches", authenticateToken, (req, res) => {
  const matches = readJson("matches.json");
  const newMatch = { id: Date.now(), ...req.body };
  matches.push(newMatch);
  writeJson("matches.json", matches);
  res.status(201).json(newMatch);
});

app.put("/api/matches/:id", authenticateToken, (req, res) => {
  let matches = readJson("matches.json");
  matches = matches.map((m) =>
    m.id === parseInt(req.params.id) ? { ...m, ...req.body } : m
  );
  writeJson("matches.json", matches);
  res.json({ success: true });
});

app.delete("/api/matches/:id", authenticateToken, (req, res) => {
  let matches = readJson("matches.json");
  matches = matches.filter((m) => m.id !== parseInt(req.params.id));
  writeJson("matches.json", matches);
  res.json({ success: true });
});

// ====== PREDICTIONS ======
app.get("/api/predictions", (req, res) => {
  res.json(readJson("predictions.json"));
});

app.post("/api/predictions", authenticateToken, (req, res) => {
  const predictions = readJson("predictions.json");
  const newPrediction = { id: Date.now(), userId: req.user.id, ...req.body };
  predictions.push(newPrediction);
  writeJson("predictions.json", predictions);
  res.status(201).json(newPrediction);
});

app.put("/api/predictions/:id", authenticateToken, (req, res) => {
  let predictions = readJson("predictions.json");
  predictions = predictions.map((p) =>
    p.id === parseInt(req.params.id) ? { ...p, ...req.body } : p
  );
  writeJson("predictions.json", predictions);
  res.json({ success: true });
});

app.delete("/api/predictions/:id", authenticateToken, (req, res) => {
  let predictions = readJson("predictions.json");
  predictions = predictions.filter((p) => p.id !== parseInt(req.params.id));
  writeJson("predictions.json", predictions);
  res.json({ success: true });
});

// ====== LEADERBOARD ======
app.get("/api/leaderboard", (req, res) => {
  const users = readJson("users.json");
  const predictions = readJson("predictions.json");
  const matches = readJson("matches.json");

  const scores = users.map((u) => {
    const userPreds = predictions.filter((p) => p.userId === u.id);
    let points = 0;
    let correct = 0;
    let total = 0;

    userPreds.forEach((p) => {
      const match = matches.find((m) => m.id === p.matchId);
      if (match && match.result) {
        total++;
        const winner =
          match.result.scoreA > match.result.scoreB ? match.teamA : match.teamB;
        if (p.team === winner) {
          correct++;
          points += 3;
        }
        if (
          match.result.margin &&
          p.margin &&
          Math.abs(match.result.margin - p.margin) <= 5
        ) {
          points += 1;
        }
      }
    });

    return {
      user: u,
      points,
      accuracy: total > 0 ? (correct / total) * 100 : 0,
    };
  });

  scores.sort((a, b) => b.points - a.points);
  res.json(scores);
});

// ====== AUTH ======
app.post("/api/users/login", (req, res) => {
  const { email } = req.body;
  const users = readJson("users.json");
  const user = users.find((u) => u.email === email);

  if (!user) return res.status(401).json({ error: "Invalid login" });

  const token = jwt.sign(user, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user });
});

// ====== RESULTS UPDATER ======
// Manual trigger
app.post("/api/update-results", async (req, res) => {
  try {
    const updated = await updateResultsFromSources();
    res.json({ success: true, updated });
  } catch (err) {
    console.error("Results updater failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Scheduled job
cron.schedule("0 3 * * *", async () => {
  console.log("Scheduled task: updating results...");
  try {
    await updateResultsFromSources();
  } catch (err) {
    console.error("Scheduled update failed:", err);
  }
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});