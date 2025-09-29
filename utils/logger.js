const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "admin.log");
const MAX_LOG_SIZE = 1 * 1024 * 1024; // 1MB

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR);
}

/**
 * Rotate the log file if it exceeds MAX_LOG_SIZE
 */
function rotateLog() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size >= MAX_LOG_SIZE) {
        const backupFile = path.join(LOG_DIR, "admin.log.bak");
        if (fs.existsSync(backupFile)) {
          fs.unlinkSync(backupFile); // delete old backup
        }
        fs.renameSync(LOG_FILE, backupFile); // rotate
      }
    }
  } catch (err) {
    console.error("❌ Log rotation failed:", err);
  }
}

/**
 * Append a log entry with timestamp and action
 * @param {string} action - Name of the action
 * @param {string} details - Summary/details of the action
 */
function logAdminAction(action, details = "") {
  rotateLog();

  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${action}] ${details}\n`;

  try {
    fs.appendFileSync(LOG_FILE, entry, "utf8");
  } catch (err) {
    console.error("❌ Failed to write log:", err);
  }
}

module.exports = {
  logAdminAction,
};
