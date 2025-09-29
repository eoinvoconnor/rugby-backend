const axios = require('axios');
const cheerio = require('cheerio');
const { loadDB, saveDB, cleanName } = require('./utils/cleanup');

const BBC_URL = "https://www.bbc.co.uk/sport/rugby-union/scores-fixtures";

async function updateResultsFromBBC() {
  console.log("📡 Fetching BBC Rugby fixtures/results...");

  try {
    const { data } = await axios.get(BBC_URL);
    const $ = cheerio.load(data);

    const db = loadDB();
    let updatedCount = 0;

    $("div.gs-o-list-ui__item").each((_, el) => {
      const teams = $(el).find("span.gs-u-display-none").map((_, t) => $(t).text().trim()).get();
      const scoreText = $(el).find("span.sp-c-fixture__number--ft").map((_, s) => $(s).text().trim()).get();

      if (teams.length === 2 && scoreText.length === 2) {
        const [teamA, teamB] = teams;
        const [scoreA, scoreB] = scoreText.map(s => parseInt(s, 10));

        const winner = scoreA > scoreB ? teamA : teamB;
        const margin = Math.abs(scoreA - scoreB);

        const matchIndex = db.matches.findIndex(m =>
          cleanName(m.teamA).toLowerCase() === cleanName(teamA).toLowerCase() &&
          cleanName(m.teamB).toLowerCase() === cleanName(teamB).toLowerCase()
        );

        if (matchIndex !== -1) {
          db.matches[matchIndex].result = { winner, margin };
          updatedCount++;
          console.log(`✅ Updated result: ${teamA} ${scoreA}–${scoreB} ${teamB}`);
        }
      }
    });

    saveDB(db);
    console.log(`🎉 BBC update finished. ${updatedCount} matches updated.`);
    return updatedCount;
  } catch (err) {
    console.error("❌ Error fetching BBC results:", err);
    return 0;
  }
}


module.exports = { updateResultsFromBBC };
