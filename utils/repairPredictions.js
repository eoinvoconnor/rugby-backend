// repairPredictions.js (ES module version)

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// Workaround for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load data
const predictionsPath = path.join(__dirname, "../various/data/predictions.json");
const matchesPath = path.join(__dirname, "../various/data/matches.json");
const outputPath = path.join(__dirname, "../various/data/predictions-remap-candidates.json");

const predictions = JSON.parse(await fs.readFile(predictionsPath, "utf-8"));
const matches = JSON.parse(await fs.readFile(matchesPath, "utf-8"));

const suggestions = [];

for (const p of predictions) {
  const match = matches.find((m) => m.id === p.matchId);
  if (match) continue; // already valid

  const candidates = matches
    .filter((m) => {
      const predicted = (p.predictedWinner || "").toLowerCase();
      const teamA = (m.teamA || "").toLowerCase();
      const teamB = (m.teamB || "").toLowerCase();
      return predicted === teamA || predicted === teamB;
    })
    .filter((m) => {
      // within 7 days BEFORE prediction (conservatively assumes kickoff as lock time)
      const targetKickoff = new Date(m.kickoff);
      const now = new Date();
      return targetKickoff <= now && now - targetKickoff <= 7 * 24 * 60 * 60 * 1000;
    })
    .map((m) => ({
      matchId: m.id,
      kickoff: m.kickoff,
      teamA: m.teamA,
      teamB: m.teamB,
    }));

  suggestions.push({
    original: p,
    suggestedMatches: candidates,
  });
}

await fs.writeFile(outputPath, JSON.stringify(suggestions, null, 2));
console.log(`✅ Wrote ${suggestions.length} remap candidates to ${outputPath}`);