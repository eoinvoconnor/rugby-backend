// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");
const { fetchAllResults, updateResultsFromSources } = require("./utils/resultsUpdater");

const app = express();
const PORT = process.env.PORT || 5001;

// ✅ Serve frontend build in production
app.use(express.static(path.join(__dirname, "../frontend/build")));

// ✅ Body parser middleware
app.use(bodyParser.json());

// ✅ Database setup
const dbPath = path.join(__dirname, "rugby_predictions.db");
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("❌ Error opening database:", err.message);
  } else {
    console.log("✅ Connected to SQLite database.");
    initDatabase(); // 🔹 Ensure tables exist
  }
});

// 🔹 Function to create tables if they don’t exist
function initDatabase() {
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        firstname TEXT,
        surname TEXT,
        isAdmin INTEGER DEFAULT 0
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS competitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        url TEXT,
        color TEXT
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        competitionId INTEGER,
        teamA TEXT,
        teamB TEXT,
        kickoff TEXT,
        result TEXT,
        FOREIGN KEY (competitionId) REFERENCES competitions(id)
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        matchId INTEGER,
        winner TEXT,
        margin INTEGER,
        UNIQUE(userId, matchId),
        FOREIGN KEY (userId) REFERENCES users(id),
        FOREIGN KEY (matchId) REFERENCES matches(id)
      )`
    );

    console.log("✅ Database initialized (tables checked/created).");
  });
}

// ✅ CORS setup for Render
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://rugby-frontend.onrender.com";

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);

// ✅ Session versioning
let sessionVersion = 1;

// ======================================================
// Routes
// ======================================================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Session version (force logout support)
app.get("/api/session-version", (req, res) => {
  res.json({ sessionVersion });
});

// Force logout (admin only)
app.post("/api/admin/force-logout", (req, res) => {
  sessionVersion++;
  res.json({ message: "All users logged out", sessionVersion });
});

// ======================================================
// Competitions
// ======================================================

// Fetch all competitions
app.get("/api/competitions", (req, res) => {
  db.all("SELECT * FROM competitions", [], (err, rows) => {
    if (err) {
      console.error("❌ Error fetching competitions:", err.message);
      res.status(500).json({ error: "Failed to fetch competitions" });
    } else {
      res.json(rows);
    }
  });
});

// Add competition
app.post("/api/competitions", (req, res) => {
  const { name, url, color } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const stmt = db.prepare(
    "INSERT INTO competitions (name, url, color) VALUES (?, ?, ?)"
  );
  stmt.run(name, url, color, function (err) {
    if (err) {
      console.error("❌ Error inserting competition:", err.message);
      res.status(500).json({ error: "Failed to add competition" });
    } else {
      res.json({ success: true, id: this.lastID });
    }
  });
  stmt.finalize();
});

// Update competition
app.put("/api/competitions/:id", (req, res) => {
  const { id } = req.params;
  const { name, url, color } = req.body;

  const stmt = db.prepare(
    "UPDATE competitions SET name = ?, url = ?, color = ? WHERE id = ?"
  );
  stmt.run(name, url, color, id, function (err) {
    if (err) {
      console.error("❌ Error updating competition:", err.message);
      res.status(500).json({ error: "Failed to update competition" });
    } else {
      res.json({ success: true });
    }
  });
  stmt.finalize();
});

// Delete competition
app.delete("/api/competitions/:id", (req, res) => {
  const { id } = req.params;

  const stmt = db.prepare("DELETE FROM competitions WHERE id = ?");
  stmt.run(id, function (err) {
    if (err) {
      console.error("❌ Error deleting competition:", err.message);
      res.status(500).json({ error: "Failed to delete competition" });
    } else {
      res.json({ success: true });
    }
  });
  stmt.finalize();
});

// ======================================================
// Matches
// ======================================================

// Fetch matches
app.get("/api/matches", (req, res) => {
  db.all("SELECT * FROM matches", [], (err, rows) => {
    if (err) {
      console.error("❌ Error fetching matches:", err.message);
      res.status(500).json({ error: "Failed to fetch matches" });
    } else {
      res.json(rows);
    }
  });
});

// Update match
app.put("/api/matches/:id", (req, res) => {
  const { id } = req.params;
  const { teamA, teamB, kickoff, competitionId, result } = req.body;

  const stmt = db.prepare(
    "UPDATE matches SET teamA = ?, teamB = ?, kickoff = ?, competitionId = ?, result = ? WHERE id = ?"
  );
  stmt.run(
    teamA,
    teamB,
    kickoff,
    competitionId,
    JSON.stringify(result),
    id,
    function (err) {
      if (err) {
        console.error("❌ Error updating match:", err.message);
        res.status(500).json({ error: "Failed to update match" });
      } else {
        res.json({ success: true });
      }
    }
  );
  stmt.finalize();
});

// ======================================================
// Predictions
// ======================================================

// Fetch all predictions
app.get("/api/predictions", (req, res) => {
  db.all("SELECT * FROM predictions", [], (err, rows) => {
    if (err) {
      console.error("❌ Error fetching predictions:", err.message);
      res.status(500).json({ error: "Failed to fetch predictions" });
    } else {
      res.json(rows);
    }
  });
});

// Add / update prediction
app.post("/api/predictions", (req, res) => {
  const { userId, matchId, winner, margin } = req.body;

  if (!userId || !matchId) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const stmt = db.prepare(
    "INSERT INTO predictions (userId, matchId, winner, margin) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(userId, matchId) DO UPDATE SET winner = ?, margin = ?"
  );

  stmt.run(
    userId,
    matchId,
    winner,
    margin,
    winner,
    margin,
    function (err) {
      if (err) {
        console.error("❌ Error saving prediction:", err.message);
        res.status(500).json({ error: "Failed to save prediction" });
      } else {
        res.json({ success: true });
      }
    }
  );

  stmt.finalize();
});

// ======================================================
// Users
// ======================================================

app.post("/api/users/login", (req, res) => {
  const { email, firstname, surname } = req.body;
  if (!email || !firstname || !surname) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  db.get("SELECT * FROM users WHERE email = ?", [email], (err, row) => {
    if (err) {
      console.error("❌ Error logging in user:", err.message);
      return res.status(500).json({ error: "Database error" });
    }

    if (row) {
      res.json(row);
    } else {
      const stmt = db.prepare(
        "INSERT INTO users (email, firstname, surname, isAdmin) VALUES (?, ?, ?, ?)"
      );
      stmt.run(email, firstname, surname, 0, function (err) {
        if (err) {
          console.error("❌ Error creating user:", err.message);
          return res.status(500).json({ error: "Failed to create user" });
        }
        db.get(
          "SELECT * FROM users WHERE id = ?",
          [this.lastID],
          (err, newRow) => {
            if (err) {
              console.error("❌ Error fetching new user:", err.message);
              return res.status(500).json({ error: "Failed to fetch new user" });
            }
            res.json(newRow);
          }
        );
      });
      stmt.finalize();
    }
  });
});

// ======================================================
// Admin utilities
// ======================================================

// Recalculate leaderboard
app.post("/api/admin/update-results", async (req, res) => {
  try {
    const updated = await updateResultsFromSources();
    res.json({ message: "Results updated", updated });
  } catch (err) {
    console.error("❌ Results updater failed:", err);
    res.status(500).json({ error: "Failed to update results" });
  }
});

// ======================================================
// Frontend fallback (SPA routing)
// ======================================================
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/build/index.html"));
});

// ======================================================
// Start server
// ======================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ======================================================
// Background jobs
// ======================================================
cron.schedule("0 * * * *", async () => {
  console.log("⏰ Running scheduled results update...");
  try {
    const updated = await fetchAllResults();
    console.log(`✅ Scheduled update: ${updated} matches updated`);
  } catch (err) {
    console.error("❌ Scheduled results update failed:", err);
  }
});