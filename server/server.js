const express = require("express");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
const HEARTBEAT_TIMEOUT = 30000;
const CLEANUP_INTERVAL = 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "dashboard")));

const db = new Database(path.join(__dirname, "tracker.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    uuid TEXT,
    ip TEXT,
    mc_version TEXT DEFAULT 'unknown',
    mod_version TEXT DEFAULT 'unknown',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    status TEXT DEFAULT 'offline',
    offline_since TEXT,
    total_connections INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    uuid TEXT,
    ip TEXT,
    mc_session_token TEXT,
    mc_version TEXT DEFAULT 'unknown',
    mod_version TEXT DEFAULT 'unknown',
    connect_time TEXT NOT NULL,
    disconnect_time TEXT,
    duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_connect ON sessions(connect_time);
`);

const stmtUpsertUser = db.prepare(`
  INSERT INTO users (id, username, uuid, ip, mc_version, mod_version, first_seen, last_seen, status, total_connections)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'online', 1)
  ON CONFLICT(id) DO UPDATE SET
    username = excluded.username,
    uuid = COALESCE(excluded.uuid, users.uuid),
    ip = COALESCE(excluded.ip, users.ip),
    mc_version = excluded.mc_version,
    mod_version = excluded.mod_version,
    last_seen = excluded.last_seen,
    status = 'online',
    offline_since = NULL,
    total_connections = users.total_connections + 1
`);

const stmtUpdateUserOffline = db.prepare(`
  UPDATE users SET status = 'offline', offline_since = ? WHERE id = ?
`);

const stmtInsertSession = db.prepare(`
  INSERT INTO sessions (user_id, username, uuid, ip, mc_session_token, mc_version, mod_version, connect_time, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
`);

const stmtCloseSession = db.prepare(`
  UPDATE sessions SET disconnect_time = ?, duration = ?, status = 'closed'
  WHERE user_id = ? AND status = 'active'
`);

const stmtGetActiveSession = db.prepare(`
  SELECT id FROM sessions WHERE user_id = ? AND status = 'active' LIMIT 1
`);

const stmtGetAllUsers = db.prepare(`
  SELECT * FROM users ORDER BY
    CASE WHEN status = 'online' THEN 0 ELSE 1 END,
    last_seen DESC
`);

const stmtGetUser = db.prepare(`SELECT * FROM users WHERE id = ?`);

const stmtDeleteUser = db.prepare(`DELETE FROM users WHERE id = ?`);

const stmtDeleteUserSessions = db.prepare(`DELETE FROM sessions WHERE user_id = ?`);

const stmtGetSessions = db.prepare(`
  SELECT * FROM sessions ORDER BY connect_time DESC LIMIT ? OFFSET ?
`);

const stmtGetSessionsByUser = db.prepare(`
  SELECT * FROM sessions WHERE user_id = ? ORDER BY connect_time DESC LIMIT ? OFFSET ?
`);

const stmtCountSessions = db.prepare(`SELECT COUNT(*) as total FROM sessions`);

const stmtCountSessionsByUser = db.prepare(`SELECT COUNT(*) as total FROM sessions WHERE user_id = ?`);

function cleanupOfflineUsers() {
  const now = new Date().toISOString();
  const stale = db.prepare(`UPDATE users SET status = 'offline', offline_since = ? WHERE status = 'online' AND last_seen < ?`);
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT).toISOString();
  stale.run(now, cutoff);

  const staleSessions = db.prepare(`
    UPDATE sessions SET disconnect_time = ?, duration = CAST((julianday(?) - julianday(connect_time)) * 86400 AS INTEGER), status = 'closed'
    WHERE status = 'active' AND connect_time < ?
  `);
  staleSessions.run(now, now, cutoff);
}

setInterval(cleanupOfflineUsers, CLEANUP_INTERVAL);

app.get("/api/heartbeat", (req, res) => {
  const username = req.query.u;
  if (!username) return res.status(400).json({ error: "username is required" });
  const userId = username.toLowerCase();
  const now = new Date().toISOString();
  const realIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.ip;
  stmtUpsertUser.run(userId, username, null, realIp, "unknown", "unknown", now, now);

  const active = stmtGetActiveSession.get(userId);
  if (!active) {
    stmtInsertSession.run(userId, username, null, realIp, null, "unknown", "unknown", now);
  }

  console.log(`[Heartbeat] ${username} (GET)`);
  res.json({ status: "ok" });
});

app.post("/api/heartbeat", (req, res) => {
  const { username, uuid, modVersion, mcVersion, mcSessionToken } = req.body;
  if (!username) return res.status(400).json({ error: "username is required" });

  const userId = (uuid || username).toLowerCase();
  const now = new Date().toISOString();
  const realIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.ip;
  stmtUpsertUser.run(userId, username, uuid || null, realIp, mcVersion || "unknown", modVersion || "unknown", now, now);

  const active = stmtGetActiveSession.get(userId);
  if (!active) {
    stmtInsertSession.run(userId, username, uuid || null, realIp, mcSessionToken || null, mcVersion || "unknown", modVersion || "unknown", now);
  } else if (mcSessionToken) {
    db.prepare(`UPDATE sessions SET mc_session_token = ? WHERE id = ?`).run(mcSessionToken, active.id);
  }

  console.log(`[Heartbeat] ${username} / ${uuid || "no-uuid"} (POST)`);
  res.json({ success: true, status: "online", serverTime: now });
});

app.post("/api/disconnect", (req, res) => {
  const { username, uuid } = req.body;
  const userId = (uuid || username || "").toLowerCase();
  const now = new Date().toISOString();

  const user = stmtGetUser.get(userId);
  if (user) {
    stmtUpdateUserOffline.run(now, userId);
  }

  const active = stmtGetActiveSession.get(userId);
  if (active) {
    const session = db.prepare(`SELECT connect_time FROM sessions WHERE id = ?`).get(active.id);
    if (session) {
      const dur = Math.floor((Date.now() - new Date(session.connect_time).getTime()) / 1000);
      stmtCloseSession.run(now, dur, userId);
    }
  }

  res.json({ success: true });
});

app.get("/api/users", (req, res) => {
  cleanupOfflineUsers();
  const rows = stmtGetAllUsers.all();
  const onlineCount = rows.filter(u => u.status === "online").length;
  res.json({
    users: rows.map(u => ({
      id: u.id, username: u.username, uuid: u.uuid,
      modVersion: u.mod_version, mcVersion: u.mc_version,
      ip: u.ip, status: u.status,
      firstSeen: u.first_seen, lastSeen: u.last_seen,
      offlineSince: u.offline_since,
      totalConnections: u.total_connections
    })),
    stats: { online: onlineCount, total: rows.length, offline: rows.length - onlineCount }
  });
});

app.get("/api/user/:id", (req, res) => {
  cleanupOfflineUsers();
  const user = stmtGetUser.get(req.params.id.toLowerCase());
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({
    id: user.id, username: user.username, uuid: user.uuid,
    modVersion: user.mod_version, mcVersion: user.mc_version,
    ip: user.ip, status: user.status,
    firstSeen: user.first_seen, lastSeen: user.last_seen,
    offlineSince: user.offline_since,
    totalConnections: user.total_connections
  });
});

app.get("/api/sessions", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const sessions = stmtGetSessions.all(limit, offset);
  const total = stmtCountSessions.get().total;
  res.json({ sessions, total, limit, offset });
});

app.get("/api/user/:id/sessions", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const sessions = stmtGetSessionsByUser.all(req.params.id.toLowerCase(), limit, offset);
  const total = stmtCountSessionsByUser.get(req.params.id.toLowerCase()).total;
  res.json({ sessions, total, limit, offset });
});

app.get("/api/stats", (req, res) => {
  cleanupOfflineUsers();
  const allUsers = stmtGetAllUsers.all();
  const onlineUsers = allUsers.filter(u => u.status === "online");
  const modVersions = {};
  const mcVersions = {};
  allUsers.forEach(u => {
    modVersions[u.mod_version] = (modVersions[u.mod_version] || 0) + 1;
    mcVersions[u.mc_version] = (mcVersions[u.mc_version] || 0) + 1;
  });
  res.json({
    online: onlineUsers.length, total: allUsers.length,
    offline: allUsers.length - onlineUsers.length,
    modVersions, mcVersions, serverUptime: process.uptime()
  });
});

app.delete("/api/user/:id", (req, res) => {
  const userId = req.params.id.toLowerCase();
  stmtDeleteUserSessions.run(userId);
  stmtDeleteUser.run(userId);
  res.json({ success: true });
});

app.delete("/api/users", (req, res) => {
  db.exec(`DELETE FROM sessions; DELETE FROM users;`);
  res.json({ success: true, message: "All data cleared" });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "dashboard", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Tracker server running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/users`);
});
