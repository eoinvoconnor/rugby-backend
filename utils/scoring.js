/**
 * Recalculate predictions for a single match.
 */
function recalcPointsForMatch(matchId, matches, predictions, save, PREDICTIONS_FILE) {
  const match = matches.find((m) => m.id === matchId);
  if (!match || !match.result || !match.result.winner) return;

  let updated = 0;

  predictions.forEach((p) => {
    if (p.matchId === matchId) {
      if (p.winner === match.result.winner) {
        // ✅ Correct winner
        p.points = match.result.margin && p.margin === match.result.margin ? 3 : 2;
      } else {
        p.points = 0;
      }
      updated++;
    }
  });

  save(PREDICTIONS_FILE, predictions);
  console.log(`🔄 Recalculated predictions for match ${matchId}: ${updated} updated.`);
}

/**
 * Bulk recalc across ALL matches.
 * - Accepts newResults (from BBC, or another source)
 * - Updates results only if new data is provided
 * - Leaves existing results if BBC didn’t provide anything
 * - Flags recent matches with no result for manual attention
 */
function recalcAllMatches(matches, predictions, newResults, save, MATCHES_FILE, PREDICTIONS_FILE) {
  const now = new Date();
  const flagged = []; // ⚠️ Matches needing manual update

  matches.forEach((match) => {
    const newResult = newResults.find((r) => r.matchId === match.id);

    if (newResult) {
      // 🆕 BBC provided a result
      match.result = {
        winner: newResult.winner || match.result.winner,
        margin: newResult.margin || match.result.margin,
      };
    } else if (!match.result || !match.result.winner) {
      // ❌ No result anywhere
      const daysSinceKickoff = (now - new Date(match.kickoff)) / (1000 * 60 * 60 * 24);
      if (daysSinceKickoff < 7) {
        flagged.push({
          matchId: match.id,
          teamA: match.teamA,
          teamB: match.teamB,
          kickoff: match.kickoff,
          competition: match.competitionName,
        });
      }
    }

    // 🔄 Always recalc predictions if match has a result
    if (match.result && match.result.winner) {
      predictions.forEach((p) => {
        if (p.matchId === match.id) {
          if (p.winner === match.result.winner) {
            p.points = match.result.margin && p.margin === match.result.margin ? 3 : 2;
          } else {
            p.points = 0;
          }
        }
      });
    }
  });

  // Persist updates
  save(MATCHES_FILE, matches);
  save(PREDICTIONS_FILE, predictions);

  console.log(`✅ Bulk recalculation complete. ${matches.length} matches processed.`);
  if (flagged.length) {
    console.warn(`⚠️ ${flagged.length} matches need manual updates.`);
  }

  return flagged; // For showing in admin dashboard
}

module.exports = { recalcPointsForMatch, recalcAllMatches };