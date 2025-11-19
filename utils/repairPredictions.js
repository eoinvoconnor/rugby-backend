// repairPredictions.js
import fs from "fs";
import path from "path";

// Load data
const DATA_DIR = "/var/data"; // Or adjust as needed
const predictionsPath = path.join(DATA_DIR, "predictions.json");
const matchesPath = path.join(DATA_DIR, "matches.json");

let predictions = JSON.parse(fs.readFileSync(predictionsPath, "utf-8"));
let matches = JSON.parse(fs.readFileSync(matchesPath, "utf-8"));

const now = new Date().toISOString();
let repaired = [];

for (const p of predictions) {
  // Skip if matchId not found in matches
  const match = matches.find((m) => m.id === p.matchId);
  if (!match) {
    console.warn(`❌ Match ID ${p.matchId} not found — skipping`);
    continue;
  }

  // Add submittedAt timestamp if not present
  if (!p.submittedAt) {
    p.submittedAt = now;
  }

  repaired.push(p);
}

// Save repaired file
fs.writeFileSync(predictionsPath, JSON.stringify(repaired, null, 2));
console.log(`✅ Repaired ${repaired.length} predictions`);