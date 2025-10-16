/* utils/resultsUpdater.cjs - CommonJS module */

const axios = require("axios");
const { JSDOM } = require("jsdom");
const fs = require("fs/promises");
const path = require("path");

/* ----------------------------- helpers ----------------------------- */

function normalize(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z]/g, "");
}

async function readJSON(filePath, fallback = []) {
  try {
    const txt = await fs.readFile(filePath, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

/* ----------------------------- scraping ---------------------------- */

/**
 * Fetch results from BBC Rugby Union for a given date (YYYY-MM-DD)
 * Returns: [{ teamA, teamB, winner|null, margin|null }]
 */
async function fetchBBCResults(dateISO) {
  const url = `https://www.bbc.co.uk/sport/rugby-union/scores-fixtures/${dateISO}`;
  console.log(`🌐 Fetching BBC results for ${dateISO}...`);

  try {
    const { data: html } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (rugby-results-updater)",
        Accept: "text/html",
      },
      timeout: 15000,
      responseType: "text",
    });

    const dom = new JSDOM(html);
    const document = dom.window.document;

    const results = [];

    // BBC markup changes; try a couple of selector shapes
    const cards =
      document.querySelectorAll("[data-component='score-card']") ||
      document.querySelectorAll("[data-testid='match-block']");

    cards.forEach((el) => {
      // Try several ways to read team names & scores
      const homeName =
        el.querySelector("[data-team='home']")?.textContent?.trim() ||
        el.querySelector("[data-testid='team-name']")?.textContent?.trim() ||
        "";

      const awayName =
        el.querySelector("[data-team='away']")?.textContent?.trim() ||
        el.querySelectorAll("[data-testid='team-name']")?.[1]?.textContent?.trim() ||
        "";

      const homeScoreTxt =
        el.querySelector("[data-team='home'] .sp-c-score__number")
          ?.textContent?.trim() ||
        el.querySelectorAll("[data-testid='team-score']")?.[0]?.textContent?.trim() ||
        "";

      const awayScoreTxt =
        el.querySelector("[data-team='away'] .sp-c-score__number")
          ?.textContent?.trim() ||
        el.querySelectorAll("[data-testid='team-score']")?.[1]?.textContent?.trim() ||
        "";

      const hs = parseInt(homeScoreTxt, 10);
      const as = parseInt(awayScoreTxt, 10);

      if (!homeName || !awayName || Number.isNaN(hs) || Number.isNaN(as)) return;

      let winner = null;
      let margin = null;
      if (hs !== as) {
        winner = hs > as ? homeName : awayName;
        margin = Math.abs(hs - as);
      }

      results.push({
        teamA: homeName,
        teamB: awayName,
        winner,
        margin,
      });
    });

    console.log(`📊 BBC scrape ${dateISO}: found ${results.length} matches`);
    return results;
  } catch (err) {
    console.error(`❌ Failed BBC fetch for ${dateISO}:`, err.message || err);
    return [];
  }
}

/**
 * Aggregate results for a small window (yesterday..tomorrow by default)
 */
async function fetchAllResults(daysBack = 1, daysForward = 1) {
  const today = new Date();
  const days = [];
  for (let d = -daysBack; d <= daysForward; d++) {
    const dt = new Date(today);
    dt.setDate(today.getDate() + d);
    days.push(dt.toISOString().slice(0, 10));
  }

  let all = [];
  for (const date of days) {
    const chunk = await fetchBBCResults(date);
    all = all.concat(chunk);
  }
  console.log(`📊 Total scraped results across ${days.length} days: ${all.length}`);
  return all;
}

/* ------------------------- update integration ---------------------- */

/**
 * Update matches/predictions with scraped winners/margins.
 *
 * Two modes:
 *  A) Standalone (no args): reads & writes /var/data/*.json (or DATA_DIR)
 *  B) In-memory: pass (matches, predictions, saveMatchesFn, savePredictionsFn)
 */
async function updateResultsFromSources(
  matchesArg,
  predictionsArg,
  saveMatchesArg,
  savePredictionsArg
) {
  // Decide mode
  const inMemory =
    Array.isArray(matchesArg) &&
    Array.isArray(predictionsArg) &&
    typeof saveMatchesArg === "function" &&
    typeof savePredictionsArg === "function";

  // File paths for standalone mode
  const DATA_DIR = process.env.DATA_DIR || "/var/data";
  const MATCHES_FILE = path.join(DATA_DIR, "matches.json");
  const PREDICTIONS_FILE = path.join(DATA_DIR, "predictions.json");

  // Load in whichever mode
  const matches = inMemory ? matchesArg : await readJSON(MATCHES_FILE, []);
  const predictions = inMemory ? predictionsArg : await readJSON(PREDICTIONS_FILE, []);

  const scraped = await fetchAllResults(1, 1);
  let updated = 0;

  for (const r of scraped) {
    const m = matches.find(
      (mm) =>
        normalize(mm.teamA) === normalize(r.teamA) &&
        normalize(mm.teamB) === normalize(r.teamB)
    );

    if (m && r.winner && (!m.result || !m.result.winner)) {
      m.result = { winner: r.winner, margin: r.margin };
      updated++;

      // simple scoring touch (optional)
      for (const p of predictions) {
        if (p.matchId === m.id) {
          p.points = p.winner === r.winner ? 3 : 0;
        }
      }
    }
  }

  if (updated > 0) {
    if (inMemory) {
      await saveMatchesArg();
      await savePredictionsArg();
    } else {
      await writeJSON(MATCHES_FILE, matches);
      await writeJSON(PREDICTIONS_FILE, predictions);
    }
    console.log(`✅ Results updater: ${updated} matches updated (from ${scraped.length} scraped)`);
  } else {
    console.log(`ℹ️ Results updater: no new results (scraped ${scraped.length})`);
  }

  return updated;
}

/* ----------------------------- exports ----------------------------- */

module.exports = {
  normalize,
  fetchBBCResults,
  fetchAllResults,
  updateResultsFromSources,
};

// so ESM `import mod from '.cjs'` can do `mod.default()`
module.exports.default = module.exports.updateResultsFromSources;