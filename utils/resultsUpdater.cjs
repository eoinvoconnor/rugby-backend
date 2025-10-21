// CommonJS module (server imports this with dynamic import and uses default or named export)

// Dependencies
const axios = require("axios");
const { JSDOM } = require("jsdom");
const fs = require("fs/promises");
const path = require("path");

// Data dir (same as server.js)
const DATA_DIR = process.env.DATA_DIR || "/var/data";

// ---------- tiny fs helpers ----------
async function readJSON(file) {
  const p = path.join(DATA_DIR, file);
  try {
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt || "[]");
  } catch {
    return [];
  }
}
async function writeJSON(file, data) {
  const p = path.join(DATA_DIR, file);
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

// ---------- string helpers ----------
function normalizeTeam(s) {
  return String(s || "")
    // strip emojis & trophies commonly found on feeds
    .replace(/[\u{1F3C0}-\u{1FAFF}\u{1F300}-\u{1F9FF}]/gu, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function sameTeams(a1, a2, b1, b2) {
  const A = normalizeTeam(a1), B = normalizeTeam(a2);
  const X = normalizeTeam(b1), Y = normalizeTeam(b2);
  return (A === X && B === Y) || (A === Y && B === X);
}

// ---------- BBC scraping ----------
async function fetchBBCResults(dateStr) {
  // Try co.uk first, then com
  const urls = [
    `https://www.bbc.co.uk/sport/rugby-union/scores-fixtures/${dateStr}`,
    `https://www.bbc.com/sport/rugby-union/scores-fixtures/${dateStr}`,
  ];

  let html = null;
  for (const url of urls) {
    try {
      const { data } = await axios.get(url, {
        headers: { "User-Agent": "rugby-predictions/1.0" },
        timeout: 20000,
      });
      html = data;
      break;
    } catch (e) {
      // try next
    }
  }
  if (!html) {
    console.warn(`⚠️ BBC fetch failed for ${dateStr} (both domains)`);
    return [];
  }

  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Each fixture row
  const rows = [...doc.querySelectorAll(".sp-c-fixture")];
  const out = [];

  for (const row of rows) {
    try {
      const teamEls = row.querySelectorAll(".sp-c-fixture__team-name");
      if (teamEls.length !== 2) continue;

      const t1 = teamEls[0].textContent.trim();
      const t2 = teamEls[1].textContent.trim();

      const scoreEls = row.querySelectorAll(".sp-c-fixture__number");
      if (scoreEls.length !== 2) continue; // not completed

      const s1 = parseInt(scoreEls[0].textContent.trim(), 10);
      const s2 = parseInt(scoreEls[1].textContent.trim(), 10);
      if (Number.isNaN(s1) || Number.isNaN(s2)) continue;

      let winner = null, margin = null;
      if (s1 > s2) { winner = t1; margin = s1 - s2; }
      else if (s2 > s1) { winner = t2; margin = s2 - s1; }
      else { winner = null; margin = 0; } // draw

      out.push({
        date: dateStr,
        teamA: t1,
        teamB: t2,
        scoreA: s1,
        scoreB: s2,
        winner,
        margin,
      });
    } catch (e) {
      // ignore row
    }
  }

  console.log(`📊 BBC scrape ${dateStr}: ${out.length} fixtures`);
  return out;
}

// Fetch results for a window around “today”
async function fetchAllResults({ daysBack = 1, daysForward = 1 } = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const results = [];
  for (let d = -daysBack; d <= daysForward; d++) {
    const dt = new Date(today);
    dt.setDate(today.getDate() + d);
    const dateStr = dt.toISOString().slice(0, 10);
    const day = await fetchBBCResults(dateStr);
    results.push(...day);
  }
  console.log(`📈 Total scraped across ${daysBack + daysForward + 1} day(s): ${results.length}`);
  return results;
}

// Update matches & predictions from scraped results
async function updateResultsFromSources(
  matchesArg,
  predictionsArg,
  saveMatchesArg,
  savePredictionsArg,
  opts = {}
) {
  const { daysBack = 1, daysForward = 1 } = opts;

  // read files if not provided (standalone mode)
  const matches = matchesArg || await readJSON("matches.json");
  const predictions = predictionsArg || await readJSON("predictions.json");

  const scraped = await fetchAllResults({ daysBack, daysForward });
  if (scraped.length === 0) {
    console.log("ℹ️ Results updater: nothing to update.");
    return 0;
  }

  // Build quick index for predictions by matchId
  const predsByMatchId = new Map();
  for (const p of predictions) {
    if (!predsByMatchId.has(p.matchId)) predsByMatchId.set(p.matchId, []);
    predsByMatchId.get(p.matchId).push(p);
  }

  let updated = 0;

  for (const r of scraped) {
    // Try to find a match on the same calendar day (±36h tolerance) with same teams
    for (const m of matches) {
      if (!m.kickoff || !m.teamA || !m.teamB) continue;

      const diffHours = Math.abs(new Date(m.kickoff) - new Date(r.date)) / 36e5;
      if (diffHours > 36) continue; // not same day-ish

      if (!sameTeams(m.teamA, m.teamB, r.teamA, r.teamB)) continue;

      // Only update if not already set (or allow overwrite if desired)
      const already = m.result && m.result.winner != null;
      const newWinner = r.winner;
      const newMargin = r.margin;

      if (!already && (newWinner != null)) {
        m.result = { winner: newWinner, margin: newMargin };
        updated++;

        // score simple points for predictions (winner only)
        const ps = predsByMatchId.get(m.id) || [];
        for (const p of ps) {
          p.points = (normalizeTeam(p.winner || p.predictedWinner) === normalizeTeam(newWinner)) ? 3 : 0;
        }
      }
    }
  }

  if (updated > 0) {
    if (saveMatchesArg) await saveMatchesArg();
    else await writeJSON("matches.json", matches);

    if (savePredictionsArg) await savePredictionsArg();
    else await writeJSON("predictions.json", predictions);

    console.log(`✅ Results updater: ${updated} matches updated (from ${scraped.length} scraped)`);
  } else {
    console.log(`ℹ️ Results updater: no new updates (scraped ${scraped.length})`);
  }

  return updated;
}

// Exports
module.exports = {
  normalize: normalizeTeam,
  fetchBBCResults,
  fetchAllResults,
  updateResultsFromSources,
  default: updateResultsFromSources,
};