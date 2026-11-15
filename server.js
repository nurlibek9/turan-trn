require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const DB_FILE = process.env.DATABASE_FILE || "./data/turan.sqlite";

fs.mkdirSync(path.dirname(path.resolve(DB_FILE)), { recursive: true });
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT 'Player',
  coins INTEGER NOT NULL DEFAULT 0,
  energy INTEGER NOT NULL DEFAULT 1000,
  max_energy INTEGER NOT NULL DEFAULT 1000,
  energy_updated INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  referred_by TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(referred_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS upgrades (
  user_id TEXT NOT NULL,
  upgrade_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, upgrade_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS claimed_tasks (
  user_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, task_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

const UPGRADE_CATALOG = [
  { id: "tap_power", name: "Сила касания", description: "+1 TRN за нажатие", baseCost: 100, growth: 1.55, maxLevel: 50 },
  { id: "energy", name: "Запас энергии", description: "+250 к максимальной энергии", baseCost: 250, growth: 1.7, maxLevel: 20 },
  { id: "recharge", name: "Быстрое восстановление", description: "Энергия восстанавливается быстрее", baseCost: 400, growth: 1.8, maxLevel: 20 },
  { id: "business", name: "Автоматический доход", description: "+10 TRN в час за уровень", baseCost: 500, growth: 1.65, maxLevel: 50 }
];

const TASKS = [
  { id: "daily_login", title: "Зайти в TURAN", description: "Ежедневная награда за вход", reward: 100, kind: "daily" },
  { id: "first_clicks", title: "Начать игру", description: "Забери награду новичка", reward: 250, kind: "once" },
  { id: "invite_friend", title: "Пригласи друга", description: "Пригласи одного игрока по своей ссылке", reward: 500, kind: "referral" }
];

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false });
app.use("/api", apiLimiter);

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN_NOT_CONFIGURED");
  const params = new URLSearchParams(initData || "");
  const hash = params.get("hash");
  if (!hash) throw new Error("MISSING_HASH");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const a = Buffer.from(calculated, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("BAD_SIGNATURE");

  const authDate = Number(params.get("auth_date") || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > 86400 || authDate > now + 60) throw new Error("EXPIRED_INIT_DATA");

  const userRaw = params.get("user");
  if (!userRaw) throw new Error("MISSING_USER");
  return { user: JSON.parse(userRaw), startParam: params.get("start_param") || "" };
}

function getUser(req, res, next) {
  try {
    const initData = req.headers["x-telegram-init-data"] || "";
    let telegramUser, startParam = "";

    if (process.env.NODE_ENV !== "production" && req.headers["x-dev-user"] === "1") {
      telegramUser = { id: "dev-10001", first_name: "Turan Player", username: "turan_demo" };
    } else {
      const verified = verifyTelegramInitData(initData);
      telegramUser = verified.user;
      startParam = verified.startParam;
    }

    const id = String(telegramUser.id);
    const now = Math.floor(Date.now() / 1000);
    const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);

    if (!existing) {
      let referrer = null;
      if (startParam.startsWith("ref_")) {
        const candidate = startParam.slice(4);
        if (candidate !== id && db.prepare("SELECT id FROM users WHERE id = ?").get(candidate)) referrer = candidate;
      }
      db.prepare(`
        INSERT INTO users (id, username, first_name, coins, energy, max_energy, energy_updated, last_seen, referred_by, created_at)
        VALUES (?, ?, ?, 500, 1000, 1000, ?, ?, ?, ?)
      `).run(id, telegramUser.username || null, telegramUser.first_name || "Player", now, now, referrer, now);
    } else {
      db.prepare("UPDATE users SET username = ?, first_name = ?, last_seen = ? WHERE id = ?")
        .run(telegramUser.username || null, telegramUser.first_name || "Player", now, id);
    }

    req.userId = id;
    next();
  } catch (err) {
    const message = err.message === "BOT_TOKEN_NOT_CONFIGURED"
      ? "Сервер ещё не настроен: добавьте BOT_TOKEN в .env."
      : "Не удалось проверить Telegram. Откройте игру через Telegram-бота.";
    res.status(401).json({ error: message });
  }
}

function upgradeLevels(userId) {
  const rows = db.prepare("SELECT upgrade_id, level FROM upgrades WHERE user_id = ?").all(userId);
  return Object.fromEntries(rows.map(r => [r.upgrade_id, r.level]));
}

function incomePerHour(levels) {
  return (levels.business || 0) * 10;
}

