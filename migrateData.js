const fs = require("fs");
const path = require("path");

const OLD_FILE = path.join(__dirname, "data.json");
const DATA_DIR = path.join(__dirname, "data");

const matchesFile = path.join(DATA_DIR, "matches.json");
const predictionsFile = path.join(DATA_DIR, "predictions.json");
const usersFile = path.join(DATA_DIR, "users.json");
const metaFile = path.join(DATA_DIR, "meta.json");

function migrate() {
  if (!fs.existsSync(OLD_FILE)) {
    console.log("⚠️ No old data.json found, skipping migration.");
    return;
  }

  const oldData = JSON.parse(fs.readFileSync(OLD_FILE));

  // Extract matches + predictions, fallback to empty
  const matches = Array.isArray(oldData.matches) ? oldData.matches : [];
  const predictions = Array.isArray(oldData.predictions) ? oldData.predictions : [];

  // Save new structure
  fs.writeFileSync(matchesFile, JSON.stringify(matches, null, 2));
  fs.writeFileSync(predictionsFile, JSON.stringify(predictions, null, 2));

  // Users we don’t have yet → keep empty, ready for future login
  fs.writeFileSync(usersFile, JSON.stringify([], null, 2));

  // Meta data
  fs.writeFileSync(metaFile, JSON.stringify({ lastUpdate: new Date().toISOString() }, null, 2));

  console.log("✅ Migration complete!");
  console.log(`📄 Matches: ${matches.length}, Predictions: ${predictions.length}`);
}

migrate();
