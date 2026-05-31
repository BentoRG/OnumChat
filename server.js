const express = require("express");
const http = require("http");
const path = require("path");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

app.use(express.static(__dirname));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/messages", (_req, res) => {
  res.json(getAllMessages.all());
});

io.on("connection", (socket) => {
  socket.on("send-message", ({ name, text }) => {
    const trimmedName = name?.trim();
    const trimmedText = text?.trim();

    if (!trimmedName || !trimmedText) return;
    if (trimmedName.length > 50 || trimmedText.length > 1000) return;

    const timestamp = new Date().toISOString();
    const result = insertMessage.run(trimmedName, trimmedText, timestamp);

    const message = {
      id: result.lastInsertRowid,
      name: trimmedName,
      text: trimmedText,
      timestamp,
    };

    io.emit("new-message", message);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OnumChat rodando na porta ${PORT}`);
});
