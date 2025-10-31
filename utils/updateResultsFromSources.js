// utils/updateResultsFromSources.js

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { JSDOM } = require("jsdom");

const aliases = require("../data/team-aliases.json");
const matchesPath = path.join(__dirname, "../data/matches.json");

function normalizeTeamName(raw) {
  const name = String(raw || "").trim();
  for (const [official, aliasList] of Object.entries(aliases)) {
    if (official.toLowerCase() === name.toLowerCase()) return official;
    if (aliasList.some((a) => a.toLowerCase() === name.toLowerCase())) return official;
  }
  return name;
}

function getDatesInRange(centerDateISO, back = 1, forward = 0) {
  const dates = [];
  const base = new Date(centerDateISO + "T12:00:00Z");
  for (let i = -back; i <= forward; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

async function fetchBBCResultsForDate(dateISO) {
  const url = `https://www.bbc.co.uk/sport/rugby-union/scores-fixtures/${dateISO}`;
  console.log(`🌐 Fetching BBC results for ${dateISO}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  const html = await res.text();
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const results = [];
  const pattern = /^(.+?) (\d+), (.+?) (\d+) at full time, (.+?) win (\d+) - (\d+)$/i;

  document.querySelectorAll("span.visually-hidden").forEach((el) => {
    const text = el.textContent?.trim();
    const match = text.match(pattern);
    if (match) {
      const [, teamA, scoreA, teamB, scoreB, winner, finalA, finalB] = match;
      results.push({
        date: dateISO,
        home: normalizeTeamName(teamA),
        away: normalizeTeamName(teamB),
        homeScore: parseInt(scoreA, 10),
        awayScore: parseInt(scoreB, 10),
        winner: normalizeTeamName(winner),
      });
    }
  });

  console.log(`📊 BBC scrape ${dateISO}: ${results.length} fixtures`);
  return results;
}

async function updateResultsFromSources(_a, _b, _c, _d, options = {}) {
  const { daysBack = 1, daysForward = 0 } = options;
  const todayISO = new Date().toISOString().slice(0, 10);
  const dates = getDatesInRange(todayISO, daysBack, daysForward);

  let allResults = [];
  for (const date of dates) {
    try {
      const res = await fetchBBCResultsForDate(date);
      allResults.push(...res);
    } catch (err) {
      console.warn(`⚠️ Error fetching ${date}:`, err.message);
    }
  }

  if (!fs.existsSync(matchesPath)) {
    console.warn("⚠️ No matches.json found to update.");
    return;
  }

  const matches = JSON.parse(fs.readFileSync(matchesPath, "utf8"));
  let updatedCount = 0;

  matches.forEach((match) => {
    const matchTeamA = normalizeTeamName(match.teamA);
    const matchTeamB = normalizeTeamName(match.teamB);

    const result = allResults.find(
      (r) =>
        normalizeTeamName(r.home) === matchTeamA &&
        normalizeTeamName(r.away) === matchTeamB
    );

    if (!result) {
      console.log(`❌ No match found for: ${matchTeamA} vs ${matchTeamB}`);
    } else {
      console.log(`✅ Matched: ${matchTeamA} vs ${matchTeamB} → ${result.winner}`);
      match.result = {
        winner: result.winner,
        margin: Math.abs(result.homeScore - result.awayScore),
      };
      updatedCount++;
    }
  });

  fs.writeFileSync(matchesPath, JSON.stringify(matches, null, 2), "utf8");
  console.log(`📈 Total scraped across ${dates.length} day(s): ${allResults.length}`);
  console.log(
    updatedCount > 0
      ? `✅ Results updater: updated ${updatedCount} match(es).`
      : `ℹ️ Results updater: nothing to update.`
  );
  return { updatedCount };
}

module.exports = { updateResultsFromSources };