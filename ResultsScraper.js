// ResultsScraper.js
const fetch = require("node-fetch");
const cheerio = require("cheerio");

// Normalise team names to match stored names
function normalize(name) {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

// Scrape BBC results for a specific date (YYYY-MM-DD)
async function fetchBBCResults(dateStr) {
  const url = `https://www.bbc.co.uk/sport/rugby-union/scores-fixtures/${dateStr}`;
  console.log(`📡 Fetching BBC results: ${url}`);

  try {
    const html = await fetch(url).then((r) => r.text());
    const $ = cheerio.load(html);

    const results = [];
    $(".qa-match-block").each((_, el) => {
      const teams = $(el)
        .find(".sp-c-fixture__team-name")
        .map((_, t) => $(t).text().trim())
        .get();

      const scores = $(el)
        .find(".sp-c-fixture__number--ft")
        .map((_, s) => parseInt($(s).text().trim(), 10))
        .get();

      if (teams.length === 2 && scores.length === 2) {
        const [teamA, teamB] = teams;
        const [scoreA, scoreB] = scores;
        let winner = null;
        const margin = Math.abs(scoreA - scoreB);

        if (scoreA > scoreB) winner = teamA;
        else if (scoreB > scoreA) winner = teamB;

        results.push({ teamA, teamB, scoreA, scoreB, winner, margin });
      }
    });

    return results;
  } catch (err) {
    console.error(`❌ Error scraping BBC for ${dateStr}:`, err);
    return [];
  }
}

// Aggregate results across multiple days
async function fetchAllResults() {
  const dates = [];
  for (let offset = -1; offset <= 1; offset++) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    dates.push(d.toISOString().split("T")[0]);
  }

  let allResults = [];
  for (const dateStr of dates) {
    try {
      const daily = await fetchBBCResults(dateStr);
      allResults = allResults.concat(daily);
    } catch (err) {
      console.error(`❌ Failed BBC fetch for ${dateStr}:`, err);
    }
  }

  return allResults;
}

module.exports = {
  fetchAllResults,
  normalize,
};