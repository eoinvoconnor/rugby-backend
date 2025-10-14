// ==================== IMPORTS ====================
// ES Module version — compatible with "type": "module"

import dotenv from "dotenv";
import express from "express";
import fs from "fs/promises";
import path from "path";
import cors from "cors";
import jwt from "jsonwebtoken";
import cron from "node-cron";
import axios from "axios";
import ical from "node-ical";
import { updateResultsFromSources } from "./utils/resultsUpdater.js";
import { fileURLToPath } from "url";

// __dirname shim for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- ENV & App setup ---
dotenv.config();
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
// --- ICS helpers (place near other helpers) ---
function normalizeUrl(url) {
  return url.startsWith("webcal://") ? url.replace("webcal://", "https://") : url;
}

async function fetchIcsText(url) {
  const response = await axios.get(normalizeUrl(url), {
    responseType: "text",
    headers: { "User-Agent": "rugby-predictions/1.0" },
    timeout: 20000,
  });
  return response.data;
}

/**
 * Very light parser that expects event.summary like "Team A vs Team B" (or "v")
 * and a valid DTSTART for kickoff.
 */
function parseIcsToMatches(icsText, comp) {
  const events = ical.sync.parseICS(icsText);
  const out = [];
  for (const k of Object.keys(events)) {
    const ev = events[k];
    if (!ev || ev.type !== "VEVENT") continue;

    const kickoff = ev.start ? new Date(ev.start) : null;
    const summary = (ev.summary || "").trim();

    // Try split on " vs " or " v "
    let teamA = null, teamB = null;
    if (summary.includes(" vs ")) {
      [teamA, teamB] = summary.split(" vs ").map(s => s.trim());
    } else if (summary.includes(" v ")) {
      [teamA, teamB] = summary.split(" v ").map(s => s.trim());
    }

    if (!kickoff || !teamA || !teamB) continue;

    out.push({
      // id assigned during upsert
      competitionId: comp.id,
      competitionName: comp.name,
      competitionColor: comp.color || "#888888",
      teamA,
      teamB,
      kickoff: kickoff.toISOString(),
      // keep your current result shape
      result: { winner: null, margin: null },
    });
  }
  return out;
}

