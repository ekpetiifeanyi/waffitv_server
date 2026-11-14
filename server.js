const express = require("express");
const cors = require("cors");
const webpush = require("web-push");
const { keepServerAlive } = require("./utils/keep-server");
const dotenv = require("dotenv");
const { Pool } = require("pg");
dotenv.config();
const app = express();
app.use(express.json({ limit: "32kb" }));

// ALLOWED WEBSITE ORIGINS
const allowedOrigins = [
    "https://waffitv.com",
    "https://www.waffitv.com"
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (!allowedOrigins.includes(origin)) {
            return callback(new Error("Origin not allowed"));
        }
        callback(null, true);
    }
}));

// POSTGRESQL DATABASE

const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,

    ssl: {
        rejectUnauthorized: true,
        ca: process.env.PG_CA_CERT.replace(/\\n/g, "\n")
    },
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    max: 10
});


// VAPID CONFIGURATION
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const adminSecret = process.env.PUSH_ADMIN_SECRET;

if (!vapidPublicKey || !vapidPrivateKey || !adminSecret) {
    console.error("Missing required environment variables.");
    process.exit(1);
}

webpush.setVapidDetails(
    "mailto:support@waffitv.com",
    vapidPublicKey,
    vapidPrivateKey
);

// INITIALIZE DATABASE
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS push_subscriptions_waffitv (
            id SERIAL PRIMARY KEY,
            endpoint TEXT UNIQUE NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
    console.log("PostgreSQL table ready");
}

// keep database alive (safe ping)
async function keepDatabaseAlive() {
    try {
        await pool.query("SELECT 1");
        console.log("DB alive:", new Date().toISOString());
    }
    catch (err) {
        console.error("Keep alive failed:", err.message);
    }
}

// AUTHENTICATION FOR ADMIN ROUTES
function authenticateAdmin(req, res, next) {
    const authorization = req.headers.authorization;
    if (authorization !== `Bearer ${adminSecret}`) {
        return res.status(401).json({
            success: false,
            message: "Unauthorized"
        });
    }
    next();
}

// VALIDATE NOTIFICATION URL
function getSafeUrl(value) {
    try {
        const url = new URL(value || "https://www.waffitv.com");
        const allowedHosts = [
            "waffitv.com",
            "www.waffitv.com"
        ];

        if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) {
            return "https://www.waffitv.com";
        }
        return url.href;
    } catch {
        return "https://www.waffitv.com";
    }
}

// HEALTH CHECK
app.get("/health", (req, res) => {
    res.json({
        success: true,
        timestamp: new Date().toISOString()
    });
});

// PUBLIC ROUTES
// Get VAPID public key
app.get("/vapid-public-key", (req, res) => {
    res.type("text/plain").send(vapidPublicKey);
});

// Save browser subscription
app.post("/subscribe", async (req, res) => {
    const subscription = req.body;
    if (
        !subscription ||
        typeof subscription.endpoint !== "string" ||
        !subscription.keys ||
        typeof subscription.keys.p256dh !== "string" ||
        typeof subscription.keys.auth !== "string"
    ) {
        return res.status(400).json({
            success: false,
            message: "Invalid subscription data"
        });
    }

    try {
        await pool.query(
            `INSERT INTO push_subscriptions_waffitv
                (endpoint, p256dh, auth)
             VALUES ($1, $2, $3)
             ON CONFLICT (endpoint)
             DO UPDATE SET
                p256dh = EXCLUDED.p256dh,
                auth = EXCLUDED.auth`,
            [
                subscription.endpoint,
                subscription.keys.p256dh,
                subscription.keys.auth
            ]
        );

        console.log("Subscription saved");

        res.status(201).json({
            success: true,
            message: "Subscription saved successfully"
        });

    } catch (error) {
        console.error("Subscription error:", error);
        res.status(500).json({
            success: false,
            message: "Could not save subscription"
        });
    }
});

// ADMIN ROUTE: SEND NOTIFICATION TO ALL SUBSCRIBERS
app.post("/notify-all", authenticateAdmin, async (req, res) => {
    const {
        title,
        body,
        url,
        tag
    } = req.body;

    const payload = JSON.stringify({
        title: title || "WAFFITV News Update",
        body: body || "Stay informed with WAFFITV",
        url: getSafeUrl(url),
        tag: tag || `waffitv-${Date.now()}`
    });

    try {
        const { rows } = await pool.query("SELECT endpoint, p256dh, auth FROM push_subscriptions_waffitv");
        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No subscribers found"
            });
        }
        console.log(`Sending to ${rows.length} subscribers`);

        const results = await Promise.allSettled(
            rows.map(async (subscriber) => {
                const subscription = {
                    endpoint: subscriber.endpoint,
                    keys: {
                        p256dh: subscriber.p256dh,
                        auth: subscriber.auth
                    }
                };

                await webpush.sendNotification(subscription, payload);
                return subscriber.endpoint;
            })
        );

        let sent = 0;
        let failed = 0;
        let removed = 0;

        const deleteEndpoints = [];

        results.forEach((result, index) => {
            if (result.status === "fulfilled") {
                sent++;
            }
            else {
                failed++;
                const statusCode = result.reason?.statusCode;
                // Expired or invalid subscriptions
                if (statusCode === 404 || statusCode === 410) {
                    deleteEndpoints.push(rows[index].endpoint);
                }
                console.error("Push delivery failed:", statusCode || result.reason?.message
                );
            }
        });
        // Remove expired subscriptions
        if (deleteEndpoints.length > 0) {
            const deletion = await pool.query(
                `DELETE FROM push_subscriptions_waffitv
                 WHERE endpoint = ANY($1::text[])`,
                [deleteEndpoints]
            );
            removed = deletion.rowCount;
        }
        res.json({
            success: true,
            totalSubscribers: rows.length,
            sent,
            failed,
            removed
        });
    } catch (error) {
        console.error("Broadcast error:", error);
        res.status(500).json({
            success: false,
            message: "Notification broadcast failed"
        });
    }
});

// START SERVER AFTER DATABASE INITIALIZATION
const PORT = process.env.PORT;
const HOST = process.env.HOST;
const BASE_URL = "https://waffitv-server-4kxa.onrender.com";

async function startServer() {
    try {
        await initDB();
        app.listen(PORT, HOST, () => {
            console.log(`WAFFITV Push Server Listening on http://${HOST}:${PORT}`);
            keepServerAlive(`${BASE_URL}/health`);
        });
        setInterval(keepDatabaseAlive, 5 * 60 * 1000);
    } catch (error) {
        console.error("Server initialization failed:", error);
        process.exit(1);
    }
}

startServer();
