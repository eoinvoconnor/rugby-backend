// backend/utils/competitionUtils.js
import axios from "axios";
import ical from "node-ical";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const competitionsFile = path.join(__dirname, "../data/competitions.json");
export const matchesFile = path.join(__dirname, "../data/matches.json");

// Load/save JSON helpers
export function loadJSON(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

export function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * Normalize feed URLs for calendar imports
 */
function normalizeUrl(url) {
  if (!url) return "";
  let normalized = url.trim();
  if (normalized.startsWith("webcal://")) {
    normalized = normalized.replace("webcal://", "https://");
  }
  return normalized;
}

/**
 * Import matches from ICS feed
 */
export async function importMatchesFromICS(comp) {
  const url = normalizeUrl(comp.url);
  const res = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Rugby Predictor/1.0)",
      "Accept": "text/calendar, */*;q=0.9",
    },
    timeout: 15000,
  });
  const events = ical.parseICS(res.data);

  let matches = loadJSON(matchesFile);
  let added = 0, updated = 0;

  for (let key in events) {
    const ev = events[key];
    if (ev.type !== "VEVENT") continue;
    const summary = (ev.summary || "").trim();
    if (!summary.includes("vs")) continue;

    let [teamA, teamB] = summary.replace("🏉", "").split(" vs ").map(s => s.trim());
    const kickoff = ev.start ? new Date(ev.start).toISOString() : null;

    if (teamA.toLowerCase() === "tbc" && teamB.toLowerCase() === "tbc") continue;

    const existing = matches.find(m =>
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

  saveJSON(matchesFile, matches);
  return { added, updated };
}