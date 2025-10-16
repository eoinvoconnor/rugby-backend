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
// --- Helpers for cleaning feed titles (eCal / ICS) ---
function cleanTeamText(text, compName = "") {
  if (!text) return "";

  // Normalize spaces
  let t = String(text).replace(/\u00A0/g, " "); // NBSP → space

  // Remove common emojis/icons that appear in summaries
  t = t.replace(/[🏉🏆]/g, "");

  // Remove an explicit “competition prefix”, e.g. "URC:" or "PREM..." at the start
  // Use compName if present, otherwise a generic set (URC, PREM, Premiership, etc)
  const prefixes = [
    compName,              // exact competition name if present
    "URC",
    "PREM",
    "Premiership",
    "PREM Rugby Cup",
    "Gallagher Premiership"
  ]
    .filter(Boolean)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) // escape regex chars
    .join("|");

  if (prefixes) {
    t = t.replace(new RegExp(`^\\s*(?:${prefixes})\\s*:?\\s*`, "i"), "");
  }

  // Remove suffixes like: "| 🏆 PREM Rugby Cup" or " - 🏆 Something"
  t = t.replace(/\s*\|\s*.*$/i, "");         // drop everything after " | "
  t = t.replace(/\s*-\s*🏆.*$/i, "");         // drop " - 🏆 …"
  t = t.replace(/\s*-\s*(?:PREM.*|URC.*)$/i, ""); // drop " - PREM..." etc

  // Squash duplicate spaces and trim
  t = t.replace(/\s{2,}/g, " ").trim();

  return t;
}

// Split a summary into [teamA, teamB] using common separators
function splitTeamsFromSummary(summary, compName = "") {
  const s = String(summary || "");
  const [rawA, rawB] = s.split(/\s+vs\.?\s+|\s+v\s+/i); // "vs", "vs.", or "v"
  if (!rawA || !rawB) {
    // Fallback: no split; return as-is
    const cleaned = cleanTeamText(s, compName);
    return [cleaned, "TBD"];
  }
  return [
    cleanTeamText(rawA, compName),
    cleanTeamText(rawB, compName),
  ];
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

async function refreshCompetitionById(id) {
  const competitions = await readJSON("competitions.json");
  const comp = competitions.find((c) => c.id === Number(id));
  if (!comp) throw new Error("Competition not found");

  const normalizedUrl = normalizeUrl(comp.url);
  const response = await axios.get(normalizedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (rugby-app)",
      Accept: "text/calendar",
    },
    responseType: "text",
    timeout: 20000,
  });

  const parsed = ical.parseICS(response.data);
  const newMatches = Object.values(parsed)
    .filter((e) => e.type === "VEVENT")
    .map((event) => {
      // --- Clean up the summary text ---
      console.log(`🧾 Raw summary for ${comp.name}:`, JSON.stringify(event.summary));
      let rawSummary = event.summary || "";
      rawSummary = rawSummary
        .replace(/🏉/g, "")          // remove rugby ball emoji
        .replace(/^URC:\s*/i, "")    // remove "URC:" prefix (case-insensitive)
        .trim();
    
      // Split into team names
      const [teamA, teamB] = rawSummary.split(" vs ").map((t) => t?.trim() || "TBD");
    
      return {
        id: Date.now() + Math.floor(Math.random() * 1000),
        competitionId: comp.id,
        competitionName: comp.name,
        competitionColor: comp.color,
        teamA,
        teamB,
        kickoff: event.start,
        result: { winner: null, margin: null },
      };
    });

  const matches = await readJSON("matches.json");
  const filtered = matches.filter((m) => m.competitionId !== comp.id);
  const updatedMatches = [...filtered, ...newMatches];
  await writeJSON("matches.json", updatedMatches);

  // bump lastRefreshed on this comp
  const updatedComps = competitions.map((c) =>
    c.id === comp.id ? { ...c, lastRefreshed: new Date().toISOString() } : c
  );
  await writeJSON("competitions.json", updatedComps);

  return { added: newMatches.length };
}
// ----- SUPERADMIN GUARD -----
// ---- Admin guards ----
const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || "eoinvoconnor@gmail.com";

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
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

