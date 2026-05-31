const express = require("express");
const http = require("http");
const path = require("path");
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
    timestamp TEXT NOT NULL
  )
`);

const insertMessage = db.prepare(
  "INSERT INTO messages (name, text, timestamp) VALUES (?, ?, ?)"
);

const getAllMessages = db.prepare(
  "SELECT id, name, text, timestamp FROM messages ORDER BY id ASC"
);

app.use(express.static(__dirname, {
  setHeaders(res, filePath) {
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  },
}));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

function createMessage(name, text) {
  const trimmedName = name?.trim();
  const trimmedText = text?.trim();

  if (!trimmedName || !trimmedText) return null;
  if (trimmedName.length > 50 || trimmedText.length > 1000) return null;

  const timestamp = new Date().toISOString();
  const result = insertMessage.run(trimmedName, trimmedText, timestamp);

  return {
    id: result.lastInsertRowid,
    name: trimmedName,
    text: trimmedText,
    timestamp,
  };
}

function broadcastMessage(message) {
  io.emit("new-message", message);
}

app.get("/api/messages", (_req, res) => {
  res.json(getAllMessages.all());
});

app.post("/api/messages", (req, res) => {
  const message = createMessage(req.body?.name, req.body?.text);

  if (!message) {
    res.status(400).json({ error: "Nome e mensagem são obrigatórios." });
    return;
  }

  broadcastMessage(message);
  res.status(201).json(message);
});

io.on("connection", (socket) => {
  socket.on("send-message", ({ name, text }) => {
    const message = createMessage(name, text);
    if (message) broadcastMessage(message);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OnumChat rodando na porta ${PORT}`);
});
