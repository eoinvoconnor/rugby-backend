/**
 * resultsUpdater.js
 * BBC Rugby scraper + results updater
 */

import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import { fileURLToPath } from "url";
import { normalizeTeamName } from "./teamAliases.js";

// --- Meta + Paths ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log("🧪 resultsUpdater.js loaded");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const SCRAPE_DIR = path.join(__dirname, "../scrape");

// --- Helpers ---
async function readJSON(file) {
  try {
    const fullPath = path.join(DATA_DIR, file);
    const data = await fs.promises.readFile(fullPath, "utf8");
    return JSON.parse(data);
  } catch (err) {
    console.warn(`⚠️ Could not read ${file}:`, err.message);
    return [];
  }
}

async function writeJSON(file, data) {
  const fullPath = path.join(DATA_DIR, file);
  await fs.promises.writeFile(fullPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`💾 Wrote ${file} (${data.length} items)`);
}

// --- Ensure scrape folder exists ---
if (!fs.existsSync(SCRAPE_DIR)) {
  fs.mkdirSync(SCRAPE_DIR, { recursive: true });
  console.log("📁 Created scrape directory:", SCRAPE_DIR);
}

// --- BBC Fetcher ---
async function fetchBBCResultsForDate(dateISO) {
  const url = `https://www.bbc.co.uk/sport/rugby-union/scores-fixtures/${dateISO}`;
  console.log(`📅 Scraping results for ${dateISO}`);
  console.log(`🌐 Fetching: ${url}`);

  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": "rugby-scraper/1.0" },
      timeout: 20000,
    });

    console.log(`🔁 Response status: ${res.status}`);
    const html = res.data || "";
    console.log(`📄 HTML fetched (${html.length} chars)`);

    // Save raw HTML for inspection
    const filePath = path.join(SCRAPE_DIR, `bbc-${dateISO}.html`);
    fs.writeFileSync(filePath, html, "utf8");
    console.log(`💾 Saved HTML to ${filePath}`);

    const $ = cheerio.load(html);
    const spans = $("span.visually-hidden");
    console.log(`🔍 Found ${spans.length} visually-hidden spans`);

    const results = [];

    spans.each((i, el) => {
      const text = $(el).text().trim();
      const matchPattern = /^(.+?)\s+(\d+),\s+(.+?)\s+(\d+)\s+at full time/i;
      const m = text.match(matchPattern);
      if (!m) return;

      const teamA = m[1].trim();
      const scoreA = parseInt(m[2]);
      const teamB = m[3].trim();
      const scoreB = parseInt(m[4]);

      if (!teamA || !teamB || isNaN(scoreA) || isNaN(scoreB)) return;

      const winner =
        scoreA > scoreB ? teamA : scoreB > scoreA ? teamB : "draw";
      const margin = Math.abs(scoreA - scoreB);

      results.push({
        teamA,
        teamB,
        scoreA,
        scoreB,
        winner,
        margin,
      });
    });

    console.log(`📊 Parsed ${results.length} fixtures from BBC for ${dateISO}`);
    if (results.length) console.log(results.slice(0, 3));

    return results;
  } catch (err) {
    console.error(`❌ Fetch failed for ${dateISO}:`, err.message);
    return [];
  }
}

// --- Core Update Function ---
export async function updateResultsFromSources(_, __, ___, ____, options = {}) {
  console.log("🚀 updateResultsFromSources called");
  console.log("📆 Params:", options?.daysBack, options?.daysForward);

  const daysBack = options.daysBack ?? 2;
  const daysForward = options.daysForward ?? 0;

  const today = new Date();
  const dates = [];
  for (let i = daysBack; i >= -daysForward; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    dates.push(d.toISOString().split("T")[0]);
  }

  console.log(`🧮 Will scrape ${dates.length} day(s):`, dates.join(", "));

  let allResults = [];
  for (const dateISO of dates) {
    const dayResults = await fetchBBCResultsForDate(dateISO);
    allResults = allResults.concat(dayResults);
  }

  console.log(`📈 Total scraped across ${dates.length} day(s): ${allResults.length}`);

  if (!allResults.length) {
    console.log("ℹ️ No results scraped — exiting without update.");
    return 0;
  }

  const matches = await readJSON("matches.json");
  if (!matches.length) {
    console.log("⚠️ No matches.json data available — cannot update results.");
    return 0;
  }

  let updates = 0;

  for (const result of allResults) {
    const normA = normalizeTeamName(result.teamA);
    const normB = normalizeTeamName(result.teamB);

    const match = matches.find((m) => {
      const localA = normalizeTeamName(m.teamA);
      const localB = normalizeTeamName(m.teamB);

      return (
        (normA === localA && normB === localB) ||
        (normA === localB && normB === localA)
      );
    });

    if (match) {
      match.result = {
        winner: normalizeTeamName(result.winner),
        margin: result.margin,
      };
      console.log(`✅ Updated match: ${normA} vs ${normB} → ${result.scoreA}-${result.scoreB}`);
      updates++;
    } else {
      console.warn(`⚠️ No match found for: ${normA} vs ${normB}`);
    }
  }

  await writeJSON("matches.json", matches);
  console.log(`📈 Total match results updated: ${updates}`);

  return updates;
}