import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_ORIGIN = process.env.APP_ORIGIN || '*';
const CRON_INTERVAL_MS = Math.max(10000, Number(process.env.CRON_INTERVAL_MS || 60000));
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'offline-active-reply.db');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS device_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT,
  auth TEXT,
  subscription_json TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, device_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  name TEXT,
  persona_prompt TEXT,
  active_reply_enabled INTEGER NOT NULL DEFAULT 0,
  active_reply_interval_sec INTEGER NOT NULL DEFAULT 60,
  active_reply_start_time INTEGER DEFAULT 0,
  last_triggered_msg_id TEXT,
  last_triggered_at INTEGER DEFAULT 0,
  last_seen_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, contact_id)
);

CREATE TABLE IF NOT EXISTS message_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  message_id TEXT,
  role TEXT,
  content TEXT,
  type TEXT,
  time INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, contact_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  description TEXT,
  time INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'offline-backend'
);

CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(user_id, time);
`);

app.use(cors({ origin: APP_ORIGIN === '*' ? true : APP_ORIGIN, credentials: false }));
app.use(express.json({ limit: '1mb' }));

function buildActiveReplyPrompt(lastMessage, minutesPassed) {
    if (lastMessage && lastMessage.role === 'user') {
        return `（系统提示：主动发消息模式触发。距离用户上一条消息已过去 ${minutesPassed} 分钟。请在不打断人设的前提下自然接住对方刚才的话；可以轻描淡写解释回复稍晚，也可以直接顺着话题继续。）`;
    }
    return `（系统提示：主动发消息模式触发。距离你上一条消息已过去 ${minutesPassed} 分钟，用户一直没有回复。请像真人间隔一阵后自然续聊：可以补一句、换个轻话题，或分享当下状态/见闻；不要写成系统通知或任务播报。）`;
}

function fallbackMessage(contactName, lastMessage) {
    if (lastMessage && lastMessage.role === 'user') {
        return `刚刚在忙，现在看到啦。${contactName ? `${contactName}想接着聊聊，` : ''}我在想你刚才那句。`;
    }
    return `${contactName || '对方'}隔了一会儿又来找你：我突然想到一件事，想继续和你说。`;
}

const upsertContactStmt = db.prepare(`
INSERT INTO contacts (user_id, contact_id, name, persona_prompt, active_reply_enabled, active_reply_interval_sec, active_reply_start_time, last_triggered_msg_id, created_at, updated_at)
VALUES (@user_id, @contact_id, @name, @persona_prompt, @active_reply_enabled, @active_reply_interval_sec, @active_reply_start_time, @last_triggered_msg_id, @created_at, @updated_at)
ON CONFLICT(user_id, contact_id) DO UPDATE SET
  name=excluded.name,
  persona_prompt=excluded.persona_prompt,
  active_reply_enabled=excluded.active_reply_enabled,
  active_reply_interval_sec=excluded.active_reply_interval_sec,
  active_reply_start_time=excluded.active_reply_start_time,
  last_triggered_msg_id=excluded.last_triggered_msg_id,
  updated_at=excluded.updated_at
`);

const upsertSnapshotStmt = db.prepare(`
INSERT INTO message_snapshots (user_id, contact_id, message_id, role, content, type, time, updated_at)
VALUES (@user_id, @contact_id, @message_id, @role, @content, @type, @time, @updated_at)
ON CONFLICT(user_id, contact_id) DO UPDATE SET
  message_id=excluded.message_id,
  role=excluded.role,
  content=excluded.content,
  type=excluded.type,
  time=excluded.time,
  updated_at=excluded.updated_at
`);

const upsertSubscriptionStmt = db.prepare(`
INSERT INTO device_subscriptions (user_id, device_id, endpoint, p256dh, auth, subscription_json, user_agent, created_at, updated_at)
VALUES (@user_id, @device_id, @endpoint, @p256dh, @auth, @subscription_json, @user_agent, @created_at, @updated_at)
ON CONFLICT(user_id, device_id) DO UPDATE SET
  endpoint=excluded.endpoint,
  p256dh=excluded.p256dh,
  auth=excluded.auth,
  subscription_json=excluded.subscription_json,
  user_agent=excluded.user_agent,
  updated_at=excluded.updated_at