function syncUser(userId) {
  const now = Math.floor(Date.now() / 1000);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const levels = upgradeLevels(userId);

  const maxEnergy = 1000 + (levels.energy || 0) * 250;
  const rechargeSeconds = Math.max(1, 3 - (levels.recharge || 0) * 0.1);
  const elapsed = Math.max(0, now - user.energy_updated);
  const restored = Math.floor(elapsed / rechargeSeconds);
  const energy = Math.min(maxEnergy, user.energy + restored);
  const passive = Math.floor((incomePerHour(levels) * Math.max(0, now - user.last_seen)) / 3600);

  db.prepare(`
    UPDATE users SET energy = ?, max_energy = ?, energy_updated = ?, coins = coins + ?, last_seen = ?
    WHERE id = ?
  `).run(energy, maxEnergy, now, passive, now, userId);

  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

function profile(userId) {
  const user = syncUser(userId);
  const levels = upgradeLevels(userId);
  const referralCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE referred_by = ?").get(userId).n;
  const claimed = db.prepare("SELECT task_id FROM claimed_tasks WHERE user_id = ?").all(userId).map(x => x.task_id);
  const todayKey = `daily_login_${new Date().toISOString().slice(0, 10)}`;
  const upgrades = UPGRADE_CATALOG.map(item => ({
    ...item,
    level: levels[item.id] || 0,
    cost: Math.floor(item.baseCost * Math.pow(item.growth, levels[item.id] || 0))
  }));
  return {
    id: user.id,
    firstName: user.first_name,
    username: user.username,
    coins: user.coins,
    energy: user.energy,
    maxEnergy: user.max_energy,
    tapPower: 1 + (levels.tap_power || 0),
    incomePerHour: incomePerHour(levels),
    levels,
    upgrades,
    tasks: TASKS.map(t => ({
      ...t,
      claimed: claimed.includes(t.id) || (t.kind === "daily" && claimed.includes(todayKey)),
      claimKey: t.kind === "daily" ? todayKey : t.id,
      available: t.kind === "referral" ? referralCount >= 1 : true
    })),
    referralCount,
    referralCode: `ref_${user.id}`
  };
}

app.get("/api/me", getUser, (req, res) => res.json(profile(req.userId)));

app.post("/api/click", getUser, (req, res) => {
  const count = Math.max(1, Math.min(10, Math.floor(Number(req.body.count) || 1)));
  const result = db.transaction(() => {
    const user = syncUser(req.userId);
    if (user.energy < count) return { error: "Недостаточно энергии" };
    const levels = upgradeLevels(req.userId);
    const reward = count * (1 + (levels.tap_power || 0));
    db.prepare("UPDATE users SET coins = coins + ?, energy = energy - ? WHERE id = ?")
      .run(reward, count, req.userId);
    return { reward };
  })();
  if (result.error) return res.status(400).json(result);
  res.json({ ...result, ...profile(req.userId) });
});

app.post("/api/buy", getUser, (req, res) => {
  const item = UPGRADE_CATALOG.find(x => x.id === req.body.upgradeId);
  if (!item) return res.status(400).json({ error: "Неизвестное улучшение" });

  const result = db.transaction(() => {
    const user = syncUser(req.userId);
    const row = db.prepare("SELECT level FROM upgrades WHERE user_id = ? AND upgrade_id = ?").get(req.userId, item.id);
    const level = row ? row.level : 0;
    if (level >= item.maxLevel) return { error: "Достигнут максимальный уровень" };
    const cost = Math.floor(item.baseCost * Math.pow(item.growth, level));
    if (user.coins < cost) return { error: "Недостаточно TRN" };

    db.prepare("UPDATE users SET coins = coins - ? WHERE id = ?").run(cost, req.userId);
    db.prepare(`
      INSERT INTO upgrades (user_id, upgrade_id, level) VALUES (?, ?, 1)
      ON CONFLICT(user_id, upgrade_id) DO UPDATE SET level = level + 1
    `).run(req.userId, item.id);
    return { success: true };
  })();

  if (result.error) return res.status(400).json(result);
  res.json(profile(req.userId));
});

app.post("/api/claim-task", getUser, (req, res) => {
  const task = TASKS.find(t => t.id === req.body.taskId);
  if (!task) return res.status(400).json({ error: "Задание не найдено" });

  const claimKey = task.kind === "daily"
    ? `daily_login_${new Date().toISOString().slice(0, 10)}`
    : task.id;
  const result = db.transaction(() => {
    const already = db.prepare("SELECT 1 FROM claimed_tasks WHERE user_id = ? AND task_id = ?").get(req.userId, claimKey);
    if (already) return { error: "Награда уже получена" };
    if (task.kind === "referral") {
      const n = db.prepare("SELECT COUNT(*) AS n FROM users WHERE referred_by = ?").get(req.userId).n;
      if (n < 1) return { error: "Сначала пригласите друга" };
    }
    db.prepare("INSERT INTO claimed_tasks (user_id, task_id, claimed_at) VALUES (?, ?, ?)").run(req.userId, claimKey, Math.floor(Date.now()/1000));
    db.prepare("UPDATE users SET coins = coins + ? WHERE id = ?").run(task.reward, req.userId);
    return { success: true };
  })();

  if (result.error) return res.status(400).json(result);
  res.json(profile(req.userId));
});

app.get("/api/leaderboard", getUser, (req, res) => {
  const rows = db.prepare(`
    SELECT first_name AS name, coins
    FROM users ORDER BY coins DESC LIMIT 20
  `).all();
  res.json(rows);
});

app.get("/health", (_req, res) => res.json({ ok: true, app: "TURAN TRN" }));

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`TURAN Mini App is running on http://localhost:${PORT}`);
  if (!BOT_TOKEN) console.warn("BOT_TOKEN is empty. Use local demo mode or configure Telegram bot token.");
});