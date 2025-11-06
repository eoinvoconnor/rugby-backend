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

// --- Helpers for cleaning feed titles ---
function cleanTeamText(text, compName = "") {
  if (!text) return "";

  let t = String(text).replace(/\u00A0/g, " "); // NBSP → space
  t = t.replace(/[🏉🏆]/g, "");
  t = t.replace(/\p{Extended_Pictographic}/gu, ""); // all emojis

  const prefixes = [
    compName,
    "URC", "PREM", "Premiership", "English Prem Rugby Cup", "Gallagher Premiership",
    "Quilter Autumn Series", "Quilter Nations Series", "Top 14", "International",
    "Challenge Cup", "Champions Cup"
  ]
    .filter(Boolean)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  t = t
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, "") // remove flags
    .replace(new RegExp(`^\\s*(?:${prefixes})\\s*:?\\s*`, "i"), "")
    .trim();

  return t;
}

function splitTeamsFromSummary(summary, compName = "") {
  const s = String(summary || "");
  const [rawA, rawB] = s.split(/\s+vs\.?\s+|\s+v\s+/i);
  if (!rawA || !rawB) {
    const cleaned = cleanTeamText(s, compName);
    return [cleaned, "TBD"];
  }
  return [cleanTeamText(rawA, compName), cleanTeamText(rawB, compName)];
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
// We now receive pre-fetched ICS text directly
if (!icsText || typeof icsText !== "string") {
  throw new Error(`No ICS text provided for competition "${comp.name}"`);
}

  let matches = loadJSON(matchesFile);
  let added = 0, updated = 0;

  for (let key in events) {
    const ev = events[key];
    if (ev.type !== "VEVENT") continue;

    const summary = (ev.summary || "").trim();
    if (!summary.includes("vs") && !summary.includes(" v ")) continue;

    const [teamA, teamB] = splitTeamsFromSummary(summary, comp.name);
    const kickoff = ev.start ? new Date(ev.start).toISOString() : null;

    if (!teamA || !teamB || teamA.toLowerCase() === "tbc" && teamB.toLowerCase() === "tbc") continue;

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