// Login (create-if-missing) + issue JWT with admin flags
app.post("/api/users/login", async (req, res) => {
  try {
    const { email, firstname, surname } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || "eoinvoconnor@gmail.com";

    const users = await readJSON("users.json");
    let user = users.find((u) => u.email === email);

    // auto-create if not found (same as before)
    if (!user) {
      user = {
        id: users.length ? Math.max(...users.map(u => u.id)) + 1 : 1,
        email,
        firstname: firstname || "",
        surname: surname || "",
        isAdmin: false,
      };
      users.push(user);
      await writeJSON("users.json", users);
    }

    // compute flags
    const isSuperAdmin = user.email === SUPERADMIN_EMAIL;

    // sign token (same expiry)
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        isAdmin: !!user.isAdmin,
        isSuperAdmin,                 // 👈 new
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // include flags in response
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstname: user.firstname,
        surname: user.surname,
        isAdmin: !!user.isAdmin,
        isSuperAdmin,               // 👈 new
      },
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
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
      lastRefreshed: null,
      hidden: false, // if you support soft-delete; harmless otherwise
    };

    competitions.push(newCompetition);
    await writeJSON("competitions.json", competitions);

    // Try auto-refresh the new comp so matches appear immediately
    try {
      const { added } = await refreshCompetitionById(newCompetition.id);
      console.log(`✅ Auto-refreshed "${newCompetition.name}" — added ${added} matches`);
    } catch (e) {
      console.warn("⚠️ Auto-refresh after add failed:", e.message);
    }

    return res.status(201).json(newCompetition);
  } catch (err) {
    console.error("❌ Failed to add competition:", err);
    return res.status(500).json({ error: "Failed to add competition" });
  }
});


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
// ==================== REFRESH A SINGLE COMPETITION ====================
app.post("/api/competitions/:id/refresh", authenticateToken, async (req, res) => {
  try {
    const competitions = await readJSON("competitions.json");
    const comp = competitions.find((c) => c.id === parseInt(req.params.id));
    if (!comp) return res.status(404).json({ error: "Competition not found" });

    const normalizedUrl = normalizeUrl(comp.url);
    console.log(`🔄 Refreshing competition: ${comp.name}`);

    const response = await axios.get(normalizedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (rugby-app)",
        Accept: "text/calendar",
      },
      responseType: "text",
    });

    const parsed = ical.parseICS(response.data);

    // Build clean matches (team names stripped of emojis/prefixes/suffixes)
    const newMatches = Object.values(parsed)
      .filter((e) => e.type === "VEVENT")
      .map((event) => {
        const [teamA, teamB] = splitTeamsFromSummary(event.summary, comp.name);
        return {
          id: Date.now() + Math.floor(Math.random() * 1000),
          competitionId: comp.id,
          competitionName: comp.name,
          competitionColor: comp.color,
          teamA,
          teamB,
          kickoff: event.start,
          result: { winner: null, margin: null },
        };
      });

// Replace old matches for this competition (avoid shadowing global `matches`)
    const existingMatches = await readJSON("matches.json");
    const filtered = existingMatches.filter((m) => m.competitionId !== comp.id);
    const updatedMatches = [...filtered, ...newMatches];
    await writeJSON("matches.json", updatedMatches);

    // Update lastRefreshed timestamp for the competition
    const updatedComps = competitions.map((c) =>
      c.id === comp.id ? { ...c, lastRefreshed: new Date().toISOString() } : c
    );
    await writeJSON("competitions.json", updatedComps);

    console.log(`✅ Updated ${newMatches.length} matches for ${comp.name}`);
    res.json({
      message: `✅ Updated ${newMatches.length} matches for ${comp.name}`,
      added: newMatches.length,
    });
  } catch (err) {
    console.error(`❌ Failed to refresh competition:`, err.message);
    res.status(500).json({ error: err.message });
  }
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
// Superadmin stuff
// Soft-delete (hide) a competition (does not remove matches/predictions)
app.post("/api/competitions/:id/hide", authenticateToken, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const comps = await readJSON("competitions.json");
  const idx = comps.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: "Competition not found" });
  comps[idx] = { ...comps[idx], active: false };
  await writeJSON("competitions.json", comps);
  res.json({ success: true, competition: comps[idx] });
});