async function upsertMatchesForCompetition(comp, newMatches) {
  let matches = await readJSON("matches.json");

  // De-dup by same comp + same kickoff + same two teams (order-insensitive)
  const seen = new Set(
    matches.map(m => `${m.competitionId}|${m.kickoff}|${[m.teamA, m.teamB].sort().join("|")}`)
  );

  for (const m of newMatches) {
    const key = `${m.competitionId}|${m.kickoff}|${[m.teamA, m.teamB].sort().join("|")}`;
    if (!seen.has(key)) {
      // assign id
      m.id = matches.length ? Math.max(...matches.map(x => x.id)) + 1 : 1;
      matches.push(m);
      seen.add(key);
    }
  }

  await writeJSON("matches.json", matches);
  return matches.length;
}
// ----- SUPERADMIN GUARD -----
function requireSuperAdmin(req, res, next) {
  // you can also make this an env var if you want: process.env.SUPERADMIN_EMAIL
  const SUPERADMIN_EMAIL = "eoinvoconnor@gmail.com";
  if (!req.user || req.user.email !== SUPERADMIN_EMAIL) {
    return res.status(403).json({ error: "SuperAdmin only" });
  }
  next();
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
// Update an existing user (Admin only)
app.put("/api/users/:id", authenticateToken, async (req, res) => {
  try {
    const users = await readJSON("users.json");
    const index = users.findIndex((u) => u.id === parseInt(req.params.id));
    if (index === -1)
      return res.status(404).json({ error: "User not found" });

    users[index] = { ...users[index], ...req.body };
    await writeJSON("users.json", users);
    res.json(users[index]);
  } catch (err) {
    console.error("❌ Failed to update user:", err);
    res.status(500).json({ error: "Failed to update user" });
  }
});


// ==================== COMPETITIONS ====================
app.get("/api/competitions", async (req, res) => {
  const competitions = await readJSON("competitions.json");
  const includeArchived = String(req.query.includeArchived || "") === "1";
  const filtered = includeArchived
    ? competitions
    : competitions.filter(c => !c.isArchived);
  res.json(filtered);
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
// Add new competition
app.post("/api/competitions", authenticateToken, async (req, res) => {
  try {
    const { name, url, color } = req.body;
    if (!name || !url) {
      return res.status(400).json({ error: "Missing name or URL" });
    }

    const competitions = await readJSON("competitions.json");
    const newCompetition = {
      id: competitions.length ? Math.max(...competitions.map((c) => c.id)) + 1 : 1,
      name,
      url,
      color: color || "#1976d2",
      createdAt: new Date().toISOString(),
    };

    competitions.push(newCompetition);
    await writeJSON("competitions.json", competitions);
    res.status(201).json(newCompetition);
  } catch (err) {
    console.error("❌ Failed to add competition:", err);
    res.status(500).json({ error: "Failed to add competition" });
  }
});
// after: await writeJSON("competitions.json", competitions);

// Immediately refresh this competition so matches appear
try {
  // reuse the same logic as your refresh route
  const normalizedUrl = normalizeUrl(newCompetition.url);
  const response = await axios.get(normalizedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (rugby-app)",
      Accept: "text/calendar",
    },
  });

  const parsed = ical.parseICS(response.data);
  const vsRegex = /(.+?)\s+v(?:s\.?)?\s+(.+)/i;

  const freshMatches = Object.values(parsed)
    .filter((e) => e && e.type === "VEVENT" && e.summary && e.start)
    .map((event) => {
      const m = String(event.summary).match(vsRegex);
      const teamA = m ? m[1].trim() : "TBD";
      const teamB = m ? m[2].trim() : "TBD";
      const kickoffISO = (event.start instanceof Date)
        ? event.start.toISOString()
        : new Date(event.start).toISOString();

      return {
        id: Date.now() + Math.floor(Math.random() * 1000000),
        competitionId: newCompetition.id,
        competitionName: newCompetition.name,
        competitionColor: newCompetition.color || "#888",
        teamA,
        teamB,
        kickoff: kickoffISO,
        result: { winner: null, margin: null },
      };
    });

  // Replace old matches for this comp (there shouldn't be any yet, but safe)
  const matchesNow = await readJSON("matches.json");
  const filtered = matchesNow.filter((m) => m.competitionId !== newCompetition.id);
  await writeJSON("matches.json", [...filtered, ...freshMatches]);

  // also bump lastRefreshed safely
  const latestComps = await readJSON("competitions.json");
  const updatedComps = latestComps.map((c) =>
    c.id === newCompetition.id ? { ...c, lastRefreshed: new Date().toISOString() } : c
  );
  await writeJSON("competitions.json", updatedComps);

  console.log(`✅ Added ${freshMatches.length} matches for new comp ${newCompetition.name}`);
} catch (e) {
  console.error("⚠️ Auto-refresh after add failed:", e.message);
}

// Delete a competition
app.delete("/api/competitions/:id", authenticateToken, async (req, res) => {
  try {
    const competitions = await readJSON("competitions.json");
    const id = parseInt(req.params.id);
    const filtered = competitions.filter((c) => c.id !== id);

    if (filtered.length === competitions.length) {
      return res.status(404).json({ error: "Competition not found" });
    }

    await writeJSON("competitions.json", filtered);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to delete competition:", err);
    res.status(500).json({ error: "Failed to delete competition" });
  }
});
// Refresh a single competition's feed and update its matches
app.post("/api/competitions/:id/refresh", authenticateToken, async (req, res) => {
  const competitions = await readJSON("competitions.json");
  const comp = competitions.find((c) => c.id === parseInt(req.params.id));
  if (!comp) return res.status(404).json({ error: "Competition not found" });

  try {
    const normalizedUrl = normalizeUrl(comp.url);
    console.log(`🔄 Refreshing competition: ${comp.name}`);

    const response = await axios.get(normalizedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (rugby-app)",
        Accept: "text/calendar",
      },
      responseType: "text",
    });

// Soft delete (archive)
app.post("/api/competitions/:id/archive", authenticateToken, async (req, res) => {
  const id = parseInt(req.params.id);
  const competitions = await readJSON("competitions.json");
  const idx = competitions.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: "Competition not found" });
  competitions[idx].isArchived = true;
  await writeJSON("competitions.json", competitions);
  res.json({ success: true, competition: competitions[idx] });
});

// Undo archive
app.post("/api/competitions/:id/unarchive", authenticateToken, async (req, res) => {
  const id = parseInt(req.params.id);
  const competitions = await readJSON("competitions.json");
  const idx = competitions.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: "Competition not found" });
  competitions[idx].isArchived = false;
  await writeJSON("competitions.json", competitions);
  res.json({ success: true, competition: competitions[idx] });
});

// Parse ICS into matches (robust "Team A vs Team B" handling)
const parsed = ical.parseICS(response.data);
const vsRegex = /(.+?)\s+v(?:s\.?)?\s+(.+)/i;

const newMatches = Object.values(parsed)
  .filter((e) => e && e.type === "VEVENT" && e.summary && e.start)
  .map((event) => {
    let teamA = "TBD";
    let teamB = "TBD";
    const m = String(event.summary).match(vsRegex);
    if (m) {
      teamA = m[1].trim();
      teamB = m[2].trim();
    }

    const kickoffISO = (event.start instanceof Date)
      ? event.start.toISOString()
      : new Date(event.start).toISOString();

    return {
      id: Date.now() + Math.floor(Math.random() * 1000000),
      competitionId: comp.id,
      competitionName: comp.name,
      competitionColor: comp.color || "#888",
      teamA,
      teamB,
      kickoff: kickoffISO,
      result: { winner: null, margin: null },
    };
  })
        .filter((m) => m.kickoff); // remove invalid entries

    // Replace old matches for this competition
    const matches = await readJSON("matches.json");
    const filtered = matches.filter((m) => m.competitionId !== comp.id);
    const updatedMatches = [...filtered, ...newMatches];
    await writeJSON("matches.json", updatedMatches);

