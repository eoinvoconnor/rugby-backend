const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { JSDOM } = require("jsdom");

const dataDir = path.join(__dirname, "../data");
const matchesPath = path.join(dataDir, "matches.json");

/**
 * Fetch results from BBC
 * (later we can add more sources here)
 */
async function fetchBBCResults() {
  const url = "https://www.bbc.co.uk/sport/rugby-union/scores-fixtures";
  console.log("🌍 Fetching results from:", url);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch BBC: ${res.status}`);
  }

  const html = await res.text();
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // Example scrape: BBC structure may differ
  const results = [];
  document.querySelectorAll(".sp-c-fixture").forEach((el) => {
    const home = el.querySelector(".sp-c-fixture__team--home .sp-c-fixture__team-name")?.textContent?.trim();
    const away = el.querySelector(".sp-c-fixture__team--away .sp-c-fixture__team-name")?.textContent?.trim();
    const score = el.querySelector(".sp-c-fixture__number--ft")?.textContent?.trim();

    if (home && away && score) {
      const [homeScore, awayScore] = score.split("-").map((s) => parseInt(s.trim(), 10));
      results.push({
        home,
        away,
        homeScore,
        awayScore,
        winner: homeScore > awayScore ? home : away,
      });
    }
  });

  console.log(`✅ BBC returned ${results.length} results`);
  return results;
}

/**
 * Update matches.json with results
 */
async function updateResultsFromSources() {
  try {
    const results = await fetchBBCResults();

    if (!fs.existsSync(matchesPath)) {
      console.warn("⚠️ No matches.json found to update.");
      return;
    }

    const matches = JSON.parse(fs.readFileSync(matchesPath, "utf8"));

    let updatedCount = 0;
    matches.forEach((match) => {
      const result = results.find(
        (r) =>
          r.home.toLowerCase() === match.homeTeam.toLowerCase() &&
          r.away.toLowerCase() === match.awayTeam.toLowerCase()
      );

      if (result) {
        match.result = {
          homeScore: result.homeScore,
          awayScore: result.awayScore,
          winner: result.winner,
        };
        updatedCount++;
      }
    });

    fs.writeFileSync(matchesPath, JSON.stringify(matches, null, 2));
    console.log(`✅ Updated ${updatedCount} matches with results`);
  } catch (err) {
    console.error("❌ Results updater failed:", err.message);
  }
}

module.exports = { updateResultsFromSources };