// /backend/utils/repairPredictions.js

const fs = require("fs");
const path = require("path");

const matchesPath = path.join(__dirname, "../data/matches.json");
const predictionsPath = path.join(__dirname, "../data/predictions.json");
const outputPath = path.join(__dirname, "../data/predictions-remap-candidates.json");

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function getMatchById(matches, matchId) {
  return matches.find((m) => m.id === matchId);
}

function isSameTeamName(nameA, nameB) {
  return nameA.trim().toLowerCase() === nameB.trim().toLowerCase();
}

function findCandidateMatches(matches, predictedWinner, originalKickoff) {
  const originalTime = new Date(originalKickoff).getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return matches.filter((m) => {
    const kickoffTime = new Date(m.kickoff).getTime();
    const isBefore = kickoffTime <= originalTime && kickoffTime >= originalTime - sevenDaysMs;
    const teamMatch = isSameTeamName(m.teamA, predictedWinner) || isSameTeamName(m.teamB, predictedWinner);
    return isBefore && teamMatch;
  });
}

function runRepair() {
  const matches = readJSON(matchesPath);
  const predictions = readJSON(predictionsPath);

  const output = [];
  let repaired = 0;

  for (const pred of predictions) {
    const { matchId, predictedWinner } = pred;
    const originalMatch = getMatchById(matches, matchId);

    if (!originalMatch) {
      output.push({
        prediction: pred,
        originalKickoff: null,
        candidateMatches: findCandidateMatches(matches, predictedWinner, new Date())
      });
      continue;
    }

    const candidateMatches = findCandidateMatches(matches, predictedWinner, originalMatch.kickoff);
    output.push({ prediction: pred, originalKickoff: originalMatch.kickoff, candidateMatches });
  }

  writeJSON(outputPath, output);
  console.log(`✅ Remap candidate file written to predictions-remap-candidates.json (${output.length} entries)`);
}

runRepair();