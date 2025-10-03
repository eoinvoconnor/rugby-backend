// server.js
const express = require("express");
const fs = require("fs").promises;
const path = require("path");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");

const { updateResultsFromSources } = require("./utils/updateResultsFromSources");

const app = express();
const PORT = process.env.PORT || 10000;
const DATA_DIR = path.join(__dirname, "data");

const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

// Middleware
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// Helpers
async function readJSON(file) {
  const filePath = path.join(DATA_DIR, file);
  try {
    const data = await fs.readFile(filePath, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeJSON(file, data) {
  const filePath = path.join(DATA_DIR, file);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// ==================== USERS ====================

// Auto-register login endpoint
app.post("/api/users/login", async (req, res) => {
  const { email, firstname, surname } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  let users = await readJSON("users.json");
  let user = users.find((u) => u.email === email);

  if (!user) {
    user = {
      id: users.length ? Math.max(...users.map((u) => u.id)) + 1 : 1,
      email,
      firstname: firstname || "",
      surname: surname || "",
      isAdmin: email === "eoinvoconnor@gmail.com",
    };
    users.push(user);
    await writeJSON("users.json", users);
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, isAdmin: user.isAdmin },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token, user });
});

// Admin CRUD
app.get("/api/users", authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.sendStatus(403);
  const users = await readJSON("users.json");
  res.json(users);
});

app.put("/api/users/:id", authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.sendStatus(403);
  const users = await readJSON("users.json");
  const index = users.findIndex((u) => u.id == req.params.id);
  if (index === -1) return res.sendStatus(404);
  users[index] = { ...users[index], ...req.body };
  await writeJSON("users.json", users);
  res.json(users[index]);
});

app.delete("/api/users/:id", authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.sendStatus(403);
  let users = await readJSON("users.json");
  users = users.filter((u) => u.id != req.params.id);
  await writeJSON("users.json", users);
  res.json({ success: true });
});

// ==================== COMPETITIONS ====================
app.get("/api/competitions", async (req, res) => {
  const competitions = await readJSON("competitions.json");
  res.json(competitions);
});

app.post("/api/competitions", authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.sendStatus(403);
  let competitions = await readJSON("competitions.json");
  const newComp = { id: Date.now(), ...req.body };
  competitions.push(newComp);
  await writeJSON("competitions.json", competitions);
  res.json(newComp);
});

// ==================== MATCHES ====================
app.get("/api/matches", async (req, res) => {
  const matches = await readJSON("matches.json");
  res.json(matches);
});

// ==================== PREDICTIONS ====================
app.get("/api/predictions", authenticateToken, async (req, res) => {
  const predictions = await readJSON("predictions.json");
  res.json(predictions.filter((p) => p.userId === req.user.id));
});

app.post("/api/predictions", authenticateToken, async (req, res) => {
  let predictions = await readJSON("predictions.json");
  const newPredictions = req.body.map((pred) => ({
    ...pred,
    userId: req.user.id,
  }));
  predictions = predictions.filter(
    (p) =>
      !(p.userId === req.user.id &&
        newPredictions.some((np) => np.matchId === p.matchId))
  );
  predictions.push(...newPredictions);
  await writeJSON("predictions.json", predictions);
  res.json({ success: true });
});

// ==================== LEADERBOARD ====================
app.get("/api/leaderboard", async (req, res) => {
  const users = await readJSON("users.json");
  const predictions = await readJSON("predictions.json");
  const matches = await readJSON("matches.json");

  const leaderboard = users.map((user) => {
    const userPreds = predictions.filter((p) => p.userId === user.id);
    let points = 0;
    let correct = 0;

    userPreds.forEach((pred) => {
      const match = matches.find((m) => m.id === pred.matchId);
      if (match && match.result) {
        const winner =
          match.result.teamAScore > match.result.teamBScore
            ? match.teamA
            : match.teamB;
        if (pred.predictedWinner === winner) {
          points += 3;
          correct++;
        }
      }
    });

    return {
      userId: user.id,
      name: `${user.firstname} ${user.surname}`,
      points,
      accuracy: userPreds.length
        ? ((correct / userPreds.length) * 100).toFixed(1)
        : "0.0",
    };
  });

  leaderboard.sort((a, b) => b.points - a.points);
  res.json(leaderboard);
});

// ==================== CRON JOB ====================
cron.schedule("0 * * * *", async () => {
  console.log("Scheduled task: updating results...");
  try {
    await updateResultsFromSources();
  } catch (err) {
    console.error("❌ Results update failed:", err);
  }
});

// ==================== DEBUG + HEALTH ====================
app.get("/api/debug/files", async (req, res) => {
  const files = ["competitions.json", "matches.json", "predictions.json", "users.json"];
  const data = [];
  for (const file of files) {
    try {
      const stats = await fs.stat(path.join(DATA_DIR, file));
      const preview = (await fs.readFile(path.join(DATA_DIR, file), "utf8")).slice(0, 200);
      data.push({ file, size: stats.size, modified: stats.mtime, preview });
    } catch {
      data.push({ file, missing: true });
    }
  }
  res.json({ files: data });
});

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});