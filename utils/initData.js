// backend/utils/initData.js
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "../data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// ---- Competitions ----
const competitions = [
  { id: "premiership", name: "Premiership", color: "#0047ab" },
  { id: "top14", name: "Top 14", color: "#ff6600" },
];

// ---- Matches ----
const matches = [
  {
    id: "match1",
    competitionId: "premiership",
    date: "2025-10-05T15:00:00Z",
    homeTeam: "Leicester Tigers",
    awayTeam: "Harlequins",
    result: null, // will be updated later
  },
  {
    id: "match2",
    competitionId: "top14",
    date: "2025-10-06T18:00:00Z",
    homeTeam: "Toulouse",
    awayTeam: "Racing 92",
    result: null,
  },
];

// ---- Users ----
const users = [
  {
    id: "u1",
    email: "admin@example.com",
    firstname: "Admin",
    surname: "User",
    isAdmin: true,
  },
  {
    id: "u2",
    email: "test@example.com",
    firstname: "Test",
    surname: "User",
    isAdmin: false,
  },
];

// ---- Predictions ----
const predictions = [
  {
    userId: "u2",
    matchId: "match1",
    winner: "Leicester Tigers",
    margin: 5,
  },
];

// ---- Write files ----
fs.writeFileSync(
  path.join(dataDir, "competitions.json"),
  JSON.stringify(competitions, null, 2)
);

fs.writeFileSync(
  path.join(dataDir, "matches.json"),
  JSON.stringify(matches, null, 2)
);

fs.writeFileSync(
  path.join(dataDir, "users.json"),
  JSON.stringify(users, null, 2)
);

fs.writeFileSync(
  path.join(dataDir, "predictions.json"),
  JSON.stringify(predictions, null, 2)
);

console.log("✅ JSON data initialized in /backend/data");