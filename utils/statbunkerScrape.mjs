// utils/statbunkerScrape.mjs
import axios from "axios";
import * as cheerio from "cheerio";

const URL =
  "https://rugby.statbunker.com/competitions/LastMatches?comp_id=769&limit=50&offs=UTC";
// ^ Premiership example you shared. Change comp_id/limit as needed.

function tidy(s) {
  return String(s || "")
    .replace(/\u00A0/g, " ") // NBSP -> space
    .replace(/\s+/g, " ")
    .trim();
}

async function run() {
  try {
    console.log(`🌐 Fetching: ${URL}`);
    const { data: html } = await axios.get(URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; rugby-predictions-bot/1.0; +https://example.com)",
        Accept: "text/html,application/xhtml+xml",
      },
      timeout: 20000,
    });

    const $ = cheerio.load(html);

    // Statbunker tends to use a standard table; we’ll be defensive here.
    // Grab the first big table on the page and parse its rows.
    const rows = $("table tbody tr");
    const out = [];

    rows.each((_, tr) => {
      const tds = $(tr).find("td");
      if (tds.length < 4) return;

      // Heuristics: typical columns look like:
      // [Date] [Home] [Score] [Away] (sometimes comp/round/order vary)
      const dateText = tidy($(tds[0]).text());
      const homeText = tidy($(tds[1]).text());
      const scoreText = tidy($(tds[2]).text());
      const awayText = tidy($(tds[3]).text());

      // Parse score like "24 - 18" or "24-18"
      let homeScore = null;
      let awayScore = null;
      const m = scoreText.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (m) {
        homeScore = Number(m[1]);
        awayScore = Number(m[2]);
      }

      out.push({
        date: dateText || null,
        home: homeText || null,
        away: awayText || null,
        homeScore,
        awayScore,
        rawScore: scoreText || null,
      });
    });

    console.log(`📊 Parsed rows: ${out.length}`);
    // Print a compact summary to STDOUT
    out.slice(0, 10).forEach((r, i) => {
      console.log(
        `#${i + 1}: ${r.date} — ${r.home} ${r.homeScore ?? ""} - ${r.awayScore ?? ""} ${r.away}`
      );
    });

    // Also print JSON at the end so you can pipe it if you want
    console.log("\nJSON:");
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error("❌ Scrape failed:", err?.message || err);
    process.exitCode = 1;
  }
}

run();