// Restore a hidden competition
app.post("/api/competitions/:id/restore", authenticateToken, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const comps = await readJSON("competitions.json");
  const idx = comps.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: "Competition not found" });
  comps[idx] = { ...comps[idx], active: true };
  await writeJSON("competitions.json", comps);
  res.json({ success: true, competition: comps[idx] });
});

// SuperAdmin-only destructive purge
// SuperAdmin-only destructive purge (hard delete competition + its matches + predictions)
app.delete(
  "/api/admin/competitions/:id/purge",
  authenticateToken,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);

      const competitions = await readJSON("competitions.json");
      const matches = await readJSON("matches.json");
      const predictions = await readJSON("predictions.json");

      const compIdx = competitions.findIndex((c) => c.id === id);
      if (compIdx === -1) {
        return res.status(404).json({ error: "Competition not found" });
      }

      const removedCompetition = competitions[compIdx];

      // collect matchIds for this competition
      const matchIdsToRemove = new Set(
        matches.filter((m) => m.competitionId === id).map((m) => m.id)
      );

      const keptCompetitions = competitions.filter((c) => c.id !== id);
      const keptMatches = matches.filter((m) => m.competitionId !== id);
      const keptPredictions = predictions.filter(
        (p) => !matchIdsToRemove.has(p.matchId)
      );

      // write files
      await writeJSON("competitions.json", keptCompetitions);
      await writeJSON("matches.json", keptMatches);
      await writeJSON("predictions.json", keptPredictions);

      res.json({
        success: true,
        message: `Purged "${removedCompetition.name}" and all related data.`,
        removed: {
          competition: removedCompetition,
          matches: matchIdsToRemove.size,
          predictions: predictions.length - keptPredictions.length,
        },
      });
    } catch (err) {
      console.error("❌ Purge error:", err);
      res.status(500).json({ error: "Failed to purge competition" });
    }
  }
);

// Admin audit: surface useful integrity info
app.get(
  "/api/admin/audit",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const competitions = await readJSON("competitions.json");
      const matches = await readJSON("matches.json");
      const predictions = await readJSON("predictions.json");
      const users = await readJSON("users.json");

      const compById = new Map(competitions.map((c) => [c.id, c]));
      const matchIds = new Set(matches.map((m) => m.id));

      const hiddenCompetitions = competitions.filter((c) => c.active === false);
      const orphanedMatches = matches.filter((m) => !compById.has(m.competitionId));
      const orphanedPredictions = predictions.filter((p) => !matchIds.has(p.matchId));

      // simple per-comp counts
      const matchesByCompetition = competitions.map((c) => ({
        competitionId: c.id,
        name: c.name,
        count: matches.filter((m) => m.competitionId === c.id).length,
      }));

      res.json({
        counts: {
          competitions: competitions.length,
          matches: matches.length,
          predictions: predictions.length,
          users: users.length,
        },
        hiddenCompetitions: hiddenCompetitions.map((c) => ({
          id: c.id,
          name: c.name,
        })),
        orphaned: {
          matches: orphanedMatches.map((m) => ({
            id: m.id,
            competitionId: m.competitionId,
            competitionName: m.competitionName,
            teamA: m.teamA,
            teamB: m.teamB,
            kickoff: m.kickoff,
          })),
          predictions: orphanedPredictions.map((p) => ({
            userId: p.userId,
            matchId: p.matchId,
            predictedWinner: p.predictedWinner,
            margin: p.margin,
          })),
        },
        matchesByCompetition,
      });
    } catch (err) {
      console.error("❌ Audit error:", err);
      res.status(500).json({ error: "Failed to build audit" });
    }
  }
);