`);

const insertMessageStmt = db.prepare(`
INSERT OR IGNORE INTO messages (id, user_id, contact_id, role, content, type, description, time, read, source)
VALUES (@id, @user_id, @contact_id, @role, @content, @type, @description, @time, @read, @source)
`);

const updateTriggerStateStmt = db.prepare(`
UPDATE contacts
SET last_triggered_msg_id = ?, last_triggered_at = ?, last_seen_message_id = ?, updated_at = ?
WHERE user_id = ? AND contact_id = ?
`);

function runActiveReplyCheck() {
    const rows = db.prepare(`
        SELECT c.user_id, c.contact_id, c.name, c.active_reply_enabled, c.active_reply_interval_sec, c.active_reply_start_time, c.last_triggered_msg_id,
               s.message_id, s.role, s.content, s.type, s.time
        FROM contacts c
        LEFT JOIN message_snapshots s ON s.user_id = c.user_id AND s.contact_id = c.contact_id
        WHERE c.active_reply_enabled = 1
    `).all();

    const now = Date.now();
    let triggered = 0;

    for (const row of rows) {
        if (!row.message_id) continue;
        if (Number(row.active_reply_start_time || 0) && Number(row.time || 0) <= Number(row.active_reply_start_time || 0)) continue;
        if (row.last_triggered_msg_id && row.last_triggered_msg_id === row.message_id) continue;
        if (now - Number(row.time || 0) < Number(row.active_reply_interval_sec || 60) * 1000) continue;

        const minutesPassed = Math.max(1, Math.floor((now - Number(row.time || now)) / 60000));
        const prompt = buildActiveReplyPrompt(row, minutesPassed);
        const content = fallbackMessage(row.name || '对方', row);
        const messageId = `offline-${row.user_id}-${row.contact_id}-${row.message_id}`;

        insertMessageStmt.run({
            id: messageId,
            user_id: row.user_id,
            contact_id: String(row.contact_id),
            role: 'assistant',
            content,
            type: 'text',
            description: prompt,
            time: now,
            read: 0,
            source: 'offline-backend'
        });

        updateTriggerStateStmt.run(messageId, now, row.message_id, now, row.user_id, String(row.contact_id));
        triggered += 1;
    }

    return triggered;
}

app.get('/health', (req, res) => {
    res.json({ ok: true, now: Date.now() });
});

app.post('/api/push/subscribe', (req, res) => {
    const body = req.body || {};
    const subscription = body.subscription || {};
    const keys = subscription.keys || {};
    const now = Date.now();
    upsertSubscriptionStmt.run({
        user_id: body.userId || 'default-user',
        device_id: body.deviceId || 'default-device',
        endpoint: subscription.endpoint || '',
        p256dh: keys.p256dh || '',
        auth: keys.auth || '',
        subscription_json: JSON.stringify(subscription),
        user_agent: body.userAgent || '',
        created_at: now,
        updated_at: now
    });
    res.json({ ok: true });
});

app.post('/api/contacts', (req, res) => {
    const body = req.body || {};
    const now = Date.now();
    upsertContactStmt.run({
        user_id: body.userId || 'default-user',
        contact_id: String(body.contactId),
        name: body.name || '',
        persona_prompt: body.personaPrompt || '',
        active_reply_enabled: body.activeReplyEnabled ? 1 : 0,
        active_reply_interval_sec: Math.max(1, Math.round(Number(body.activeReplyInterval || 1) * 60)),
        active_reply_start_time: Number(body.activeReplyStartTime || 0),
        last_triggered_msg_id: body.lastActiveReplyTriggeredMsgId || null,
        created_at: now,
        updated_at: now
    });
    res.json({ ok: true });
});

app.get('/api/contacts/active-reply-config', (req, res) => {
    const userId = req.query.userId || 'default-user';
    const contacts = db.prepare(`SELECT * FROM contacts WHERE user_id = ?`).all(userId);
    res.json({ contacts, serverTime: Date.now() });
});

app.post('/api/messages/snapshot', (req, res) => {
    const body = req.body || {};
    const lastMessage = body.lastMessage || {};
    upsertSnapshotStmt.run({
        user_id: body.userId || 'default-user',
        contact_id: String(body.contactId),
        message_id: lastMessage.id || null,
        role: lastMessage.role || 'assistant',
        content: lastMessage.content || '',
        type: lastMessage.type || 'text',
        time: Number(lastMessage.time || Date.now()),
        updated_at: Date.now()
    });
    res.json({ ok: true });
});

app.post('/api/messages/sync', (req, res) => {
    const body = req.body || {};
    const userId = body.userId || 'default-user';
    const since = Number(body.since || 0);
    const messages = db.prepare(`SELECT * FROM messages WHERE user_id = ? AND time > ? ORDER BY time ASC`).all(userId, since);
    res.json({ messages, serverTime: Date.now() });
});

app.post('/api/messages/mark-read', (req, res) => {
    const body = req.body || {};
    const ids = Array.isArray(body.messageIds) ? body.messageIds : [];
    if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`UPDATE messages SET read = 1 WHERE user_id = ? AND id IN (${placeholders})`).run(body.userId || 'default-user', ...ids);
    }
    res.json({ ok: true });
});

app.post('/api/debug/trigger-active-reply', (req, res) => {
    const body = req.body || {};
    const row = db.prepare(`
        SELECT c.user_id, c.contact_id, c.name, c.active_reply_enabled, c.active_reply_interval_sec, c.active_reply_start_time, c.last_triggered_msg_id,
               s.message_id, s.role, s.content, s.type, s.time
        FROM contacts c
        LEFT JOIN message_snapshots s ON s.user_id = c.user_id AND s.contact_id = c.contact_id
        WHERE c.user_id = ? AND c.contact_id = ?
    `).get(body.userId || 'default-user', String(body.contactId));

    if (!row || !row.message_id) {
        return res.status(404).json({ ok: false, error: 'contact or snapshot not found' });
    }

    const now = Date.now();
    const minutesPassed = Math.max(1, Math.floor((now - Number(row.time || now)) / 60000));
    const prompt = buildActiveReplyPrompt(row, minutesPassed);
    const content = fallbackMessage(row.name || '对方', row);
    const messageId = `offline-${row.user_id}-${row.contact_id}-${row.message_id}-${now}`;
    insertMessageStmt.run({
        id: messageId,
        user_id: row.user_id,
        contact_id: String(row.contact_id),
        role: 'assistant',
        content,
        type: 'text',
        description: prompt,
        time: now,
        read: 0,
        source: 'offline-backend'
    });
    updateTriggerStateStmt.run(messageId, now, row.message_id, now, row.user_id, String(row.contact_id));
    res.json({ ok: true, message: { id: messageId, contactId: row.contact_id, content, time: now }, serverTime: now });
});

setInterval(() => {
    try {
        const triggered = runActiveReplyCheck();
        if (triggered > 0) {
            console.log(`[active-reply-cron] triggered ${triggered} message(s)`);
        }
    } catch (err) {
        console.error('[active-reply-cron] failed', err);
    }
}, CRON_INTERVAL_MS);

app.listen(PORT, () => {
    console.log(`offline-active-reply server listening on :${PORT}`);
    console.log(`db path: ${DB_PATH}`);
});
