// GitHub Pages 上の当日JSONを取得して、UI表示用に整形する
const KEIRIN_BASE = "https://keirinjingle.github.io/date";
const AUTO_BASE = "https://keirinjingle.github.io/autorace";

/**
 * YYYYMMDD を生成（JST）
 */
export function yyyymmddJST(date = new Date()) {
  // JSTに寄せる（簡易：UTC+9）
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const jst = new Date(utc + 9 * 60 * 60000);
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function buildUrl(kind, yyyymmdd) {
  if (kind === "keirin") {
    return `${KEIRIN_BASE}/keirin_race_list_${yyyymmdd}.json`;
  }
  return `${AUTO_BASE}/autorace_race_list_${yyyymmdd}.json`;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  return res.json();
}

/**
 * 取得した元データを、UI向けに「会場→レース配列」に正規化する
 * 期待する出力:
 * [
 *   { venue: "平塚", races: [{id,no,deadline,start,netkeirinUrl,closed:false}, ...] },
 *   ...
 * ]
 *
 * ※ 元JSONの構造が環境で違う可能性があるので、
 *    できるだけ幅広いキー候補を拾う“ゆるい正規化”にしてあります。
 */
export function normalizeRaces(kind, raw) {
  // rawがすでに venueごとの配列ならそれを尊重
  const list = Array.isArray(raw) ? raw : raw?.races || raw?.race_list || [];

  // 「レース1件」を共通形にする
  const toRace = (r, idx, venueName) => {
    const no = r.race_no ?? r.raceNo ?? r.no ?? r.rno ?? idx + 1;

    // 締切時刻候補
    const deadline =
      r.deadline_time ??
      r.shimekiri ??
      r.close_time ??
      r.limitTime ??
      r.time ??
      r.deadline ??
      "";

    // 発走時刻候補（なくてもOK）
    const start =
      r.start_time ??
      r.hassou ??
      r.start ??
      r.post_time ??
      "";

    // netkeirin URL候補（競輪のみ想定だが、あれば使う）
    const netkeirinUrl =
      r.netkeirin_url ??
      r.netkeirinUrl ??
      r.url ??
      r.race_url ??
      "";

    // idを安定生成（後でサーバー側race_idに差し替えOK）
    const id = `${kind}-${venueName}-${String(no).padStart(2, "0")}`;

    return {
      id,
      no,
      deadline,
      start,
      netkeirinUrl,
      closed: false, // 締切判定はApp側で現在時刻と比較して付与
    };
  };

  // 1) venue単位の配列形式を想定して変換
  //    例: [{ venue: "平塚", races:[...] }, ...]
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

  // 2) フラットな「レースの配列」形式を想定して venueでグルーピング
  //    例: [{ venue:"平塚", race_no:1, ... }, ...]
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

function parseHHMM(hhmm) {
  // "08:45" を 今日の日付のDate（JST想定）にする
  if (!hhmm || typeof hhmm !== "string") return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);

  // JST
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const jst = new Date(utc + 9 * 60 * 60000);

  const d = new Date(jst);
  d.setHours(h, min, 0, 0);
  return d;
}

/**
 * 締切を過ぎたら closed=true を付与
 */
export function markClosed(venues) {
  const now = new Date();
  return venues.map((v) => ({
    ...v,
    races: v.races.map((r) => {
      const dl = parseHHMM(r.deadline);
      const closed = dl ? now.getTime() >= dl.getTime() : false;
      return { ...r, closed };
    }),
  }));
}

/**
 * kind: "keirin" | "auto"
 */
export async function fetchTodayVenues(kind, date = new Date()) {
  const ymd = yyyymmddJST(date);
  const url = buildUrl(kind, ymd);
  const raw = await fetchJson(url);
  return markClosed(normalizeRaces(kind, raw));
}
