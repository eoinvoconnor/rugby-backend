// scripts/scrape-statbunker.mjs
// ESM script (works with "type": "module")
// Usage:
//   npm run scrape:statbunker
//   npm run scrape:statbunker -- "https://rugby.statbunker.com/competitions/LastMatches?comp_id=769&limit=50&offs=UTC"

import cheerio from "cheerio";

// Node 18+ has global fetch; if you’re on older Node, add `node-fetch`.
const DEFAULT_URL =
  "https://rugby.statbunker.com/competitions/LastMatches?comp_id=769&limit=10&offs=UTC";

const urlArg = process.argv.slice(2).join(" ").trim();
const TARGET_URL = urlArg || DEFAULT_URL;

function normalize(str) {
  return String(str || "")
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();
}

function parseScorePair(text) {
  // Tries to find: "<homeTeam> <homeScore> - <awayScore> <awayTeam>"
  // or variants that contain a single hyphen between two numbers.
  // Returns { homeTeam, awayTeam, homeScore, awayScore } or null
  const t = normalize(text);

  // First try a flexible regex:
  // … TeamA … (digits) - (digits) … TeamB …
  const rx = /(.*?)(\d+)\s*-\s*(\d+)(.*)/;
  const m = t.match(rx);
  if (!m) return null;

  const left = normalize(m[1]);
  const right = normalize(m[4]);
  const homeScore = parseInt(m[2], 10);
  const awayScore = parseInt(m[3], 10);

  if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) return null;

  // Heuristics to split team names off the edges
  // e.g. left might end with "Bath Rugby", right might start with " Exeter Chiefs"
  // If the page has separate columns for teams, we’ll overwrite this later.
  let homeTeam = left.replace(/[:\-|]+$/g, "").trim();
  let awayTeam = right.replace(/^[:\-|]+/g, "").trim();

  return { homeTeam, awayTeam, homeScore, awayScore };
}

function winnerAndMargin(homeTeam, awayTeam, homeScore, awayScore) {
  if (homeScore > awayScore) {
    return { winner: homeTeam, margin: homeScore - awayScore };
  }
  if (awayScore > homeScore) {
    return { winner: awayTeam, margin: awayScore - homeScore };
  }
  return { winner: null, margin: 0 }; // draw or missing
}

async function main() {
  console.log(`🌐 Fetching: ${TARGET_URL}`);

  const res = await fetch(TARGET_URL, {
    headers: {
      // Some sites block default fetch UA; give it a browsery one.
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    console.error(`❌ HTTP ${res.status}`);
    process.exit(1);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Try to locate the results table(s).
  // Statbunker often uses <table> with rows containing teams & scores.
  // We’ll scan all rows and try to parse them with our score regex.
  const rows = $("table tr");
  const out = [];

  rows.each((_, tr) => {
    const $tr = $(tr);
    const txt = normalize($tr.text());
    if (!txt) return;

    const parsed = parseScorePair(txt);
    if (!parsed) return;

    // Try to improve team names by looking at cells if available
    const tds = $tr.find("td");
    if (tds.length >= 4) {
      // Common layout guess: [Date] [Home team] [Score] [Away team]
      const cellHome = normalize($(tds.get(1)).text());
      const cellScore = normalize($(tds.get(2)).text());
      const cellAway = normalize($(tds.get(3)).text());

      // If the score cell matches N - M, prefer cellHome/cellAway team names.
      if (/\d+\s*-\s*\d+/.test(cellScore)) {
        parsed.homeTeam = cellHome || parsed.homeTeam;
        parsed.awayTeam = cellAway || parsed.awayTeam;
      }
    }

    const { winner, margin } = winnerAndMargin(
      parsed.homeTeam,
      parsed.awayTeam,
      parsed.homeScore,
      parsed.awayScore
    );

    out.push({
      homeTeam: parsed.homeTeam,
      awayTeam: parsed.awayTeam,
      homeScore: parsed.homeScore,
      awayScore: parsed.awayScore,
      winner,
      margin,
      rawRow: txt, // helpful while testing
    });
  });

  console.log(`📊 Parsed ${out.length} fixtures from page.`);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("❌ Scrape error:", e);
  process.exit(1);
});