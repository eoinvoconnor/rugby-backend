// server.js

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const bodyParser = require("body-parser");
const cron = require("node-cron");
const path = require("path");

const {
  fetchAndUpdateResults,
  updateResultsFromSources,
} = require("./utils/resultsUpdater");

const app = express();
const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || "secret";

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());

// ======================================================
// Database setup
// ======================================================
const DBSOURCE = "rugby.db";
const db = new sqlite3.Database(DBSOURCE, (err) => {
  if (err) {
    console.error("❌ Could not connect to database", err);
  } else {
    console.log("✅ Connected to SQLite database.");
  }
});

// Create tables if they don’t exist
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      isAdmin INTEGER DEFAULT 0
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS competitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      color TEXT
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competition_id INTEGER,
      date TEXT,
      team1 TEXT,
      team2 TEXT,
      score1 INTEGER,
      score2 INTEGER,
      completed INTEGER DEFAULT 0,
      FOREIGN KEY (competition_id) REFERENCES competitions(id)
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      match_id INTEGER,
      predicted_winner TEXT,
      predicted_margin INTEGER,
      points_awarded INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (match_id) REFERENCES matches(id)
    )`
  );

  console.log("✅ Database initialized (tables checked/created).");
});

// ======================================================
// Auth Middleware
// ======================================================
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

// ======================================================
// API Endpoints
// ======================================================

// Session version check
app.get("/api/session-version", (req, res) => {
  res.json({ version: "1.0.0" });
});

// User registration
app.post("/api/users/register", (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = bcrypt.hashSync(password, 10);

  const query = `INSERT INTO users (username, password) VALUES (?, ?)`;
  db.run(query, [username, hashedPassword], function (err) {
    if (err) {
      console.error("❌ Error registering user:", err.message);
      return res.status(500).json({ error: "User already exists." });
    }
    res.json({ id: this.lastID, username });
  });
});

// User login
app.post("/api/users/login", (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (err || !user) {
      console.error("❌ Error logging in user:", err?.message || "Not found");
      return res.status(400).json({ error: "Invalid username or password." });
    }

    if (!bcrypt.compareSync(password, user.password)) {
      return res.status(400).json({ error: "Invalid username or password." });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, isAdmin: user.isAdmin },
      JWT_SECRET,
      { expiresIn: "2h" }
    );

    res.json({ token, username: user.username, isAdmin: user.isAdmin });
  });
});

// Get competitions
app.get("/api/competitions", (req, res) => {
  db.all(`SELECT * FROM competitions`, [], (err, rows) => {
    if (err) {
      console.error("❌ Error fetching competitions:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Get matches
app.get("/api/matches", (req, res) => {
  db.all(
    `SELECT m.*, c.name as competition_name, c.color as competition_color
     FROM matches m
     JOIN competitions c ON m.competition_id = c.id
     ORDER BY date ASC`,
    [],
    (err, rows) => {
      if (err) {
        console.error("❌ Error fetching matches:", err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

// Submit prediction
app.post("/api/predictions", authenticateToken, (req, res) => {
  const { match_id, predicted_winner, predicted_margin } = req.body;
  const query = `INSERT INTO predictions (user_id, match_id, predicted_winner, predicted_margin)
                 VALUES (?, ?, ?, ?)`;
  db.run(
    query,
    [req.user.id, match_id, predicted_winner, predicted_margin],
    function (err) {
      if (err) {
        console.error("❌ Error saving prediction:", err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID });
    }
  );
});

// POST prediction (save)
app.post("/api/predictions", (req, res) => {
  const { userId, matchId, predictedWinner, predictedMargin } = req.body;
  if (!userId || !matchId || !predictedWinner || !predictedMargin) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const matchesFile = path.join(DATA_DIR, "matches.json");
  const predictionsFile = path.join(DATA_DIR, "predictions.json");

  // Load matches to find competitionId
  const matches = JSON.parse(fs.readFileSync(matchesFile, "utf8"));
  const match = matches.find((m) => m.id === matchId);

  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }

  // Load existing predictions
  const predictions = JSON.parse(fs.readFileSync(predictionsFile, "utf8"));

  // Create new prediction object (with competitionId + names)
  const newPrediction = {
    id: Date.now(),
    userId,
    matchId,
    predictedWinner,
    predictedMargin,
    competitionId: match.competitionId,
    competitionName: match.competitionName,
    teamA: match.teamA,
    teamB: match.teamB,
    date: match.kickoff,
  };

  predictions.push(newPrediction);

  fs.writeFileSync(predictionsFile, JSON.stringify(predictions, null, 2));
  res.json(newPrediction);
});

// GET predictions by userId
app.get("/api/predictions/:userId", (req, res) => {
  const predictionsFile = path.join(DATA_DIR, "predictions.json");
  const predictions = JSON.parse(fs.readFileSync(predictionsFile, "utf8"));
  const userPredictions = predictions.filter(
    (p) => p.userId == req.params.userId
  );
  res.json(userPredictions);
});

// Leaderboard
app.get("/api/leaderboard", (req, res) => {
  const query = `
    SELECT u.username, SUM(p.points_awarded) as total_points
    FROM predictions p
    JOIN users u ON p.user_id = u.id
    GROUP BY u.id
    ORDER BY total_points DESC
  `;
  db.all(query, [], (err, rows) => {
    if (err) {
      console.error("❌ Error fetching leaderboard:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// ======================================================
// Results updater (manual + cron)
// ======================================================
app.post("/api/admin/update-results", authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.sendStatus(403);

  try {
    await updateResultsFromSources(db);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Results updater failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cron job - run every hour
cron.schedule("0 * * * *", () => {
  console.log("⏰ Scheduled task: updating results...");
  updateResultsFromSources(db).catch((err) =>
    console.error("❌ Scheduled update failed:", err.message)
  );
});

// ======================================================
// Start server
// ======================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});