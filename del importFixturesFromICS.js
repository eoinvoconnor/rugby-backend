const ical = require("node-ical");
const axios = require("axios");
const { loadDB, saveDB } = require("./db");

/**
 * Normalize team name (remove icons, trim spaces, force capitalization)
 */
function cleanTeamName(name) {
  if (!name) return "TBC";
  return name
    .replace(/🏉/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

/**
 * Check if two matches are duplicates:
 * - same competition
 * - same teams (ignoring home/away swap)
 * - kickoff within ±48 hours
 */
function isDuplicate(m1, m2) {
  const timeDiff = Math.abs(new Date(m1.kickoff) - new Date(m2.kickoff));
  const twoDays = 1000 * 60 * 60 * 48;

  const sameTeams =
    (m1.teamA === m2.teamA && m1.teamB === m2.teamB) ||
    (m1.teamA === m2.teamB && m1.teamB === m2.teamA);

  return m1.competition === m2.competition && sameTeams && timeDiff < twoDays;
}

/**
 * Import fixtures from an ICS feed into matches.json
 */
async function importFixturesFromICS(url, competition) {
  console.log(`📅 Fetching fixtures for ${competition} from ${url}...`);

  let raw;
  if (url.startsWith("webcal://")) {
    // Convert to HTTPS
    url = url.replace("webcal://", "https://");
  }

  try {
    const response = await axios.get(url);
    raw = response.data;
  } catch (err) {
    throw new Error(`❌ Failed to fetch ICS: ${err.message}`);
  }

  let events;
  try {
    events = ical.parseICS(raw);
  } catch (err) {
    throw new Error(`❌ Failed to parse ICS: ${err.message}`);
  }

  const db = loadDB();
  let added = 0;
  let updated = 0;

  Object.values(events).forEach((event) => {
    if (!event.summary || !event.start) return;

    // Example summary: "🏉 Toulon vs Bordeaux-Bègles"
    let summary = event.summary.replace(/🏉/g, "").trim();
    if (!summary.includes("vs")) return;

    let [teamA, teamB] = summary.split("vs").map((t) => cleanTeamName(t));
    let kickoff = event.start.toISOString();

    const newMatch = {
      id: Date.now() + Math.floor(Math.random() * 1000), // unique-ish ID
      teamA,
      teamB,
      kickoff,
      competition,
      result: null,
    };

    // Check for duplicates
    let duplicate = db.matches.find((m) => isDuplicate(m, newMatch));

    if (duplicate) {
      // Update kickoff if it changed
      if (duplicate.kickoff !== kickoff) {
        duplicate.kickoff = kickoff;
        updated++;
      }
    } else {
      // Skip obvious placeholders
      if (teamA === "TBC" && teamB === "TBC") return;
      db.matches.push(newMatch);
      added++;
    }
  });

  saveDB(db);
  console.log(`✅ Added ${added} new matches, updated ${updated} existing ones`);
  return { added, updated };
}

module.exports = importFixturesFromICS;
