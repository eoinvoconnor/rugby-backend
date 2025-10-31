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

async function fetchBBCResultsForDate(dateISO, todaysMatches) {
  console.log(`📅 Starting scrape for BBC results on ${dateISO}`);

  const url = `https://www.bbc.co.uk/sport/rugby-union/scores-fixtures/${dateISO}`;
  console.log(`🌐 Fetching: ${url}`);

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.warn(`❌ Fetch failed: ${err.message}`);
    return [];
  }

  console.log(`🔁 Response status: ${res.status}`);

  if (!res.ok) {
    console.warn(`❌ BBC returned HTTP ${res.status} for ${url}`);
    return [];
  }

  const html = await res.text();
  console.log(`📄 HTML fetched (${html.length} chars)`);

  // Save the HTML for inspection
  const scrapeDir = path.join(__dirname, "..", "scrape");
  try {
    if (!fs.existsSync(scrapeDir)) {
      fs.mkdirSync(scrapeDir, { recursive: true });
      console.log("📁 Created /scrape directory");
    }
    const outPath = path.join(scrapeDir, `bbc-${dateISO}.html`);
    fs.writeFileSync(outPath, html, "utf8");
    console.log(`💾 Saved HTML to ${outPath}`);
  } catch (e) {
    console.warn(`⚠️ Could not save BBC HTML: ${e.message}`);
  }

  const dom = new JSDOM(html);
  const document = dom.window.document;
  const hiddenSpans = Array.from(document.querySelectorAll('span[class*="visually-hidden"]'));
  console.log(`🔍 Found ${hiddenSpans.length} visually-hidden spans on ${dateISO}`);

  const pattern = /^(.+?) (\d+), (.+?) (\d+) at full time, (.+?) win (\d+) - (\d+)$/i;
  const results = [];

  for (const match of todaysMatches) {
    const a = normalizeTeamName(match.teamA);
    const b = normalizeTeamName(match.teamB);

    const span = hiddenSpans.find(span => {
      const text = span.textContent || "";
      return (
        text.toLowerCase().includes(a.toLowerCase()) ||
        text.toLowerCase().includes(b.toLowerCase())
      );
    });

    if (!span) {
      console.log(`❌ No BBC result text found for ${a} or ${b}`);
      continue;
    }

    const matchResult = span.textContent.match(pattern);
    if (matchResult) {
      const [, team1, score1, team2, score2, winner] = matchResult;
      console.log(`✅ Found result for ${a} vs ${b}: ${span.textContent}`);
      results.push({
        home: normalizeTeamName(team1),
        away: normalizeTeamName(team2),
        homeScore: parseInt(score1, 10),
        awayScore: parseInt(score2, 10),
        winner: normalizeTeamName(winner),
      });
    } else {
      console.log(`⚠️ Found span but failed to parse result for: ${a} vs ${b}`);
      console.log(`↪️ Text: ${span.textContent}`);
    }
  }

  return results;
}

async function updateResultsFromSources(_a, _b, _c, _d, options = {}) {
  const { daysBack = 1, daysForward = 0 } = options;
  const todayISO = new Date().toISOString().slice(0, 10);
  const dates = getDatesInRange(todayISO, daysBack, daysForward);

  if (!fs.existsSync(matchesPath)) {
    console.warn("⚠️ No matches.json found to update.");
    return;
  }

  const matches = JSON.parse(fs.readFileSync(matchesPath, "utf8"));
  let updatedCount = 0;

  for (const date of dates) {
    const todaysMatches = matches.filter(m => m.date === date);
    if (todaysMatches.length === 0) continue;

    try {
      const results = await fetchBBCResultsForDate(date, todaysMatches);

      for (const match of todaysMatches) {
        const matchTeamA = normalizeTeamName(match.teamA);
        const matchTeamB = normalizeTeamName(match.teamB);

        const result = results.find(
          r => normalizeTeamName(r.home) === matchTeamA && normalizeTeamName(r.away) === matchTeamB
        );

        if (!result) {
          console.log(`❌ Could not update result for: ${matchTeamA} vs ${matchTeamB}`);
          continue;
        }

        match.result = {
          winner: result.winner,
          margin: Math.abs(result.homeScore - result.awayScore),
        };
        updatedCount++;
        console.log(`✅ Updated match: ${matchTeamA} vs ${matchTeamB}`);
      }
    } catch (err) {
      console.warn(`⚠️ Error fetching or parsing results for ${date}:`, err.message);
    }
  }

  fs.writeFileSync(matchesPath, JSON.stringify(matches, null, 2), "utf8");
  console.log(`📈 Total match results updated: ${updatedCount}`);
  return { updatedCount };
}

module.exports = { updateResultsFromSources };