// backend/utils/resultsUpdater.cjs
// CommonJS module (server is ESM but imports this CJS compatibly)

const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");
const { JSDOM } = require("jsdom");

const DATA_DIR = process.env.DATA_DIR || "/var/data";

// ---------- tiny fs helpers ----------
async function readJSON(file) {
  const fp = path.join(DATA_DIR, file);
  try {
    const txt = await fs.readFile(fp, "utf8");
    return txt ? JSON.parse(txt) : [];
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}
async function writeJSON(file, data) {
  const fp = path.join(DATA_DIR, file);
  await fs.writeFile(fp, JSON.stringify(data, null, 2), "utf8");
}

// ---------- match & team helpers ----------
function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}
function normalizeFixtureKey(teamA, teamB) {
  return `${normalizeName(teamA)}|${normalizeName(teamB)}`;
}

// ---------- BBC scraping ----------
async function fetchBBCResults(dateStr) {
  const url = `https://www.bbc.com/sport/rugby-union/scores-fixtures/${dateStr}`;
  console.log(`🌐 Fetching BBC results for ${dateStr}...`);

  try {
    const { data: html } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (rugby-predictions bot)",
        Accept: "text/html,application/xhtml+xml",
      },
      timeout: 20000,
    });

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const out = [];

    // Primary selector (BBC currently uses these testids)
    let blocks = doc.querySelectorAll('[data-testid="match-block"]');

    // Fallback if markup changes
    if (!blocks || blocks.length === 0) {
      blocks = doc.querySelectorAll("li.gs-o-list-ui__item, div.sp-c-fixture");
    }

    blocks.forEach((node) => {
      try {
        // Try testid selectors first
        let teams = node.querySelectorAll('[data-testid="team-name"]');
        let scores = node.querySelectorAll('[data-testid="team-score"]');

        // Fallbacks if BBC changes attributes
        if (teams.length !== 2) {
          teams = node.querySelectorAll(".sp-c-fixture__team-name, .qa-full-team-name, .gs-u-display-none@m");
        }
        if (scores.length !== 2) {
          scores = node.querySelectorAll(".sp-c-fixture__number, .sp-c-fixture__block a span");
        }

        if (teams.length === 2) {
          const teamA = teams[0].textContent.trim();
          const teamB = teams[1].textContent.trim();

          // Not all fixtures have scores (upcoming); default nulls
          let winner = null;
          let margin = null;

          if (scores.length === 2) {
            const sA = parseInt(scores[0].textContent.trim(), 10);
            const sB = parseInt(scores[1].textContent.trim(), 10);
            if (Number.isFinite(sA) && Number.isFinite(sB)) {
              if (sA > sB) {
                winner = teamA;
                margin = sA - sB;
              } else if (sB > sA) {
                winner = teamB;
                margin = sB - sA;
              } else {
                // draw → leave winner null; margin 0 optional
                margin = 0;
              }
            }
          }

          out.push({ teamA, teamB, winner, margin });
        }
      } catch (e) {
        // keep scraping even if a single block fails
      }
    });

    console.log(`📊 BBC scrape ${dateStr}: ${out.length} fixtures`);
    return out;
  } catch (err) {
    console.error(`❌ Failed BBC fetch for ${dateStr}:`, err.message || err);
    return [];
  }
}

// ---------- windowed fetch ----------
async function fetchAllResults({ daysBack = 7, daysForward = 1 } = {}) {
  const today = new Date();
  const dates = [];

  for (let d = -daysBack; d <= daysForward; d++) {
    const dt = new Date(today);
    dt.setDate(today.getDate() + d);
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    dates.push(`${yyyy}-${mm}-${dd}`);
  }

  let all = [];
  for (const dateStr of dates) {
    const dayRes = await fetchBBCResults(dateStr);
    all = all.concat(dayRes);
  }
  console.log(`📈 Total scraped across ${dates.length} day(s): ${all.length}`);
  return all;
}

// ---------- updater (main export) ----------
async function updateResultsFromSources(
  matchesArg,
  predictionsArg,
  saveMatches,
  savePredictions,
  opts = {}
) {
  // When called from server cron/endpoint we don’t pass arrays;
  // read/write files locally (DATA_DIR).
  const usingFiles = !Array.isArray(matchesArg) && !Array.isArray(predictionsArg);

  const matches = usingFiles ? await readJSON("matches.json") : matchesArg || [];
  const predictions = usingFiles ? await readJSON("predictions.json") : predictionsArg || [];

  const scraped = await fetchAllResults({
    daysBack: Number.isFinite(+opts.daysBack) ? +opts.daysBack : 1,
    daysForward: Number.isFinite(+opts.daysForward) ? +opts.daysForward : 1,
  });

  // Build quick lookup for stored fixtures (both directions A|B and B|A)
  const matchByKey = new Map();
  for (const m of matches) {
    const k1 = normalizeFixtureKey(m.teamA, m.teamB);
    const k2 = normalizeFixtureKey(m.teamB, m.teamA);
    matchByKey.set(k1, m);
    matchByKey.set(k2, m);
  }

  let updatedMatches = 0;

  for (const r of scraped) {
    if (!r.winner) continue; // only finished games

    const key = normalizeFixtureKey(r.teamA, r.teamB);
    const match = matchByKey.get(key);
    if (!match) continue;

    // if not already set, update
    if (!match.result || !match.result.winner) {
      match.result = { winner: r.winner, margin: r.margin ?? null };
      updatedMatches++;

      // award simple points now (adjust to your rules)
      for (const p of predictions) {
        if (p.matchId === match.id) {
          p.points = p.predictedWinner && p.predictedWinner === r.winner ? 3 : 0;
        }
      }
    }
  }

  if (updatedMatches > 0) {
    if (usingFiles) {
      await writeJSON("matches.json", matches);
      await writeJSON("predictions.json", predictions);
    } else {
      // in-memory mode (not used in your deployment, but kept for API parity)
      saveMatches?.();
      savePredictions?.();
    }
    console.log(`✅ Results updater: updated ${updatedMatches} match(es).`);
  } else {
    console.log(`ℹ️ Results updater: nothing to update.`);
  }

  return updatedMatches;
}

// CJS exports (support both default and named)
module.exports = updateResultsFromSources;
module.exports.updateResultsFromSources = updateResultsFromSources;
module.exports.fetchBBCResults = fetchBBCResults;
module.exports.fetchAllResults = fetchAllResults;
module.exports.normalizeName = normalizeName;