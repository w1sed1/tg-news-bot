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
const MAX_PER_RUN = 1;
const MAX_GIST = 260;
const FEED_TIMEOUT = 12000;
const SEND_TIMEOUT = 12000;
const HARD_LIMIT = 240000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const CHANNEL_LINK = "https://t.me/holovne_za_hodynu";

const parser = new Parser({
  timeout: FEED_TIMEOUT,
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
    return {
      posted: Array.isArray(data.posted) ? data.posted : [],
      lastSummary: data.lastSummary || ""
    };
  } catch {
    return { posted: [], lastSummary: "" };
  }
}

async function saveState(state) {
  state.posted = state.posted.slice(-MAX_STATE);
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function send(text, isNight) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(SEND_TIMEOUT),
    body: JSON.stringify({
      chat_id: CHANNEL_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
      disable_notification: isNight
    })
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

async function collect() {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const parsed = await Promise.race([
        parser.parseURL(feed.url),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), FEED_TIMEOUT))
      ]);
      return (parsed.items || []).map((i) => ({ ...i, id: i.guid || i.link || i.title, source: feed.source }));
    })
  );
  const all = [];
  results.forEach((r, idx) => {
    if (r.status === "fulfilled") {
      for (const it of r.value) if (it.id) all.push(it);
    }
  });
  return all;
}

function format(item) {
  const rawTitle = clean(item.title || "Без заголовка");
  const title = escapeHtml(rawTitle);
  const g = escapeHtml(gist(item));
  const link = item.link || "";
  let text = `<b>${tag(rawTitle)}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `<b>${title}</b>\n\n`;
  if (g) text += `<i>${g}</i>\n\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  if (link) text += `🔗 <a href="${link}">Читати повністю</a> · ${escapeHtml(item.source)}\n`;
  text += `\n<a href="${CHANNEL_LINK}"><b>⚡ Головне за годину</b></a>`;
  return text;
}

async function run() {
  if (!BOT_TOKEN || !CHANNEL_ID) throw new Error("BOT_TOKEN or CHANNEL_ID missing");
  const state = await loadState();
  const seen = new Set(state.posted);
  const items = (await collect())
    .filter((i) => fresh(i) && !seen.has(i.id))
    .sort((a, b) => new Date(b.isoDate || 0) - new Date(a.isoDate || 0));

  const hour = new Date().getHours();
  const isNight = hour >= 23 || hour < 7;
  const today = new Date().toISOString().split("T")[0];
  const isMorning = hour === 8;
  const isEvening = hour === 20;

  let summaryType = "";
  if (isMorning) summaryType = today + "-morning";
  if (isEvening) summaryType = today + "-evening";

  if (summaryType && state.lastSummary !== summaryType) {
    const summaryItems = items.slice(0, 5);
    if (summaryItems.length > 0) {
      let text = isMorning ? "☀️ <b>Ранковий підсумок:</b>\n\n" : "🌙 <b>Вечірній підсумок:</b>\n\n";
      summaryItems.forEach((i, idx) => {
        text += `${idx + 1}. <a href="${i.link || ''}">${escapeHtml(clean(i.title || ""))}</a>\n`;
      });
      text += `\n<a href="${CHANNEL_LINK}"><b>⚡ Головне за годину</b></a>`;
      
      await send(text, isNight);
      state.lastSummary = summaryType;
      summaryItems.forEach(i => {
        state.posted.push(i.id);
        seen.add(i.id);
      });
      await saveState(state);
      return;
    }
  }

  let count = 0;
  const titles = new Set();
  for (const item of items) {
    if (count >= MAX_PER_RUN) break;
    const nt = norm(item.title || "");
    if (!nt || titles.has(nt)) continue;
    try {
      await send(format(item), isNight);
      state.posted.push(item.id);
      seen.add(item.id);
      titles.add(nt);
      count++;
      await sleep(1200);
    } catch (e) {}
  }
  await saveState(state);
}

const wd = setTimeout(() => {
  process.exit(1);
}, HARD_LIMIT);
wd.unref();

run()
  .then(() => {
    clearTimeout(wd);
    process.exit(0);
  })
  .catch((e) => {
    process.exit(1);
  });
