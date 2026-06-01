const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["polling", "websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

const db = new Database(path.join(__dirname, "messages.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    reply_to_id INTEGER REFERENCES messages(id),
    kind TEXT NOT NULL DEFAULT 'user'
  );
`);

const columns = db.prepare("PRAGMA table_info(messages)").all();
if (!columns.some((column) => column.name === "reply_to_id")) {
  db.exec("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id)");
}
if (!columns.some((column) => column.name === "kind")) {
  db.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
`);

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "onumchat_session";

const findUserByUsername = db.prepare(
  "SELECT id, username, password_hash, password_salt FROM users WHERE username = ? COLLATE NOCASE"
);

const insertUser = db.prepare(
  "INSERT INTO users (username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)"
);

const getUserById = db.prepare(
  "SELECT id, username FROM users WHERE id = ?"
);

const insertSession = db.prepare(
  "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
);

const getSession = db.prepare(`
  SELECT s.token, s.expires_at, u.id AS user_id, u.username
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token = ?
`);

const deleteSession = db.prepare("DELETE FROM sessions WHERE token = ?");

const deleteExpiredSessions = db.prepare(
  "DELETE FROM sessions WHERE expires_at <= ?"
);

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || "";

  header.split(";").forEach((part) => {
    const trimmed = part.trim();
    if (!trimmed) return;

    const separator = trimmed.indexOf("=");
    if (separator === -1) return;

    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const check = hashPassword(password, salt).hash;
  return crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(check, "hex")
  );
}

function validateUsername(username) {
  const trimmed = username?.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 50) {
    return null;
  }
  return trimmed;
}

function validatePassword(password) {
  if (!password || password.length < 4 || password.length > 128) {
    return false;
  }
  return true;
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

function getSessionUser(req) {
  deleteExpiredSessions.run(new Date().toISOString());

  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;

  const session = getSession.get(token);
  if (!session) return null;

  if (new Date(session.expires_at) <= new Date()) {
    deleteSession.run(token);
    return null;
  }

  return {
    id: session.user_id,
    username: session.username,
  };
}

const ONLINE_TIMEOUT_MS = 30_000;
const onlinePresence = new Map();

function touchPresence(username) {
  if (!username) return;
  onlinePresence.set(username.toLowerCase(), {
    username,
    lastSeen: Date.now(),
  });
}

function getOnlineUsers() {
  const now = Date.now();
  const online = [];

  for (const [key, entry] of onlinePresence) {
    if (now - entry.lastSeen <= ONLINE_TIMEOUT_MS) {
      online.push(entry.username);
    } else {
      onlinePresence.delete(key);
    }
  }

  return online;
}

function attachSession(req, _res, next) {
  req.user = getSessionUser(req);
  if (req.user) touchPresence(req.user.username);
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Faça login para continuar." });
    return;
  }
  next();
}

function createSessionForUser(res, userId) {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
  insertSession.run(token, userId, expiresAt);
  setSessionCookie(res, token);
  return getUserById.get(userId);
}

const insertMessage = db.prepare(
  "INSERT INTO messages (name, text, timestamp, reply_to_id, kind) VALUES (?, ?, ?, ?, ?)"
);

const getMessageById = db.prepare(
  "SELECT id, name, text, timestamp, reply_to_id, kind FROM messages WHERE id = ?"
);

const getAllMessages = db.prepare(`
  SELECT
    m.id,
    m.name,
    m.text,
    m.timestamp,
    m.reply_to_id,
    m.kind,
    r.name AS reply_to_name,
    r.text AS reply_to_text
  FROM messages m
  LEFT JOIN messages r ON r.id = m.reply_to_id
  ORDER BY m.id ASC
`);

app.use(express.static(__dirname, {
  setHeaders(res, filePath) {
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  },
}));
app.use(express.json());
app.use(attachSession);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

function formatMessage(row) {
  const message = {
    id: row.id,
    name: row.name,
    text: row.text,
    timestamp: row.timestamp,
    kind: row.kind || "user",
    replyTo: null,
  };

  if (row.reply_to_id && row.reply_to_name) {
    message.replyTo = {
      id: row.reply_to_id,
      name: row.reply_to_name,
      text: row.reply_to_text,
    };
  }

  return message;
}

const LEADERBOARD_EXCLUDED = new Set(["hipoo", "A"]);

function getAllFormattedMessages() {
  return getAllMessages.all().map(formatMessage);
}

function computeUserStats(messages) {
  const eligibleMessages = messages.filter(
    (message) =>
      message.kind !== "aura" && !LEADERBOARD_EXCLUDED.has(message.name)
  );
  const stats = {};
  let previousName = null;

  for (const message of eligibleMessages) {
    if (previousName === null || message.name !== previousName) {
      const count = (stats[message.name]?.count || 0) + 1;
      stats[message.name] = {
        count,
        reachedAt: message.timestamp,
      };
    }
    previousName = message.name;
  }

  return stats;
}

function isAuraMilestone(count) {
  return count >= 67 && count % 100 === 67;
}

