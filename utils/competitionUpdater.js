import { importMatchesFromICS, loadJSON, competitionsFile } from "./competitionUtils.js";

export async function refreshCompetitions() {
  console.log("🔄 Refreshing competitions...");

  const competitions = loadJSON(competitionsFile);
  let totalAdded = 0, totalUpdated = 0;

  for (const comp of competitions) {
    try {
      const { added, updated } = await importMatchesFromICS(comp);
      console.log(`📅 ${comp.name}: ${added} new, ${updated} updated`);
      totalAdded += added;
      totalUpdated += updated;
    } catch (err) {
      console.warn(`⚠️ Failed to refresh ${comp.name}: ${err.message}`);
    }
  }

  console.log(`✅ Refresh complete: ${totalAdded} added, ${totalUpdated} updated`);
}