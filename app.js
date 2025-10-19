// server.js
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

dotenv.config();

const app = express();
app.use(bodyParser.json());

const allowedOrigins = [
  'https://waffitv.com',
  'https://www.waffitv.com',
  'http://waffitv.com',
  'http://www.waffitv.com',
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('CORS policy: Origin not allowed.'), false);
    }
    return callback(null, true);
  },
  credentials: true
}));

// DATABASE (PostgreSQL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Create table for storing push subscriptions
(async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions_waffitv (
        id SERIAL PRIMARY KEY,
        endpoint TEXT UNIQUE NOT NULL,
        p256dh TEXT,
        auth TEXT
      );
    `);
    console.log('PostgreSQL table ready');
  }
  catch (err) {
    console.error('Database initialization failed:', err);
  }
})();

// VAPID KEYS CONFIGURATION
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

if (!vapidPublicKey || !vapidPrivateKey) {
  console.error('Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY in environment variables.');
  process.exit(1);
}

webpush.setVapidDetails('mailto:support@waffitv.com', vapidPublicKey, vapidPrivateKey);

// ROUTES
app.get('/vapid-public-key', (req, res) => {
  res.type('text/plain').send(vapidPublicKey);
});

// Save a new push subscription
app.post('/subscribe', async (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'Invalid subscription data' });
  }

  try {
    await pool.query(
      `INSERT INTO push_subscriptions_waffitv (endpoint, p256dh, auth)
       VALUES ($1, $2, $3)
       ON CONFLICT (endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    );
    console.log('Subscription saved:', subscription.endpoint);
    res.status(201).json({ message: 'Subscription saved successfully' });
  }
  catch (err) {
    console.error('Error saving subscription:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Send to ALL subscribers
app.post("/notify-all", async (req, res) => {
  const { title, body, url } = req.body;
  const payload = JSON.stringify({
    title: title || "WAFFITV News Update",
    body: body || "Stay informed with WAFFITV",
    url: url || "https://www.waffitv.com",
  });

  try {
    const { rows } = await pool.query("SELECT * FROM push_subscriptions_waffitv");
    if (rows.length === 0) {
      return res.status(404).json({ message: "No subscribers found" });
    }

    console.log(`Sending push to ${rows.length} subscribers...`);
    const results = await Promise.allSettled(
      rows.map(sub => {
        const subscription = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        };
        return webpush.sendNotification(subscription, payload);
      })
    );

    let sent = 0;
    for (const result of results) {
      if (result.status === "fulfilled") sent++;
      if (result.reason?.statusCode === 410) {
        const endpoint = result.reason?.body?.endpoint;
        await pool.query("DELETE FROM push_subscriptions_waffitv WHERE endpoint = $1", [endpoint]);
      }
    }
    res.json({ success: true, totalSent: sent });
  }
  catch (err) {
    console.error("Broadcast error:", err);
    res.status(500).json({ error: "Failed to send to all" });
  }
});

// Health route
app.get("/", (_, res) => res.send("Waffitv Push Server Running"));

// --- START SERVER ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));