// Node 18+ (built-in fetch). No extra deps needed.
// Usage:
//   node scripts/scrape-bbc.mjs             # today
//   node scripts/scrape-bbc.mjs 2025-10-19  # specific day
//   node scripts/scrape-bbc.mjs --daysBack=7 --daysForward=0  # a window

const DEFAULT_BACK = 0;
const DEFAULT_FWD  = 0;

function parseArgs() {
  const args = process.argv.slice(2);
  let dateArg = null;
  let daysBack = DEFAULT_BACK;
  let daysForward = DEFAULT_FWD;

  for (const a of args) {
    if (a.startsWith("--daysBack=")) {
      daysBack = Number(a.split("=")[1]) || 0;
    } else if (a.startsWith("--daysForward=")) {
      daysForward = Number(a.split("=")[1]) || 0;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) {
      dateArg = a;
    }
  }
  return { dateArg, daysBack, daysForward };
}

function fmtDate(d) {
  return d.toISOString().slice(0,10);
}

function* dateRange(centerISO, back, fwd) {
  const base = new Date(centerISO + "T12:00:00Z");
  for (let i = -back; i <= fwd; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    yield fmtDate(d);
  }
}

function normalize(s) {
  return String(s || "")
    .replace(/\u00A0/g, " ") // NBSP→space
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchBBC(dateISO) {
  const url = `https://www.bbc.com/sport/rugby-union/scores-fixtures/${dateISO}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; rugby-scraper/1.0)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${url}`);
  }
  return await res.text();
}

// Very lightweight HTML extraction using regex selectors that appear on BBC pages.
// We avoid full DOM libs to keep this standalone.
// We look for:
//   data-testid="team-name">Team</...
//   data-testid="team-score">nn</...
function extractFixtures(html) {
  const teamNames = [...html.matchAll(/data-testid="team-name"[^>]*>([^<]+)/g)]
    .map(m => normalize(m[1]));

  const teamScores = [...html.matchAll(/data-testid="team-score"[^>]*>([^<]+)/g)]
    .map(m => normalize(m[1]));

  // Optionally find FT markers to filter to finished matches
  const blocks = html.split(/data-testid="match-block"/g).slice(1); // crude block split
  // Build an index → whether block contains FT
  // We'll approximate by re-scanning names/scores in order; it’s good enough for sanity-checking.
  // If FT filtering proves too lossy, comment it out.
  const isFinished = []; // parallel to pairs
  for (const b of blocks) {
    isFinished.push(/>\s*FT\s*</i.test(b));
  }

  const fixtures = [];
  const pairs = Math.min(Math.floor(teamNames.length/2), Math.floor(teamScores.length/2));

  for (let i = 0; i < pairs; i++) {
    const teamA = teamNames[i*2];
    const teamB = teamNames[i*2+1];
    const sA = teamScores[i*2];
    const sB = teamScores[i*2+1];

    const scoreA = Number(sA);
    const scoreB = Number(sB);

    // keep only rows that look like finished games (both scores numeric)
    if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB)) continue;

    let winner = null, margin = null;
    if (scoreA > scoreB) { winner = teamA; margin = scoreA - scoreB; }
    else if (scoreB > scoreA) { winner = teamB; margin = scoreB - scoreA; }

    fixtures.push({
      teamA, teamB,
      scoreA, scoreB,
      statusFT: isFinished[i] ?? null,
      winner, margin,
    });
  }

  return fixtures;
}

async function run() {
  const { dateArg, daysBack, daysForward } = parseArgs();
  const todayISO = fmtDate(new Date());
  const center = dateArg || todayISO;

  let grandTotal = 0;
  const allByDate = [];

  for (const date of dateRange(center, daysBack, daysForward)) {
    try {
      process.stdout.write(`🌐 Fetching ${date} ... `);
      const html = await fetchBBC(date);
      const fixtures = extractFixtures(html);
      grandTotal += fixtures.length;
      allByDate.push({ date, fixtures });
      console.log(`found ${fixtures.length}`);
    } catch (e) {
      console.log(`failed (${e.message})`);
      allByDate.push({ date, fixtures: [], error: e.message });
    }
  }

  console.log("\n==================== SUMMARY ====================");
  for (const d of allByDate) {
    console.log(`📅 ${d.date}: ${d.fixtures.length} fixtures`);
    for (const f of d.fixtures) {
      const line =
        `${f.teamA} ${f.scoreA} – ${f.scoreB} ${f.teamB}` +
        (f.winner ? `  → winner: ${f.winner} by ${f.margin}` : "");
      console.log("  • " + line);
    }
    if (d.error) console.log("  (error: " + d.error + ")");
  }
  console.log("=================================================\n");

  // Also dump JSON (one-liner) so you can eyeball/pipe it if you want
  console.log(JSON.stringify(allByDate, null, 2));
}

run().catch(err => {
  console.error("❌ Unhandled error:", err);
  process.exit(1);
});