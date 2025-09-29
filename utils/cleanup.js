const fs = require("fs");
const path = require("path");

const matchesFile = path.join(__dirname, "../matches.json");

function loadMatches() {
  if (!fs.existsSync(matchesFile)) return [];
  return JSON.parse(fs.readFileSync(matchesFile));
}

function saveMatches(matches) {
  fs.writeFileSync(matchesFile, JSON.stringify(matches, null, 2));
}

function normalizeTeam(name) {
  return name
    .replace("🏉", "")
    .replace(/\(Time TBC\)/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupMatches() {
  let matches = loadMatches();
  const cleaned = [];
  const seen = new Set();

  for (let m of matches) {
    const teamA = normalizeTeam(m.teamA);
    const teamB = normalizeTeam(m.teamB);
    const comp = m.competition || "Unknown";
    const kickoff = m.kickoff ? new Date(m.kickoff).toISOString() : null;

    // skip placeholders
    if (!teamA || !teamB || teamA === "TBC" || teamB === "TBC") continue;

    // build duplicate key (competition + teams sorted + kickoff rounded to 48h)
    const teamsKey = [teamA, teamB].sort().join(" vs ");
    const kickoffKey = kickoff ? new Date(kickoff).setHours(0, 0, 0, 0) : "TBC";
    const key = `${comp}-${teamsKey}-${kickoffKey}`;

    if (!seen.has(key)) {
      seen.add(key);
      cleaned.push({
        ...m,
        teamA,
        teamB,
        competition: comp,
        kickoff
      });
    } else {
      console.log(`⚠️ Duplicate removed: ${teamA} vs ${teamB} (${comp})`);
    }
  }

  saveMatches(cleaned);
  console.log(`🎉 Cleanup done. ${cleaned.length} matches saved.`);
}

cleanupMatches();
