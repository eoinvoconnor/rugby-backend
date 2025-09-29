const ical = require('node-ical');
const { cleanup, cleanName, isDuplicate, loadDB, saveDB } = require('./utils/cleanup');

async function importTop14FromICS() {
  console.log("📅 Fetching Top 14 fixtures from ICS feed...");
  let url = 'webcal://ics.ecal.com/ecal-sub/68b7239b4ab59700081d121e/Ligue%20Nationale%20De%20Rugby.ics';
  url = url.replace(/^webcal:/, 'https:');  // 👈 FIX

  try {
    const events = await ical.async.fromURL(url);
    let db = loadDB();

    let uniqueMatches = [...db.matches];
    let added = 0;
    let updated = 0;

    for (const key in events) {
      const ev = events[key];
      if (ev.type !== 'VEVENT') continue;

      let summary = cleanName(ev.summary || "");
      if (!summary.includes("vs")) continue;

      const [teamA, teamB] = summary.split("vs").map(t => cleanName(t));
      if (!teamA || !teamB) continue;

      const newMatch = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        teamA,
        teamB,
        competition: "Top 14",
        kickoff: ev.start || null,
        result: null
      };

      const existingIndex = uniqueMatches.findIndex(m => isDuplicate(m, newMatch));

      if (existingIndex === -1) {
        uniqueMatches.push(newMatch);
        added++;
      } else {
        if (uniqueMatches[existingIndex].kickoff !== newMatch.kickoff) {
          uniqueMatches[existingIndex].kickoff = newMatch.kickoff;
          updated++;
        }
      }
    }

    saveDB({ matches: uniqueMatches });
    console.log(`✅ Added ${added} new Top 14 matches`);
    console.log(`🔄 Updated ${updated} existing matches`);
    console.log("🎉 Fixtures saved to data.json");

    // 🔥 run cleanup immediately
    cleanup();
  } catch (err) {
    console.error("❌ Error importing:", err);
  }
}

importTop14FromICS();