// ✅ Update lastRefreshed safely: re-read latest competitions file first
    const latestComps = await readJSON("competitions.json");
    const updatedComps = latestComps.map((c) =>
      c.id === comp.id ? { ...c, lastRefreshed: new Date().toISOString() } : c
    );
    await writeJSON("competitions.json", updatedComps);

    console.log(`✅ Updated ${newMatches.length} matches for ${comp.name}`);
    res.json({
      message: `✅ Updated ${newMatches.length} matches for ${comp.name}`,
      added: newMatches.length,
    });
  } catch (err) {
    console.error(`❌ Failed to refresh ${comp.name}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ***** DANGER: SUPERADMIN HARD DELETE W/ CASCADE *****
app.delete(
  "/api/superadmin/competitions/:id",
  authenticateToken,
  requireSuperAdmin,
  async (req, res) => {
    const id = parseInt(req.params.id);

    const competitions = await readJSON("competitions.json");
    const matches = await readJSON("matches.json");
    const predictions = await readJSON("predictions.json");

    const comp = competitions.find(c => c.id === id);
    if (!comp) return res.status(404).json({ error: "Competition not found" });

    // Remove competition
    const newComps = competitions.filter(c => c.id !== id);

    // Remove matches for this comp
    const removedMatches = matches.filter(m => m.competitionId === id);
    const removedMatchIds = new Set(removedMatches.map(m => m.id));
    const newMatches = matches.filter(m => !removedMatchIds.has(m.id));

    // Remove predictions for those matches
    const newPredictions = predictions.filter(p => !removedMatchIds.has(p.matchId));

    await writeJSON("competitions.json", newComps);
    await writeJSON("matches.json", newMatches);
    await writeJSON("predictions.json", newPredictions);

    res.json({
      success: true,
      deleted: {
        competition: comp.id,
        matches: removedMatches.length,
        predictions: predictions.length - newPredictions.length,
      },
    });
  }
);

// ==================== DATA CACHES ====================
// Load data files once when the server starts
let matches = [];
let competitions = [];

const MATCHES_FILE = path.join(DATA_DIR, "matches.json");
const COMPETITIONS_FILE = path.join(DATA_DIR, "competitions.json");

// Helper to load both JSON files into memory
async function loadData() {
  try {
    matches = await readJSON("matches.json");
    competitions = await readJSON("competitions.json");
    console.log(`✅ Loaded ${matches.length} matches and ${competitions.length} competitions`);
  } catch (err) {
    console.error("❌ Failed to load initial data:", err);
  }
}

// Call it once at startup
loadData();

// Helper to save matches back to disk
async function save(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// ==================== MATCHES ====================
app.get("/api/matches", async (req, res) => {
  const allMatches = await readJSON("matches.json");
  const competitions = await readJSON("competitions.json");

  const includeArchived = String(req.query.includeArchived || "") === "1";

  // map of archived competition ids
  const archivedIds = new Set(
    competitions.filter(c => c.isArchived).map(c => c.id)
  );

  let results = includeArchived
    ? allMatches
    : allMatches.filter(m => !archivedIds.has(m.competitionId));

  // (keep your existing sorting/filtering params logic here, if you have it)
  res.json(results);
});
  // Filter by competition
  if (competitionId) {
    results = results.filter((m) => m.competitionId === parseInt(competitionId));
  }

  // Filter by team OR competition name (enhanced search)
  if (team) {
    const t = team.toLowerCase();
    results = results.filter(
      (m) =>
        m.teamA.toLowerCase().includes(t) ||
        m.teamB.toLowerCase().includes(t) ||
        m.competitionName.toLowerCase().includes(t)
    );
  }

  // Date filtering
  if (from) {
    const fromDate = new Date(from);
    results = results.filter((m) => new Date(m.kickoff) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to);
    results = results.filter((m) => new Date(m.kickoff) <= toDate);
  }

  // Sorting
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

// Add a match
app.post("/api/matches", (req, res) => {
  const { competitionId, teamA, teamB, kickoff } = req.body;
  if (!competitionId || !teamA || !teamB || !kickoff) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const comp = competitions.find((c) => c.id === competitionId);

  const match = {
    id: matches.length ? Math.max(...matches.map((m) => m.id)) + 1 : 1,
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

// Edit a match
app.put("/api/matches/:id", (req, res) => {
  const matchId = parseInt(req.params.id);
  const match = matches.find((m) => m.id === matchId);
  if (!match) return res.status(404).json({ error: "Match not found" });

  Object.assign(match, req.body);
  save(MATCHES_FILE, matches);
  res.json(match);
});

// Delete a match
app.delete("/api/matches/:id", (req, res) => {
  const matchId = parseInt(req.params.id);
  const index = matches.findIndex((m) => m.id === matchId);
  if (index === -1) return res.status(404).json({ error: "Match not found" });

  matches.splice(index, 1);
  save(MATCHES_FILE, matches);
  res.json({ success: true });
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