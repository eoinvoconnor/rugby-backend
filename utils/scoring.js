// backend/utils/scoring.js

/**
 * Normalize team name strings for consistent comparison.
 */
function normalize(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Core scoring rule — the single source of truth for points.
 * - 3 points for correct winner + exact margin
 * - 2 points for correct winner (margin different)
 * - 0 points otherwise
 */
export function calculatePoints(prediction, match) {
  if (!match?.result?.winner) return 0;

  const correctWinner =
    normalize(prediction.predictedWinner || prediction.winner) ===
    normalize(match.result.winner);

  if (!correctWinner) return 0;

  const sameMargin =
    match.result.margin &&
    prediction.margin !== undefined &&
    Number(prediction.margin) === Number(match.result.margin);

  return sameMargin ? 4 : 2;
}

/**
 * Recalculate predictions for a single match.
 */
export function recalcPointsForMatch(matchId, matches, predictions, save, PREDICTIONS_FILE) {
  const match = matches.find((m) => m.id === matchId);
  if (!match || !match.result || !match.result.winner) return;

  let updated = 0;

  predictions.forEach((p) => {
    if (p.matchId === matchId) {
      p.points = calculatePoints(p, match);
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
export function recalcAllMatches(matches, predictions, newResults, save, MATCHES_FILE, PREDICTIONS_FILE) {
  const now = new Date();
  const flagged = []; // ⚠️ Matches needing manual update

  matches.forEach((match) => {
    const newResult = newResults?.find((r) => r.matchId === match.id);

    if (newResult) {
      // 🆕 BBC provided a result
      match.result = {
        winner: newResult.winner || match.result.winner,
        margin: newResult.margin || match.result.margin,
      };
    } else if (!match.result?.winner) {
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
    if (match.result?.winner) {
      predictions.forEach((p) => {
        if (p.matchId === match.id) {
          p.points = calculatePoints(p, match);
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

  return flagged;
}