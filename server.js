import express from "express";
import * as cheerio from "cheerio";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCES = {
  wavl: "https://volleyball.exposureevents.com/259835/wavl/documents/schedule?layout=datetime",
  wavjl: "https://volleyball.exposureevents.com/267727/wavjl-2026/documents/schedule?layout=datetime",
};

// Companion venue pages (name + street address), keyed by the same league slugs.
const VENUE_SOURCES = {
  wavl: "https://volleyball.exposureevents.com/259835/wavl/documents/venues",
  wavjl: "https://volleyball.exposureevents.com/267727/wavjl-2026/documents/venues",
};

const app = express();
const PORT = process.env.PORT || 3000;

// Simple in-memory cache (per league) so we don't hammer the source site.
const cache = {};
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const isReds = (name) => /\breds\b/i.test(name);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Sort key for ordering teams by division: SL first, then D1, D2, ...
// and within each division by gender/grade: M, W, RM, RW.
function teamSortKey(name) {
  const prefix = name.split(/\s+/)[0]; // e.g. "D1M", "SLRW"
  let divRank = 999;
  let rest = "";
  const m = prefix.match(/^D(\d+)(.*)$/);
  if (/^SL/.test(prefix)) {
    divRank = 0; // State League comes before the numbered divisions
    rest = prefix.slice(2);
  } else if (m) {
    divRank = parseInt(m[1], 10);
    rest = m[2];
  }
  const reserve = /^R/.test(rest) ? 1 : 0; // "R" marks reserves
  const women = /W$/.test(prefix) ? 1 : 0;
  const gradeIdx = reserve * 2 + women; // M=0, W=1, RM=2, RW=3
  return [divRank, gradeIdx];
}

