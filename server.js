import express from "express";
import { chromium } from "playwright";
import { Redis } from "@upstash/redis";
import { URL } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

/* ================= REDIS ================= */
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

/* ================= CORS ================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/health", (req, res) => res.status(200).send("ok"));

/* ================= PLAYWRIGHT ================= */
let browser = null;
let context = null;
async function ensureBrowser() {
  if (browser && context) return;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  });
}

/* ================= UTILS ================= */
const RUNNING = new Set();
const stripQuery = (u) => u.split("?")[0];
const isSmall = (u) =>
  u.toLowerCase().includes("small.") &&
  (u.endsWith(".jpeg") || u.endsWith(".jpg") || u.endsWith(".png") || u.endsWith(".webp"));

const albumSet = (u) => `albumset:${u}`;
const albumDone = (u) => `albumdone:${u}`;
const albumOrigin = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

/* ================= SCRAPE PROGRESSIVO ================= */
async function scrapeAlbum(albumUrl) {
  if (!redis || RUNNING.has(albumUrl)) return;
  RUNNING.add(albumUrl);

  try {
    await ensureBrowser();
    const page = await context.newPage();

    page.on("response", async (r) => {
      const u = stripQuery(r.url());
      if (isSmall(u)) {
        await redis.sadd(albumSet(albumUrl), u);
        await redis.expire(albumSet(albumUrl), 60 * 60 * 24 * 7);
      }
    });

    await page.goto(albumUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);

    await redis.set(albumDone(albumUrl), "1", { ex: 60 * 60 * 24 * 7 });
    await page.close();
  } catch {}
  RUNNING.delete(albumUrl);
}

/* ================= WARM ================= */
app.get("/warm", async (req, res) => {
  try {
    await ensureBrowser();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ================= PREHEAT ================= */
app.get("/api/yupoo/preheat", async (req, res) => {
  const albumUrl = req.query.url;
  if (!albumUrl || !redis) return res.status(400).json({ error: "Missing url" });

  if (!(await redis.get(albumDone(albumUrl))) && !RUNNING.has(albumUrl)) {
    scrapeAlbum(albumUrl);
  }

  res.json({ ok: true });
});

/* ================= PROGRESS API ================= */
app.get("/api/yupoo/progress", async (req, res) => {
  const albumUrl = req.query.url;
  if (!albumUrl || !redis) return res.status(400).json({ error: "Missing url" });

  if (!(await redis.get(albumDone(albumUrl))) && !RUNNING.has(albumUrl)) {
    scrapeAlbum(albumUrl);
  }

  const imgs = (await redis.smembers(albumSet(albumUrl))) || [];
  imgs.sort();

  const origin = albumOrigin(albumUrl);
  const base = `https://${req.get("host")}`;

  res.json({
    done: (await redis.get(albumDone(albumUrl))) === "1",
    origin,
    imagesOriginal: imgs,
    imagesProxy: imgs.map(
      (u) => `${base}/img?src=${encodeURIComponent(u)}&origin=${encodeURIComponent(origin)}`
    ),
  });
});

/* ================= IMAGE PROXY (FAST) ================= */
app.get("/img", async (req, res) => {
  const { src, origin } = req.query;
  if (!src) return res.status(400).send("Missing src");

  try {
    const r = await fetch(src, {
      headers: {
        Referer: origin || "https://yupoo.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      },
    });

    if (!r.ok) return res.status(502).send("Upstream error");
    const buf = Buffer.from(await r.arrayBuffer());

    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.send(buf);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

app.listen(PORT, () => console.log("API running"));
