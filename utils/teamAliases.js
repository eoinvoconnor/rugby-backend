// utils/teamAliases.js

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to team-aliases.json in utils/data folder
const aliasFile = path.join(__dirname, "data", "team-aliases.json");
let teamAliases = {};

try {
  const data = fs.readFileSync(aliasFile, "utf8");
  teamAliases = JSON.parse(data);
} catch (err) {
  console.error("❌ Failed to load team-aliases.json:", err.message);
}

function normalizeTeamName(rawName) {
  const name = rawName.trim();
  for (const [official, aliases] of Object.entries(teamAliases)) {
    if (official.toLowerCase() === name.toLowerCase()) return official;
    if (aliases.some(alias => alias.toLowerCase() === name.toLowerCase())) {
      return official;
    }
  }
  return name; // fallback to raw name
}

export { normalizeTeamName };