// "Saturday, April 11, 2026" -> "Saturday, 11 April 2026". Falls back to the raw string.
function formatDate(raw) {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// "Saturday, April 11, 2026" -> "2026-04-11" for date-range comparisons.
function toISODate(raw) {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Parse each venue from a "documents/venues" page into { abbrLower: address }.
function parseVenues(html) {
  const $ = cheerio.load(html);
  const byAbbr = {};
  $("td.division-venue").each((_, td) => {
    const $td = $(td);
    const abbr = clean($td.find("i").first().text()).replace(/^\(|\)$/g, "");
    if (!abbr) return;
    // The 3rd <div> is the address; prefer its <span> (fuller) when present.
    const $addr = $td.children("div").eq(2);
    const $span = $addr.find("span").first();
    const address = clean(($span.length ? $span.text() : $addr.text()).replace(/^[,\s]+/, ""));
    byAbbr[abbr.toLowerCase()] = address;
  });
  return byAbbr;
}

function parseSchedule(html, venueAddrByAbbr = {}) {
  const $ = cheerio.load(html);

  // Build a map of venue id -> full venue name from the legend at the bottom.
  const venueNames = {};
  $('[id^="venue-"]').each((_, el) => {
    venueNames[$(el).attr("id")] = clean($(el).text());
  });

  const matches = [];

  // Each date is its own <table class="division-schedule"> with the date in <h3>.
  $("table.division-schedule").each((_, table) => {
    const $table = $(table);
    const rawDate = clean($table.find("thead h3").first().text());
    const date = formatDate(rawDate);
    const dateISO = toISODate(rawDate);

    $table.find("tr.game").each((_, row) => {
      const cells = $(row).children("td");
      const time = clean($(cells[0]).text());

      const venueAbbr = clean($(cells[1]).text());
      const venueHref = $(cells[1]).find("a").attr("href") || "";
      const venueId = venueHref.replace(/^#/, "");
      // Legend names look like "Aquin - Aquinas College"; drop the abbreviation prefix.
      const venueFull = (venueNames[venueId] || venueAbbr).replace(/^.*?\s-\s/, "");
      const venueAddress = venueAddrByAbbr[venueAbbr.toLowerCase()] || "";

      const court = clean($(cells[2]).text());
      const division = clean($(cells[3]).text());
      const home = clean($(cells[4]).text());
      const away = clean($(cells[5]).text());
      const work = clean($(cells[6]).text());
      const score = clean($(cells[7]).text());

      // The source marks the winning team's cell with class="winner".
      const homeWon = $(cells[4]).hasClass("winner");
      const awayWon = $(cells[5]).hasClass("winner");

      // Keep the game if a Reds team is involved as home, away, or work.
      if (!isReds(home) && !isReds(away) && !isReds(work)) return;

      // Reds result for this game: W/L if a Reds team played, N/A if Reds only
      // had work duty, and "" if the game hasn't been played yet.
      const redHome = isReds(home);
      const redAway = isReds(away);
      const played = score !== "" || homeWon || awayWon;
      let result;
      if (!played) result = "";
      else if (redHome || redAway) {
        if (redHome && redAway) result = "W"; // Reds vs Reds — a Reds team won
        else if (redHome) result = homeWon ? "W" : "L";
        else result = awayWon ? "W" : "L";
      } else {
        result = "N/A"; // Reds were only the work team
      }

      // Set tally from the Reds perspective, e.g. "3-1" (or "1-3" for a loss).
      let setScore = "";
      if (score && (redHome || redAway)) {
        let homeSets = 0;
        let awaySets = 0;
        for (const set of score.split(",")) {
          const sm = set.trim().match(/^(\d+)-(\d+)$/);
          if (!sm) continue;
          if (+sm[1] > +sm[2]) homeSets++;
          else if (+sm[2] > +sm[1]) awaySets++;
        }
        // Use the away perspective only when Reds are the away side (not Reds-vs-Reds).
        setScore = redAway && !redHome ? `${awaySets}-${homeSets}` : `${homeSets}-${awaySets}`;
      }

      matches.push({
        date,
        dateISO,
        time,
        venue: venueFull,
        venueAddress,
        court,
        division,
        home,
        away,
        work,
        score,
        homeWon,
        awayWon,
        played,
        result,
        setScore,
      });
    });
  });

  return matches;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (reds-wavl-schedule)" },
  });
  if (!res.ok) {
    throw new Error(`Source returned HTTP ${res.status}`);
  }
  return res.text();
}

async function getMatches(league) {
  const url = SOURCES[league];
  if (!url) throw new Error(`Unknown league: ${league}`);
  const c = cache[league];
  if (c && Date.now() - c.at < CACHE_MS) {
    return c.data;
  }
  // Venue addresses are best-effort: a failure there must not break the schedule.
  const [html, venuesHtml] = await Promise.all([
    fetchText(url),
    fetchText(VENUE_SOURCES[league]).catch(() => ""),
  ]);
  const data = parseSchedule(html, venuesHtml ? parseVenues(venuesHtml) : {});
  cache[league] = { at: Date.now(), data };
  return data;
}

app.get("/api/matches", async (req, res) => {
  const league = req.query.league || "wavl";
  try {
    const matches = await getMatches(league);

    // Distinct Reds teams that appear as home, away, or work, for the filter buttons.
    const teamSet = new Set();
    for (const m of matches) {
      if (isReds(m.home)) teamSet.add(m.home);
      if (isReds(m.away)) teamSet.add(m.away);
      if (isReds(m.work)) teamSet.add(m.work);
    }
    const teams = [...teamSet].sort((a, b) => {
      const ka = teamSortKey(a);
      const kb = teamSortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || a.localeCompare(b, undefined, { numeric: true });
    });

    res.json({ count: matches.length, league, source: SOURCES[league], teams, matches });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Pretty routes for the duty/bag roster pages.
app.get("/wavl-schedule", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "wavl-schedule.html"));
});
app.get("/wavjl-schedule", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "wavjl-schedule.html"));
});

app.use(express.static(path.join(__dirname, "public")));

// Only start a long-running server when run directly (local dev).
// On Vercel the app is imported and invoked as a serverless function instead.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Reds WAVL schedule running at http://localhost:${PORT}`);
  });
}

export default app;
