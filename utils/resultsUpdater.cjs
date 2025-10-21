// utils/resultsUpdater.cjs
// CommonJS module (works with "type": "module" server by dynamic import)

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs/promises");
const path = require("path");

// ------------------ config / helpers ------------------

const DATA_DIR = process.env.DATA_DIR || "/var/data";

async function readJSON(file) {
  const p = path.join(DATA_DIR, file);
  try {
    const txt = await fs.readFile(p, "utf8");
    return txt ? JSON.parse(txt) : [];
  } catch {
    return [];
  }
}

async function writeJSON(file, data) {
  const p = path.join(DATA_DIR, file);
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function ymd(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

// ------------------ scraping ------------------

async function fetchBBCResults(dateStr) {
  const url = `https://www.bbc.com/sport/rugby-union/scores-fixtures/${dateStr}`;
  try {
    const { data: html } = await axios.get(url, {
      headers: { "User-Agent": "rugby-predictions/1.0" },
      timeout: 20000,
    });
    const $ = cheerio.load(html);

    const out = [];

    // --- Newer layout ---
    $('[data-testid="match-block"]').each((_, el) => {
      const root = $(el);
      const names = root.find('[data-testid="team-name"]').map((i, n) => $(n).text().trim()).get();
      const scores = root.find('[data-testid="team-score"]').map((i, n) => parseInt($(n).text().trim(), 10)).get();
      const statusText = root.text().trim();

      if (names.length >= 2 && scores.length >= 2 && /FT/i.test(statusText)) {
        const [teamA, teamB] = names;
        const [scoreA, scoreB] = scores;
        let winner = null, margin = null;
        if (!Number.isNaN(scoreA) && !Number.isNaN(scoreB)) {
          if (scoreA > scoreB) { winner = teamA; margin = scoreA - scoreB; }
          else if (scoreB > scoreA) { winner = teamB; margin = scoreB - scoreA; }
        }
        out.push({ date: dateStr, teamA, teamB, winner, margin });
      }
    });

    // --- Legacy fallback ---
    if (out.length === 0) {
      $('.sp-c-fixture').each((_, el) => {
        const root = $(el);
        const names = root.find('.sp-c-fixture__team-name').map((i, n) => $(n).text().trim()).get();
        const statusText = root.find('.sp-c-fixture__status, .sp-c-fixture__status--ft').text().trim() || root.text().trim();

        // scores might be home/away numbers
        const numHome = parseInt(root.find('.sp-c-fixture__number--home').first().text().trim(), 10);
        const numAway = parseInt(root.find('.sp-c-fixture__number--away').first().text().trim(), 10);

        if (names.length >= 2 && /FT/i.test(statusText) && !Number.isNaN(numHome) && !Number.isNaN(numAway)) {
          const [teamA, teamB] = names;
          let winner = null, margin = null;
          if (numHome > numAway) { winner = teamA; margin = numHome - numAway; }
          else if (numAway > numHome) { winner = teamB; margin = numAway - numHome; }
          out.push({ date: dateStr, teamA, teamB, winner, margin });
        }
      });
    }

    console.log(`📊 BBC scrape ${dateStr}: ${out.length} fixtures`);
    return out;
  } catch (e) {
    console.warn(`⚠️ BBC fetch failed for ${dateStr}: ${e.message}`);
    return [];
  }
}

async function fetchAllResults({ daysBack = 1, daysForward = 1 } = {}) {
  const today = new Date();
  const dates = [];
  for (let i = -daysBack; i <= daysForward; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push(ymd(d));
  }

  let all = [];
  for (const ds of dates) {
    const one = await fetchBBCResults(ds);
    all = all.concat(one);
  }
  console.log(`📈 Total scraped across ${dates.length} day(s): ${all.length}`);
  return all;
}

// ------------------ updater ------------------

/**
 * updateResultsFromSources
 * - If matches/predictions & savers are provided, uses those (in-memory mode).
 * - Otherwise reads/writes /var/data JSON files (standalone mode).
 */
async function updateResultsFromSources(
  matchesArg,
  predictionsArg,
  saveMatchesArg,
  savePredictionsArg,
  opts = {}
) {
  const results = await fetchAllResults(opts);

  const inMemory = Array.isArray(matchesArg) && Array.isArray(predictionsArg);
  const matches = inMemory ? matchesArg : await readJSON("matches.json");
  const predictions = inMemory ? predictionsArg : await readJSON("predictions.json");

  const matchByKey = new Map(
    matches.map(m => {
      const key = `${normalizeName(m.teamA)}|${normalizeName(m.teamB)}|${ymd(m.kickoff)}`;
      return [key, m];
    })
  );

  let updatedMatches = 0;

  for (const r of results) {
    if (!r.winner) continue;

    // Try exact date match first
    let key = `${normalizeName(r.teamA)}|${normalizeName(r.teamB)}|${r.date}`;
    let match = matchByKey.get(key);

    if (!match) {
      // Fallback: try reversed teams (some feeds swap order)
      key = `${normalizeName(r.teamB)}|${normalizeName(r.teamA)}|${r.date}`;
      match = matchByKey.get(key);
    }

    if (match && (!match.result || !match.result.winner)) {
      match.result = { winner: r.winner, margin: r.margin ?? null };
      updatedMatches++;

      // award simple points (3 for correct winner)
      for (const p of predictions) {
        if (p.matchId === match.id) {
          if (p.predictedWinner && r.winner && normalizeName(p.predictedWinner) === normalizeName(r.winner)) {
            p.points = 3;
          } else {
            p.points = 0;
          }
        }
      }
    }
  }

  if (!inMemory) {
    if (updatedMatches > 0) {
      await writeJSON("matches.json", matches);
      await writeJSON("predictions.json", predictions);
      console.log(`✅ Results updater: ${updatedMatches} matches updated.`);
    } else {
      console.log(`ℹ️ Results updater: nothing to update.`);
    }
  } else {
    // in-memory mode: call provided savers if any
    if (updatedMatches > 0) {
      if (typeof saveMatchesArg === "function") await saveMatchesArg();
      if (typeof savePredictionsArg === "function") await savePredictionsArg();
    }
  }

  return updatedMatches;
}

// Expose both ways so dynamic import can find it
module.exports = updateResultsFromSources;
module.exports.updateResultsFromSources = updateResultsFromSources;