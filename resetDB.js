const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "data.json");

function resetDB() {
  const fresh = {
    matches: [],
    predictions: []
  };

  fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2));
  console.log("🗑️ Database reset complete. Fresh structure created:");
  console.log(fresh);
}

resetDB();