// Relink orphaned matches: if competitionId is invalid but competitionName matches a known comp, fix it
app.post(
  "/api/admin/relink-matches",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const competitions = await readJSON("competitions.json");
      const matches = await readJSON("matches.json");

      const compById = new Map(competitions.map((c) => [c.id, c]));
      const compByName = new Map(
        competitions.map((c) => [String(c.name).trim().toLowerCase(), c])
      );

      let updated = 0;

      for (const m of matches) {
        const hasValidCompId = compById.has(m.competitionId);
        if (hasValidCompId) continue;

        const best = compByName.get(String(m.competitionName).trim().toLowerCase());
        if (best) {
          m.competitionId = best.id;
          if (best.color) m.competitionColor = best.color;
          updated++;
        }
      }

      if (updated > 0) {
        await writeJSON("matches.json", matches);
      }

      res.json({
        success: true,
        relinked: updated,
        message:
          updated > 0
            ? `Relinked ${updated} orphaned matches by competition name.`
            : "No orphaned matches found to relink.",
      });
    } catch (err) {
      console.error("❌ Relink error:", err);
      res.status(500).json({ error: "Failed to relink matches" });
    }
  }
);
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
}); // <-- close the POST /refresh route

// ***** DANGER: SUPERADMIN HARD DELETE W/ CASCADE *****
app.delete(
  "/api/superadmin/competitions/:id",
  authenticateToken,
  requireSuperAdmin,
  async (req, res) => {
    const id = parseInt(req.params.id);

    const competitions = await readJSON("competitions.json");
    const allMatches = await readJSON("matches.json");            // <- rename
    const predictions = await readJSON("predictions.json");
    
    const comp = competitions.find(c => c.id === id);
    if (!comp) return res.status(404).json({ error: "Competition not found" });
    
    // Remove competition
    const newComps = competitions.filter(c => c.id !== id);
    
    // Remove matches for this comp
    const removedMatches = allMatches.filter(m => m.competitionId === id);
    const removedMatchIds = new Set(removedMatches.map(m => m.id));
    const keptMatches = allMatches.filter(m => !removedMatchIds.has(m.id)); // <- rename
    
    // Remove predictions for those matches
    const newPredictions = predictions.filter(p => !removedMatchIds.has(p.matchId));
    
    await writeJSON("competitions.json", newComps);
    await writeJSON("matches.json", keptMatches);                 // <- renamed
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

// --- MATCHES ---
app.get("/api/matches", async (req, res) => {
  try {
    const all = await readJSON("matches.json");

    const {
      sort,
      order,
      team,
      from,
      to,
      competitionId: competitionIdRaw,
    } = req.query;

    // always read competitionId from req.query inside the route
    const competitionId = competitionIdRaw ? Number(competitionIdRaw) : null;

    let results = [...all];

    if (competitionId) {
      results = results.filter((m) => m.competitionId === competitionId);
    }

    if (team) {
      const q = String(team).toLowerCase();
      results = results.filter(
        (m) =>
          m.teamA.toLowerCase().includes(q) ||
          m.teamB.toLowerCase().includes(q) ||
          (m.competitionName || "").toLowerCase().includes(q)
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
        if (sort === "date" || sort === "kickoff") {
          return (new Date(a.kickoff) - new Date(b.kickoff)) * dir;
        }
        if (sort === "competition") {
          return a.competitionName.localeCompare(b.competitionName) * dir;
        }
        if (sort === "team") {
          return a.teamA.localeCompare(b.teamA) * dir;
        }
        return 0;
      });
    }

    return res.json(results);
  } catch (e) {
    console.error("❌ /api/matches error:", e);
    return res.status(500).json({ error: "Failed to load matches" });
  }
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