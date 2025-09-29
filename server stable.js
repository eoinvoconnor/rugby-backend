const express = require("express");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const cors = require("cors");
const ical = require("node-ical");
const app = express();
app.use(cors());
app.use(bodyParser.json());

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MATCHES_FILE = path.join(DATA_DIR, "matches.json");
const PREDICTIONS_FILE = path.join(DATA_DIR, "predictions.json");

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Helper functions
function load(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    console.error(`❌ Error reading ${file}:`, err);
    return [];
  }
}

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Load JSON data
let users = load(USERS_FILE);
let matches = load(MATCHES_FILE);
let predictions = load(PREDICTIONS_FILE);

// --- USERS ---
// Login or register
app.post("/api/users/login", (req, res) => {
  const { email, firstname, surname } = req.body;
  if (!email || !firstname || !surname) {
    return res.status(400).json({ error: "Missing fields" });
  }

  let user = users.find((u) => u.email === email);

  if (!user) {
    user = {
      id: users.length + 1,
      email,
      firstname,
      surname,
      isAdmin: email === "eoinvoconnor@gmail.com",
    };
    users.push(user);
    save(USERS_FILE, users);
  }

  return res.json(user);
});


// --- COMPETITIONS ---
const COMPETITIONS_FILE = path.join(DATA_DIR, "competitions.json");
let competitions = load(COMPETITIONS_FILE);

// Get competitions
app.get("/api/competitions", (req, res) => {
  res.json({ success: true, data: competitions });
});

// Add competition + import fixtures
app.post("/api/competitions", async (req, res) => {
  try {
    const { name, url } = req.body;
    if (!name || !url) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }

    const newComp = {
      id: competitions.length + 1,
      name,
      url,
      createdAt: new Date().toISOString(),
    };

    competitions.push(newComp);
    save(COMPETITIONS_FILE, competitions);

    // Import matches from ICS
    const events = await ical.async.fromURL(url);
    let added = 0;

    for (let event of Object.values(events)) {
      if (event.type !== "VEVENT") continue;

      const summary = (event.summary || "").replace("🏉", "").trim();
      let [teamA, teamB] = summary.split(" vs ");
      if (!teamA || !teamB) continue;

      const match = {
        id: matches.length + 1,
        competitionId: newComp.id,
        competitionName: newComp.name,
        teamA: teamA.trim(),
        teamB: teamB.trim(),
        kickoff: event.start.toISOString(),
        result: { winner: null, margin: null },
      };

      // Prevent duplicates (±48h)
      const isDuplicate = matches.some(
        (m) =>
          m.competitionId === newComp.id &&
          ((m.teamA === match.teamA && m.teamB === match.teamB) ||
            (m.teamA === match.teamB && m.teamB === match.teamA)) &&
          Math.abs(new Date(m.kickoff) - new Date(match.kickoff)) <
            48 * 60 * 60 * 1000
      );

      if (!isDuplicate) {
        matches.push(match);
        added++;
      }
    }

    save(MATCHES_FILE, matches);
    console.log(`✅ Competition '${name}' added. ${added} matches imported.`);

    res.json({
      success: true,
      message: `Competition added with ${added} matches`,
      data: newComp,
    });
  } catch (err) {
    console.error("❌ Error importing matches:", err);
    res.status(500).json({
      success: false,
      error: "Competition saved, but match import failed",
    });
  }
});

// --- MATCHES ---
// Get all matches (public)
app.get("/api/matches", (req, res) => {
  res.json(matches);
});

// Add a match (admin only)
app.post("/api/matches", (req, res) => {
  const { competitionId, teamA, teamB, kickoff } = req.body;
  if (!competitionId || !teamA || !teamB || !kickoff) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const match = {
    id: matches.length + 1,
    competitionId,
    teamA,
    teamB,
    kickoff,
    result: { winner: null, margin: null },
  };

  matches.push(match);
  save(MATCHES_FILE, matches);

  res.json(match);
});

// Edit match (admin only)
app.put("/api/matches/:id", (req, res) => {
  const matchId = parseInt(req.params.id);
  const match = matches.find((m) => m.id === matchId);

  if (!match) return res.status(404).json({ error: "Match not found" });

  Object.assign(match, req.body);
  save(MATCHES_FILE, matches);

  res.json(match);
});



// --- PREDICTIONS ---
// Submit prediction
app.post("/api/predictions", (req, res) => {
  const { userId, matchId, winner } = req.body;
  if (!userId || !matchId || !winner) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const match = matches.find((m) => m.id === matchId);
  if (!match) return res.status(404).json({ error: "Match not found" });

  // Lock after kickoff
  if (new Date(match.kickoff) < new Date()) {
    return res.status(400).json({ error: "Match locked" });
  }

  let prediction = predictions.find(
    (p) => p.userId === userId && p.matchId === matchId
  );

  if (prediction) {
    prediction.winner = winner;
    prediction.submittedAt = new Date().toISOString();
  } else {
    prediction = {
      id: predictions.length + 1,
      userId,
      matchId,
      winner,
      points: null,
      submittedAt: new Date().toISOString(),
    };
    predictions.push(prediction);
  }

  save(PREDICTIONS_FILE, predictions);

  res.json(prediction);
});

// Get user predictions
app.get("/api/predictions/:userId", (req, res) => {
  const userId = parseInt(req.params.userId);
  res.json(predictions.filter((p) => p.userId === userId));
});

// --- LEADERBOARD ---
// Calculate leaderboard dynamically
app.get("/api/leaderboard", (req, res) => {
  let leaderboard = users.map((user) => {
    const userPredictions = predictions.filter((p) => p.userId === user.id);
    const submitted = userPredictions.length;
    const earned = userPredictions.reduce(
      (sum, p) => sum + (p.points || 0),
      0
    );
    const possible = userPredictions.length * 3; // assume 3 max points per match
    const accuracy = possible ? ((earned / possible) * 100).toFixed(1) : 0;

    return {
      user: `${user.firstname} ${user.surname}`,
      submitted,
      earned,
      accuracy,
    };
  });

  leaderboard.sort((a, b) => b.earned - a.earned);

  res.json(leaderboard);
});

// --- HEALTH CHECK ---
app.get("/api/hello", (req, res) => {
  res.json({ message: "Backend is running ✅" });
});

// =============================
// 🚀 Start Server with Fallback
// =============================
const DEFAULT_PORT = 5000;
let PORT = process.env.PORT || DEFAULT_PORT;

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`⚠️ Port ${port} in use, retrying on ${port + 1}...`);
      startServer(port + 1); // recursive retry
    } else {
      throw err;
    }
  });
}

startServer(PORT);
