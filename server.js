// server.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const cors = require("cors");
const ical = require("node-ical");
const cron = require("node-cron");

const {
  fetchAllResults,
  updateResultsFromSources,
} = require("./utils/resultsUpdater");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MATCHES_FILE = path.join(DATA_DIR, "matches.json");
const PREDICTIONS_FILE = path.join(DATA_DIR, "predictions.json");
const COMPETITIONS_FILE = path.join(DATA_DIR, "competitions.json");

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Helpers
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

// Load JSON
let users = load(USERS_FILE);
let matches = load(MATCHES_FILE);
let predictions = load(PREDICTIONS_FILE);
let competitions = load(COMPETITIONS_FILE);

// --- USERS ---
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
app.get("/api/competitions", (req, res) => {
  res.json(competitions);
});

app.post("/api/competitions", async (req, res) => {
  try {
    let { name, url, color } = req.body;
    if (!name || !url) return res.status(400).json({ error: "Missing fields" });

    if (url.startsWith("webcal://")) {
      url = url.replace("webcal://", "https://");
    }

    const newComp = {
      id: competitions.length + 1,
      name,
      url,
      createdAt: new Date().toISOString(),
      lastRefreshed: null,
      color: color || "#1976d2",
    };

    competitions.push(newComp);
    save(COMPETITIONS_FILE, competitions);

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
        competitionColor: newComp.color,
        teamA: teamA.trim(),
        teamB: teamB.trim(),
        kickoff: event.start.toISOString(),
        result: { winner: null, margin: null },
      };

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

    newComp.lastRefreshed = new Date().toISOString();
    save(MATCHES_FILE, matches);
    save(COMPETITIONS_FILE, competitions);

    console.log(`✅ Competition '${name}' added. ${added} matches imported.`);
    res.json({ success: true, competition: newComp, matchesAdded: added });
  } catch (err) {
    console.error("❌ Error importing matches:", err);
    res.status(500).json({ success: false, error: "Import failed" });
  }
});

// Refresh competition
app.post("/api/competitions/:id/refresh", async (req, res) => {
  try {
    const compId = parseInt(req.params.id);
    const comp = competitions.find((c) => c.id === compId);
    if (!comp) return res.status(404).json({ error: "Competition not found" });

    let url = comp.url;
    if (url.startsWith("webcal://")) {
      url = url.replace("webcal://", "https://");
    }

    const events = await ical.async.fromURL(url);
    let added = 0;

    for (let event of Object.values(events)) {
      if (event.type !== "VEVENT") continue;
      const summary = (event.summary || "").replace("🏉", "").trim();
      let [teamA, teamB] = summary.split(" vs ");
      if (!teamA || !teamB) continue;

      const match = {
        id: matches.length + 1,
        competitionId: comp.id,
        competitionName: comp.name,
        competitionColor: comp.color,
        teamA: teamA.trim(),
        teamB: teamB.trim(),
        kickoff: event.start.toISOString(),
        result: { winner: null, margin: null },
      };

      const isDuplicate = matches.some(
        (m) =>
          m.competitionId === comp.id &&
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

    comp.lastRefreshed = new Date().toISOString();
    save(MATCHES_FILE, matches);
    save(COMPETITIONS_FILE, competitions);

    console.log(`🔄 Competition '${comp.name}' refreshed. ${added} new matches.`);
    res.json({
      success: true,
      matchesAdded: added,
      lastRefreshed: comp.lastRefreshed,
    });
  } catch (err) {
    console.error("❌ Error refreshing matches:", err);
    res.status(500).json({ success: false, error: "Refresh failed" });
  }
});

// Edit competition
app.put("/api/competitions/:id", (req, res) => {
  const compId = parseInt(req.params.id);
  const comp = competitions.find((c) => c.id === compId);
  if (!comp) return res.status(404).json({ error: "Competition not found" });

  const { name, url, color } = req.body;
  if (name) comp.name = name;
  if (url)
    comp.url = url.startsWith("webcal://")
      ? url.replace("webcal://", "https://")
      : url;
  if (color) {
    comp.color = color;
    matches.forEach((m) => {
      if (m.competitionId === comp.id) {
        m.competitionColor = color;
      }
    });
    save(MATCHES_FILE, matches);
  }

  save(COMPETITIONS_FILE, competitions);
  res.json({ success: true, competition: comp });
});

// Delete competition
app.delete("/api/competitions/:id", (req, res) => {
  const compId = parseInt(req.params.id);
  const compIndex = competitions.findIndex((c) => c.id === compId);
  if (compIndex === -1) {
    return res
      .status(404)
      .json({ success: false, error: "Competition not found" });
  }

  const removedComp = competitions.splice(compIndex, 1)[0];

  const removedMatchIds = matches
    .filter((m) => m.competitionId === compId)
    .map((m) => m.id);

  const beforeCount = matches.length;
  matches = matches.filter((m) => m.competitionId !== compId);
  const removedMatches = beforeCount - matches.length;

  predictions.forEach((p) => {
    if (removedMatchIds.includes(p.matchId)) {
      p.orphaned = true;
    }
  });

  save(COMPETITIONS_FILE, competitions);
  save(MATCHES_FILE, matches);
  save(PREDICTIONS_FILE, predictions);

  console.log(
    `🗑️ Competition '${removedComp.name}' deleted. ${removedMatches} matches removed. Predictions flagged as orphaned: ${removedMatchIds.length}`
  );
  res.json({
    success: true,
    competition: removedComp,
    matchesRemoved: removedMatches,
    orphanedPredictions: removedMatchIds.length,
  });
});

// --- MATCHES ---
app.get("/api/matches", (req, res) => {
  let { sort, order, competitionId, team, from, to } = req.query;
  let results = [...matches];

  if (competitionId) {
    results = results.filter((m) => m.competitionId === parseInt(competitionId));
  }
  if (team) {
    const t = team.toLowerCase();
    results = results.filter(
      (m) =>
        m.teamA.toLowerCase().includes(t) || m.teamB.toLowerCase().includes(t)
    );
  }
  if (from) {
    const fromDate = new Date(from);
    results = results.filter((m) => new Date(m.kickoff) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to);
    results = results.filter((m) => new Date(m.kickoff) <= toDate);
  }

  if (sort) {
    const dir = order === "desc" ? -1 : 1;
    results.sort((a, b) => {
      if (sort === "date") {
        return (new Date(a.kickoff) - new Date(b.kickoff)) * dir;
      } else if (sort === "competition") {
        return a.competitionName.localeCompare(b.competitionName) * dir;
      } else if (sort === "team") {
        return a.teamA.localeCompare(b.teamA) * dir;
      }
      return 0;
    });
  }

  res.json(results);
});

app.post("/api/matches", (req, res) => {
  const { competitionId, teamA, teamB, kickoff } = req.body;
  if (!competitionId || !teamA || !teamB || !kickoff) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const comp = competitions.find((c) => c.id === competitionId);

  const match = {
    id: matches.length + 1,
    competitionId,
    competitionName: comp ? comp.name : "Unknown",
    competitionColor: comp ? comp.color : "#888888",
    teamA,
    teamB,
    kickoff,
    result: { winner: null, margin: null },
  };

  matches.push(match);
  save(MATCHES_FILE, matches);
  res.json(match);
});

app.put("/api/matches/:id", (req, res) => {
  const matchId = parseInt(req.params.id);
  const match = matches.find((m) => m.id === matchId);
  if (!match) return res.status(404).json({ error: "Match not found" });
  Object.assign(match, req.body);
  save(MATCHES_FILE, matches);
  res.json(match);
});

// --- PREDICTIONS ---
app.post("/api/predictions", (req, res) => {
  const { userId, matchId, winner } = req.body;
  if (!userId || !matchId || !winner) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const match = matches.find((m) => m.id === matchId);
  if (!match) return res.status(404).json({ error: "Match not found" });

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
      orphaned: false,
    };
    predictions.push(prediction);
  }

  save(PREDICTIONS_FILE, predictions);
  res.json(prediction);
});

