import teamAliases from "./data/team-aliases.json" assert { type: "json" };

function normalizeTeamName(rawName) {
  const name = rawName.trim();
  for (const [official, aliases] of Object.entries(teamAliases)) {
    if (official.toLowerCase() === name.toLowerCase()) return official;
    if (aliases.some(alias => alias.toLowerCase() === name.toLowerCase())) {
      return official;
    }
  }
  // fallback: return original
  return name;
}