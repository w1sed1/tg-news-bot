import Parser from "rss-parser";
import { readFile, writeFile } from "node:fs/promises";

const FEEDS = [
  { source: "Українська правда", url: "https://www.pravda.com.ua/rss/view_mainnews/" },
  { source: "Українська правда", url: "https://www.pravda.com.ua/rss/view_news/" },
  { source: "ТСН", url: "https://tsn.ua/rss/full.rss" },
  { source: "НВ", url: "https://nv.ua/rss/all.xml" },
  { source: "УНІАН", url: "https://rss.unian.net/site/news_ukr.rss" },
  { source: "ГОРДОН", url: "https://gordonua.com/xml/rss_category/top.html" }
];

const TAGS = [
  { label: "🔴 Війна", re: /обстріл|ракет|дрон|шахед|удар|фронт|зсу|окупан|ппо|атак|вибух|ворог|бпла|тривог|снаряд|полон|мобіліз/i },
  { label: "🏛 Політика", re: /зеленськ|верховна рада|уряд|міністр|президент|депутат|вибор|санкц|коаліц|парламент|політик|кабмін/i },
  { label: "💵 Економіка", re: /курс|гривн|долар|євро|інфляц|бюджет|тариф|ціни|податк|бізнес|економ|зарплат|субсид|мвф/i },
  { label: "💻 Технології", re: /технолог|застосун|гаджет|apple|google|microsoft|штучн інтелект|стартап|нейромереж|смартфон/i },
  { label: "🌍 Світ", re: /сша|трамп|байден|євросоюз|нато|путін|росія|кремл|китай|ізраїл|європ|світов|орбан/i }
];

const STATE_FILE = "state.json";
const MAX_STATE = 1500;
const MAX_AGE_HOURS = 8;
const MAX_PER_RUN = 4;
const MAX_GIST = 260;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const CHANNEL_LINK = "https://t.me/holovne_za_hodynu";

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    Accept: "application/rss+xml, application/xml, text/xml, */*"
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(s = "") {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clean(s = "") {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function norm(s = "") {
  return s.toLowerCase().replace(/[^a-zа-яіїєґ0-9 ]/gi, "").replace(/\s+/g, " ").trim();
}

function tag(title) {
  const t = title.toLowerCase();
  for (const x of TAGS) if (x.re.test(t)) return x.label;
  return "📰 Головне";
}

function gist(item) {
  const raw = clean(item.contentSnippet || item.summary || item.content || "");
  if (!raw) return "";
  if (raw.length <= MAX_GIST) return raw;
  const cut = raw.slice(0, MAX_GIST);
  const sp = cut.lastIndexOf(" ");
  return (sp > 120 ? cut.slice(0, sp) : cut).trim() + "…";
}

function fresh(item) {
  if (!item.isoDate) return true;
  const t = new Date(item.isoDate).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t <= MAX_AGE_HOURS * 3600000;
}

async function loadState() {
  try {
    const data = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return Array.isArray(data.posted) ? data.posted : [];
  } catch {
    return [];
  }
}

async function saveState(posted) {
  await writeFile(STATE_FILE, JSON.stringify({ posted: posted.slice(-MAX_STATE) }, null, 2));
}

async function send(text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHANNEL_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

async function collect() {
  const all = [];
  for (const feed of FEEDS) {
    try {
      const parsed = await Promise.race([
        parser.parseURL(feed.url),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000))
      ]);
      for (const i of parsed.items || []) {
        const id = i.guid || i.link || i.title;
        if (id) all.push({ ...i, id, source: feed.source });
      }
    } catch (e) {
      console.error(`[skip] ${feed.url}: ${e.message}`);
    }
  }
  return all;
}

function format(item) {
  const rawTitle = clean(item.title || "Без заголовка");
  const title = escapeHtml(rawTitle);
  const g = escapeHtml(gist(item));
  const link = item.link || "";
  let text = `${tag(rawTitle)}\n\n<b>${title}</b>`;
  if (g) text += `\n\n${g}`;
  if (link) text += `\n\n🔗 <a href="${link}">Читати повністю</a> · ${escapeHtml(item.source)}`;
  text += `\n\n<a href="${CHANNEL_LINK}"><b>⚡ Головне за годину</b></a>`;
  return text;
}

async function run() {
  if (!BOT_TOKEN || !CHANNEL_ID) throw new Error("BOT_TOKEN or CHANNEL_ID missing");
  const posted = await loadState();
  const seen = new Set(posted);
  const items = (await collect())
    .filter((i) => fresh(i) && !seen.has(i.id))
    .sort((a, b) => new Date(b.isoDate || 0) - new Date(a.isoDate || 0));

  let count = 0;
  const titles = new Set();
  for (const item of items) {
    if (count >= MAX_PER_RUN) break;
    const nt = norm(item.title || "");
    if (!nt || titles.has(nt)) continue;
    try {
      await send(format(item));
      posted.push(item.id);
      seen.add(item.id);
      titles.add(nt);
      count++;
      await sleep(1200);
    } catch (e) {
      console.error(`[send-fail] ${e.message}`);
    }
  }
  await saveState(posted);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
