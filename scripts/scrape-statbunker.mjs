// scripts/scrape-statbunker.mjs
// Usage:
//   node scripts/scrape-statbunker.mjs
//   node scripts/scrape-statbunker.mjs "https://rugby.statbunker.com/competitions/LastMatches?comp_id=769&limit=10&offs=UTC"
//
// Notes:
// - Tries to be resilient by discovering table headers dynamically (Home, Away, Score, Date).
// - Computes winner + margin from the "Score" column (e.g., "27 - 24").
// - Outputs clean JSON to stdout.

import axios from "axios";
import * as cheerio from "cheerio";

// default to Premiership recent matches (your example URL)
const DEFAULT_URL =
  "https://rugby.statbunker.com/competitions/LastMatches?comp_id=769&limit=10&offs=UTC";

const url = process.argv[2] || DEFAULT_URL;

function norm(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function pickIndexByHeader(ths, patterns) {
  // Find the first <th> whose text matches any of the provided regexes
  for (let i = 0; i < ths.length; i++) {
    const text = norm(cheerio.load(ths[i]).text());
    for (const re of patterns) {
      if (re.test(text)) return i;
    }
  }
  return -1;
}

function parseScore(scoreText) {
  // e.g. "27 - 24", "27-24", "27–24"
  const m = String(scoreText).match(/(\d+)\s*[-–]\s*(\d+)/);
  if (!m) return { home: null, away: null };
  return { home: parseInt(m[1], 10), away: parseInt(m[2], 10) };
}

(async () => {
  try {
    console.log(`🌐 Fetching Statbunker: ${url}`);
    const { data: html } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome Safari",
          Accept: "text/html,application/xhtml+xml",
      },
      timeout: 30000,
    });

    const $ = cheerio.load(html);

    // Heuristic: take the FIRST table on the page that has a thead + tbody
    const table = $("table").filter((i, el) => $(el).find("thead th").length && $(el).find("tbody tr").length).first();
    if (!table.length) {
      console.log(JSON.stringify({ url, count: 0, results: [] }, null, 2));
      return;
    }

    const ths = table.find("thead th").toArray();

    // Dynamically locate columns
    const idxHome  = pickIndexByHeader(ths, [/home/i, /team\s*a/i]);
    const idxAway  = pickIndexByHeader(ths, [/away/i, /team\s*b/i]);
    const idxScore = pickIndexByHeader(ths, [/score/i, /result/i]);
    const idxDate  = pickIndexByHeader(ths, [/date/i, /kick.?off/i]);

    const rows = table.find("tbody tr").toArray();

    const results = rows
      .map((tr) => {
        const tds = $(tr).find("td").toArray();
        if (!tds.length) return null;

        const home  = idxHome  >= 0 ? norm($(tds[idxHome]).text())  : "";
        const away  = idxAway  >= 0 ? norm($(tds[idxAway]).text())  : "";
        const score = idxScore >= 0 ? norm($(tds[idxScore]).text()) : "";
        const date  = idxDate  >= 0 ? norm($(tds[idxDate]).text())  : "";

        if (!home || !away) return null;

        const { home: sH, away: sA } = parseScore(score);
        let winner = null;
        let margin = null;

        if (Number.isFinite(sH) && Number.isFinite(sA)) {
          if (sH > sA) {
            winner = home;
            margin = sH - sA;
          } else if (sA > sH) {
            winner = away;
            margin = sA - sH;
          } // draws => winner stays null
        }

        return {
          home,
          away,
          scoreHome: Number.isFinite(sH) ? sH : null,
          scoreAway: Number.isFinite(sA) ? sA : null,
          date,                 // human string; Statbunker format
          winner,               // string or null
          margin,               // number or null
          source: "statbunker",
        };
      })
      .filter(Boolean);

    console.log(JSON.stringify({ url, count: results.length, results }, null, 2));
  } catch (err) {
    console.error("❌ Statbunker scrape failed:", err?.message || String(err));
    process.exitCode = 1;
  }
})();