// --- LEADERBOARD ---
app.get("/api/leaderboard", (req, res) => {
  let leaderboard = users.map((user) => {
    const userPredictions = predictions.filter((p) => p.userId === user.id);
    const submitted = userPredictions.length;
    const earned = userPredictions.reduce(
      (sum, p) => sum + (p.points || 0),
      0
    );
    const possible = submitted * 3;
    const accuracy = possible ? ((earned / possible) * 100).toFixed(1) : 0;

    const competitionsBreakdown = competitions.map((comp) => {
      const compPreds = userPredictions.filter((p) => {
        const match = matches.find((m) => m.id === p.matchId);
        return match && match.competitionId === comp.id;
      });
      const compSubmitted = compPreds.length;
      const compEarned = compPreds.reduce((sum, p) => sum + (p.points || 0), 0);
      const compPossible = compSubmitted * 3;
      const compAccuracy = compPossible
        ? ((compEarned / compPossible) * 100).toFixed(1)
        : 0;

      return {
        competitionId: comp.id,
        competitionName: comp.name,
        submitted: compSubmitted,
        earned: compEarned,
        accuracy: compAccuracy,
      };
    });

    return {
      user: `${user.firstname} ${user.surname}`,
      submitted,
      earned,
      accuracy,
      competitions: competitionsBreakdown,
    };
  });

  leaderboard.sort((a, b) => b.earned - a.earned);
  res.json(leaderboard);
});

// --- RESULTS UPDATER ---
app.post("/api/admin/update-results", async (req, res) => {
  try {
    const updated = await updateResultsFromSources(
      matches,
      predictions,
      () => save(MATCHES_FILE, matches),
      () => save(PREDICTIONS_FILE, predictions)
    );
    res.json({ success: true, updated });
  } catch (err) {
    console.error("❌ Results updater failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cron job
cron.schedule("0 2 * * *", () => {
  console.log("🕑 Nightly results update running...");
  updateResultsFromSources(
    matches,
    predictions,
    () => save(MATCHES_FILE, matches),
    () => save(PREDICTIONS_FILE, predictions)
  );
});

// --- HEALTH CHECK ---
app.get("/api/hello", (req, res) => {
  res.json({ message: "Backend is running ✅" });
});

// --- Start Server ---
const DEFAULT_PORT = 5000;
let PORT = process.env.PORT || DEFAULT_PORT;

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`⚠️ Port ${port} in use, retrying on ${port + 1}...`);
      startServer(port + 1);
    } else {
      throw err;
    }
  });
}
startServer(PORT);