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
export function cleanTeamText(text, compName = "") {
  if (!text) return "";

  let t = String(text).replace(/\u00A0/g, " "); // Replace non-breaking space

  // 🔥 Stronger strip logic
  t = t
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, "")   // Flag emojis
    .replace(/[�]/g, "")                         // Black diamond fallback
    .replace(/\\u[dD][89A-F][0-9A-F]/g, "")      // Unicode surrogate pairs (e.g., \uddeb)
    .replace(/[\uD800-\uDFFF]/g, "")             // High/low surrogate characters
    .replace(/[🏉🏆]/g, "")                       // Common emojis
    .replace(/\|\s*.*?(PREM|CUP|TROPHY).*$/i, "") // Match things like | 🏆 PREM Rugby Cup
    .replace(/[–—−]/g, "-")                      // Normalize dashes
    .replace(/\s{2,}/g, " ")                     // Collapse double spaces
    .trim();

  // Strip known competition prefixes
  const prefixes = [
    compName,
    "URC",
    "PREM",
    "Premiership",
    "Gallagher Premiership",
    "Quilter Autumn Series",
    "Quilter Nations Series",
    "Top 14",
    "International",
    "Challenge Cup",
    "Champions Cup",
    "Rugby World Cup"
  ]
    .filter(Boolean)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  const prefixRegex = new RegExp(`^\\s*(?:${prefixes})\\s*:?\\s*`, "i");
  t = t.replace(prefixRegex, "").trim();

  return t;
}

export function splitTeamsFromSummary(summary, compName = "") {
  const s = String(summary || "");
  const [rawA, rawB] = s.split(/\s+vs\.?\s+|\s+v\s+/i); // "vs", "vs.", or "v"

  if (!rawA || !rawB) return ["TBD", "TBD"];
  return [rawA.trim(), rawB.trim()];
}

/**
 * Normalize feed URLs for calendar imports
 */
export function normalizeUrl(url) {
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
export async function importMatchesFromICS(icsText, comp) {
  if (!icsText || typeof icsText !== "string") {
    throw new Error(`No ICS text provided for competition "${comp?.name || "unknown"}"`);
  }
  if (!comp?.name) throw new Error("Competition object missing name");
  if (!comp?.id) throw new Error("Competition object missing id");

  console.log(`🧩 Parsing ICS feed for ${comp.name}...`);

  // --- Parse the ICS text ---
  const events = ical.parseICS(icsText);

  // --- Load current matches from disk ---
  const matches = await loadJSON(matchesFile);
  let added = 0;
  let updated = 0;

  // --- Iterate through events and build matches ---
  for (const key in events) {
    const ev = events[key];
    if (!ev || ev.type !== "VEVENT") continue;

    const summary = (ev.summary || "").trim();
    if (!summary.match(/\b(vs?\.?)\b/i)) continue; // skip if no "v"/"vs"

    const [teamA, teamB] = splitTeamsFromSummary(summary, comp.name);
    const kickoff = ev.start ? new Date(ev.start).toISOString() : null;
    
    // ✅ Clean here
    const cleanA = cleanTeamText(teamA, comp.name);
    const cleanB = cleanTeamText(teamB, comp.name);
    
    if (!cleanA || !cleanB || (cleanA.toLowerCase() === "tbc" && cleanB.toLowerCase() === "tbc")) continue;
    
    // ✅ Then use cleanA / cleanB below
    matches.push({
      id: Date.now() + Math.floor(Math.random() * 1000),
      competitionId: comp.id,
      competitionName: comp.name,
      competitionColor: comp.color || "#888",
      teamA: cleanA,
      teamB: cleanB,
      kickoff,
      result: { winner: null, margin: null },
    });
    added++;
  }

  // --- Write back to disk ---
  await saveJSON(matchesFile, matches);

  console.log(`✅ ${added} new, ${updated} updated for ${comp.name}`);
  return matches;  // ✅ return the full array, not an object
}