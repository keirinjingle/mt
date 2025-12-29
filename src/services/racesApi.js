const KEIRIN_BASE = "https://keirinjingle.github.io/date";
const AUTO_BASE = "https://keirinjingle.github.io/autorace";

export function yyyymmddJST(date = new Date()) {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const jst = new Date(utc + 9 * 60 * 60000);
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function buildUrl(kind, yyyymmdd) {
  if (kind === "keirin") return `${KEIRIN_BASE}/keirin_race_list_${yyyymmdd}.json`;
  return `${AUTO_BASE}/autorace_race_list_${yyyymmdd}.json`;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText} (${url})`);
  return res.json();
}

/**
 * UI用に正規化
 * 出力: [{ venue, races:[{id,no,deadline,start,netkeirinUrl,notifyAt,closed}]}]
 */
export function normalizeRaces(kind, raw) {
  const list = Array.isArray(raw) ? raw : raw?.races || raw?.race_list || [];

  const toRace = (r, idx, venueName) => {
    const no = r.race_no ?? r.raceNo ?? r.no ?? r.rno ?? idx + 1;

    const deadline =
      r.deadline_time ??
      r.shimekiri ??
      r.close_time ??
      r.limitTime ??
      r.time ??
      r.deadline ??
      "";

    const start =
      r.start_time ??
      r.hassou ??
      r.start ??
      r.post_time ??
      "";

    const netkeirinUrl =
      r.netkeirin_url ??
      r.netkeirinUrl ??
      r.url ??
      r.race_url ??
      "";

    const id = `${kind}-${venueName}-${String(no).padStart(2, "0")}`;

    return {
      id,
      no,
      deadline,
      start,
      netkeirinUrl,
      notifyAt: "", // 後で計算
      closed: false, // 後で計算
    };
  };

  const looksVenueList =
    list.length > 0 && (list[0]?.venue || list[0]?.place || list[0]?.stadium);

  if (looksVenueList) {
    return list
      .map((v) => {
        const venueName = v.venue ?? v.place ?? v.stadium ?? v.name ?? "不明";
        const racesRaw = v.races ?? v.items ?? v.race_list ?? v.list ?? [];
        const races = racesRaw.map((r, idx) => toRace(r, idx, venueName));
        return { venue: venueName, races };
      })
      .filter((v) => v.races.length > 0);
  }

  const flat = list;
  const map = new Map();
  for (let i = 0; i < flat.length; i++) {
    const r = flat[i];
    const venueName = r.venue ?? r.place ?? r.stadium ?? r.kaisai ?? "不明";
    if (!map.has(venueName)) map.set(venueName, []);
    map.get(venueName).push(r);
  }

  return Array.from(map.entries()).map(([venueName, racesRaw]) => ({
    venue: venueName,
    races: racesRaw.map((r, idx) => toRace(r, idx, venueName)),
  }));
}

function parseHHMMToJSTToday(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);

  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const jst = new Date(utc + 9 * 60 * 60000);

  const d = new Date(jst);
  d.setHours(h, min, 0, 0);
  return d;
}

function fmtHHMM(dateObj) {
  const h = String(dateObj.getHours()).padStart(2, "0");
  const m = String(dateObj.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * 仕様：
 * - 「締切」は通知の5分前扱い（=通知時刻をUIの締切として扱う）
 * - 通知時刻（締切-5分）を過ぎたらグレーアウト（closed=true）
 */
export function markClosedAndNotifyAt(venues, notifyOffsetMin = 5) {
  const now = new Date();
  return venues.map((v) => ({
    ...v,
    races: v.races.map((r) => {
      const dl = parseHHMMToJSTToday(r.deadline); // ここは JSON 上の締切時刻
      if (!dl) {
        return { ...r, notifyAt: "", closed: false };
      }
      const notifyAtDate = new Date(dl.getTime() - notifyOffsetMin * 60 * 1000);
      const notifyAt = fmtHHMM(notifyAtDate);

      const closed = now.getTime() >= notifyAtDate.getTime();
      return { ...r, notifyAt, closed };
    }),
  })
