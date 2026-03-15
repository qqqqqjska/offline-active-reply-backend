import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import webpush from 'web-push';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_ORIGIN = process.env.APP_ORIGIN || '*';
const CRON_INTERVAL_MS = Math.max(10000, Number(process.env.CRON_INTERVAL_MS || 60000));
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'offline-active-reply.db');
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:you@example.com';
const PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (PUSH_ENABLED) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
    console.warn('[push] disabled: VAPID env vars are incomplete');
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
        return `Active reply triggered ${minutesPassed} minute(s) after the user's last message. Reply naturally and stay in persona.`;
    }
    return `Active reply triggered ${minutesPassed} minute(s) after silence. Continue the conversation naturally and stay in persona.`;
}

function fallbackMessage(contactName, lastMessage) {
    const name = contactName || 'They';
    if (lastMessage && lastMessage.role === 'user') {
        return `Just saw your last message. ${name} wanted to reply and keep chatting.`;
    }
    return `${name} came back after a short pause and wanted to continue the conversation.`;
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

const deleteSubscriptionByEndpointStmt = db.prepare(`DELETE FROM device_subscriptions WHERE endpoint = ?`);
const listSubscriptionsByUserStmt = db.prepare(`SELECT subscription_json, endpoint FROM device_subscriptions WHERE user_id = ?`);

function getSubscriptionsByUser(userId) {
    return listSubscriptionsByUserStmt.all(userId).map((row) => {
        try {
            return {
                endpoint: row.endpoint,
                subscription: JSON.parse(row.subscription_json)
            };
        } catch (err) {
            return null;
        }
    }).filter(Boolean);
}

async function sendPushToUser(userId, payload) {
    if (!PUSH_ENABLED) {
        return { enabled: false, delivered: 0, removed: 0 };
    }

    const subscriptions = getSubscriptionsByUser(userId);
    let delivered = 0;
    let removed = 0;

    for (const item of subscriptions) {
        try {
            await webpush.sendNotification(item.subscription, JSON.stringify(payload));
            delivered += 1;
        } catch (err) {
            const statusCode = Number(err && err.statusCode);
            console.error('[push] send failed', statusCode || '', item.endpoint, err && err.message ? err.message : err);
            if (statusCode === 404 || statusCode === 410) {
                try {
                    deleteSubscriptionByEndpointStmt.run(item.endpoint);
                    removed += 1;
                } catch (deleteErr) {
                    console.error('[push] failed to delete expired subscription', deleteErr);
                }
            }
        }
    }

    return { enabled: true, delivered, removed };
}

async function createOfflineMessage(row, now) {
    const minutesPassed = Math.max(1, Math.floor((now - Number(row.time || now)) / 60000));
    const prompt = buildActiveReplyPrompt(row, minutesPassed);
    const content = fallbackMessage(row.name || 'Contact', row);
    const messageId = `offline-${row.user_id}-${row.contact_id}-${row.message_id}-${now}`;

    const insertResult = insertMessageStmt.run({
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

    if (!insertResult.changes) {
        return null;
    }

    updateTriggerStateStmt.run(messageId, now, row.message_id, now, row.user_id, String(row.contact_id));

    const payload = {
        title: row.name ? `${row.name} sent a message` : 'New message',
        body: content,
        tag: `contact-${row.contact_id}`,
        contactId: String(row.contact_id),
        url: `./?contactId=${encodeURIComponent(String(row.contact_id))}&openChat=1`,
        data: {
            contactId: String(row.contact_id),
            messageId,
            url: `./?contactId=${encodeURIComponent(String(row.contact_id))}&openChat=1`
        }
    };

    const push = await sendPushToUser(row.user_id, payload);

    return {
        id: messageId,
        contactId: String(row.contact_id),
        content,
        time: now,
        push
    };
}

async function runActiveReplyCheck() {
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
        if (Number(row.active_reply_start_time || 0) > now) continue;
        if (row.last_triggered_msg_id && row.last_triggered_msg_id === row.message_id) continue;

        const elapsedMs = now - Number(row.time || 0);
        const requiredMs = Math.max(1, Number(row.active_reply_interval_sec || 60)) * 1000;
        if (elapsedMs < requiredMs) continue;

        const created = await createOfflineMessage(row, now);
        if (created) {
            triggered += 1;
        }
    }

    return triggered;
}

app.get('/health', (req, res) => {
    res.json({ ok: true, now: Date.now(), pushEnabled: PUSH_ENABLED });
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
    res.json({ ok: true, pushEnabled: PUSH_ENABLED });
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

app.post('/api/debug/trigger-active-reply', async (req, res) => {
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

    const created = await createOfflineMessage(row, Date.now());
    if (!created) {
        return res.status(409).json({ ok: false, error: 'message already triggered for current snapshot' });
    }

    res.json({ ok: true, message: created, serverTime: Date.now() });
});

setInterval(async () => {
    try {
        const triggered = await runActiveReplyCheck();
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
    console.log(`push enabled: ${PUSH_ENABLED}`);
});
