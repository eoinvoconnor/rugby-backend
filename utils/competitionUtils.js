// backend/utils/competitionUtils.js
const axios = require("axios");
const ical = require("node-ical");
const fs = require("fs");
const path = require("path");

const competitionsFile = path.join(__dirname, "../data/competitions.json");
const matchesFile = path.join(__dirname, "../data/matches.json");

// Load/save JSON helpers
function loadJSON(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * Convert webcal:// to https:// for axios
 */
function normalizeUrl(url) {
  if (url.startsWith("webcal://")) {
    return url.replace("webcal://", "https://");
  }
  return url;
}

/**
 * Import matches from ICS feed
 */
async function importMatchesFromICS(comp) {
  const url = normalizeUrl(comp.url);
  const res = await axios.get(url);
  const events = ical.parseICS(res.data);

  let matches = loadJSON(matchesFile);
  let added = 0, updated = 0;

  for (let key in events) {
    const ev = events[key];
    if (ev.type === "VEVENT") {
      const summary = (ev.summary || "").trim();
      if (!summary.includes("vs")) continue;

      let [teamA, teamB] = summary.replace("🏉", "").split(" vs ").map(s => s.trim());
      let kickoff = ev.start ? new Date(ev.start).toISOString() : null;

      // Skip placeholders unless explicitly told to keep them
      if (teamA.toLowerCase() === "tbc" && teamB.toLowerCase() === "tbc") continue;

      // Check for existing
      let existing = matches.find(m =>
        m.competition === comp.name &&
        m.teamA === teamA &&
        m.teamB === teamB &&
        Math.abs(new Date(m.kickoff) - new Date(kickoff)) < 1000 * 60 * 60 * 48
      );

      if (existing) {
        existing.kickoff = kickoff;
        updated++;
      } else {
        matches.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          competition: comp.name,
          teamA,
          teamB,
          kickoff,
          result: null,
        });
        added++;
      }
    }
  }

  saveJSON(matchesFile, matches);
  return { added, updated };
}

module.exports = {
  loadJSON,
  saveJSON,
  competitionsFile,
  matchesFile,
  importMatchesFromICS
};