function getUserQualifyingCount(username) {
  const stats = computeUserStats(getAllFormattedMessages());
  return stats[username]?.count || 0;
}

function createAuraMessage(text) {
  const timestamp = new Date().toISOString();
  const result = insertMessage.run("OnumChat", text, timestamp, null, "aura");
  const saved = getMessageById.get(result.lastInsertRowid);
  return formatMessage(saved);
}

function maybeAnnounceAura(username) {
  if (LEADERBOARD_EXCLUDED.has(username)) return null;

  const count = getUserQualifyingCount(username);
  if (!isAuraMilestone(count)) return null;

  const auraMessage = createAuraMessage(`${username} chegou a ${count}. Aura.`);
  broadcastMessage(auraMessage);
  return auraMessage;
}

function createMessage(name, text, replyToId) {
  const trimmedName = name?.trim();
  const trimmedText = text?.trim();

  if (!trimmedName || !trimmedText) return null;
  if (trimmedName.length > 50 || trimmedText.length > 1000) return null;

  let replyId = null;
  if (replyToId !== undefined && replyToId !== null && replyToId !== "") {
    replyId = Number.parseInt(replyToId, 10);
    if (!replyId || !getMessageById.get(replyId)) return null;
  }

  const timestamp = new Date().toISOString();
  const result = insertMessage.run(trimmedName, trimmedText, timestamp, replyId, "user");

  const saved = getMessageById.get(result.lastInsertRowid);
  const message = formatMessage({
    ...saved,
    reply_to_name: replyId ? getMessageById.get(replyId)?.name : null,
    reply_to_text: replyId ? getMessageById.get(replyId)?.text : null,
  });

  maybeAnnounceAura(trimmedName);
  return message;
}

function broadcastMessage(message) {
  io.emit("new-message", message);
}

function buildLeaderboardFromStats(stats) {
  return Object.entries(stats)
    .map(([name, { count, reachedAt }]) => ({ name, count, reachedAt }))
    .sort(
      (a, b) => b.count - a.count || a.reachedAt.localeCompare(b.reachedAt)
    )
    .map((entry, index) => ({
      name: entry.name,
      count: entry.count,
      stars: Math.floor(entry.count / 100),
      rank: index + 1,
    }));
}

function buildUserStars(stats) {
  return Object.fromEntries(
    Object.entries(stats).map(([name, { count }]) => [
      name,
      Math.floor(count / 100),
    ])
  );
}

function getTopRanks(leaderboard) {
  return {
    gold: leaderboard[0]?.name || null,
    silver: leaderboard[1]?.name || null,
    bronze: leaderboard[2]?.name || null,
  };
}

app.get("/api/messages", (_req, res) => {
  res.json(getAllFormattedMessages());
});

app.get("/api/leaderboard", (_req, res) => {
  const messages = getAllFormattedMessages();
  const stats = computeUserStats(messages);
  const leaderboard = buildLeaderboardFromStats(stats);

  res.json({
    leaderboard,
    topRanks: getTopRanks(leaderboard),
    userStars: buildUserStars(stats),
    onlineUsers: getOnlineUsers(),
  });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: "Não autenticado." });
    return;
  }

  res.json({ username: req.user.username });
});

app.post("/api/auth/register", (req, res) => {
  const username = validateUsername(req.body?.username);
  const password = req.body?.password;

  if (!username) {
    res.status(400).json({ error: "Nome de usuário inválido (2 a 50 caracteres)." });
    return;
  }

  if (!validatePassword(password)) {
    res.status(400).json({ error: "Senha inválida (4 a 128 caracteres)." });
    return;
  }

  if (findUserByUsername.get(username)) {
    res.status(409).json({ error: "Este nome de usuário já existe." });
    return;
  }

  const { hash, salt } = hashPassword(password);
  const createdAt = new Date().toISOString();

  try {
    const result = insertUser.run(username, hash, salt, createdAt);
    const user = createSessionForUser(res, result.lastInsertRowid);
    res.status(201).json({ username: user.username });
  } catch (_error) {
    res.status(409).json({ error: "Este nome de usuário já existe." });
  }
});

app.post("/api/auth/login", (req, res) => {
  const username = validateUsername(req.body?.username);
  const password = req.body?.password;

  if (!username || !validatePassword(password)) {
    res.status(400).json({ error: "Usuário ou senha inválidos." });
    return;
  }

  const user = findUserByUsername.get(username);
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    res.status(401).json({ error: "Usuário ou senha incorretos." });
    return;
  }

  const loggedIn = createSessionForUser(res, user.id);
  res.json({ username: loggedIn.username });
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) deleteSession.run(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/messages", requireAuth, (req, res) => {
  const message = createMessage(
    req.user.username,
    req.body?.text,
    req.body?.replyToId
  );

  if (!message) {
    res.status(400).json({ error: "Mensagem ou resposta inválidos." });
    return;
  }

  broadcastMessage(message);
  res.status(201).json(message);
});

io.on("connection", (socket) => {
  socket.on("send-message", () => {
    // Envio de mensagens exige login via REST.
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OnumChat rodando na porta ${PORT}`);
});
