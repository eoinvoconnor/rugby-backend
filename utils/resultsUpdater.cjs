// backend/utils/resultsUpdater.js
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

// Normalize team names for comparison
function normalize(name) {
  return name.toLowerCase().replace(/\s+/g, "").replace(/[^a-z]/g, "");
}

/**
 * Fetch results from BBC Rugby Union scores for a given date
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<Array<{teamA: string, teamB: string, winner: string|null, margin: number|null}>>}
 */
async function fetchBBCResults(date) {
  const url = `https://www.bbc.com/sport/rugby-union/scores-fixtures/${date}`;
  console.log(`🌐 Fetching BBC results for ${date}...`);

  try {
    const response = await require("node-fetch")(url); // ✅ explicit import for Node
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    const dom = new JSDOM(text);
    const document = dom.window.document;

    const matches = [];
    const matchNodes = document.querySelectorAll('[data-testid="match-block"]');

    matchNodes.forEach((node) => {
      try {
        const teams = node.querySelectorAll('[data-testid="team-name"]');
        const scores = node.querySelectorAll('[data-testid="team-score"]');

        if (teams.length === 2 && scores.length === 2) {
          const teamA = teams[0].textContent.trim();
          const teamB = teams[1].textContent.trim();
          const scoreA = parseInt(scores[0].textContent.trim(), 10);
          const scoreB = parseInt(scores[1].textContent.trim(), 10);

          let winner = null;
          let margin = null;

          if (!isNaN(scoreA) && !isNaN(scoreB)) {
            if (scoreA > scoreB) {
              winner = teamA;
              margin = scoreA - scoreB;
            } else if (scoreB > scoreA) {
              winner = teamB;
              margin = scoreB - scoreA;
            }
          }

          matches.push({ teamA, teamB, winner, margin });
        }
      } catch (err) {
        console.warn("⚠️ Failed to parse a match block:", err.message);
      }
    });

    console.log(`📊 BBC scrape for ${date}: found ${matches.length} matches`);
    return matches;
  } catch (err) {
    console.error(`❌ Failed BBC fetch for ${date}:`, err);
    return [];
  }
}

/**
 * Aggregate results for multiple dates (yesterday, today, tomorrow)
 */
async function fetchAllResults() {
  const today = new Date();
  const dates = [-1, 0, 1].map((offset) => {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    return d.toISOString().split("T")[0];
  });

  let allResults = [];
  for (const date of dates) {
    const results = await fetchBBCResults(date);
    allResults = allResults.concat(results);
  }

  console.log(`📊 Total scraped results across ${dates.length} days: ${allResults.length}`);
  return allResults;
}

/**
 * Update stored matches and predictions with scraped results
 */
async function updateResultsFromSources(matches, predictions, saveMatches, savePredictions) {
  const results = await fetchAllResults();
  let updated = 0;

  results.forEach((r) => {
    const match = matches.find(
      (m) =>
        normalize(m.teamA) === normalize(r.teamA) &&
        normalize(m.teamB) === normalize(r.teamB)
    );

    if (match && r.winner && !match.result.winner) {
      match.result = { winner: r.winner, margin: r.margin };
      updated++;

      predictions.forEach((p) => {
        if (p.matchId === match.id) {
          p.points = p.winner === r.winner ? 3 : 0;
        }
      });
    }
  });

  if (updated > 0) {
    saveMatches();
    savePredictions();
    console.log(`✅ Results updater: ${updated} matches updated (from ${results.length} scraped)`);
  } else {
    console.log(`ℹ️ Results updater: no new results (scraped ${results.length})`);
  }

  return updated;
}

module.exports = {
  normalize,
  fetchBBCResults,
  fetchAllResults,
  updateResultsFromSources,
};