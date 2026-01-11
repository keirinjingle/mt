import React, { useEffect, useMemo, useRef, useState } from "react";
import { getToken, onMessage } from "firebase/messaging";
import { messaging, VAPID_KEY } from "./firebase";

/**
 * もふタイマー Web
 * 改修：
 * - オート通知が来ない対策（closed_at正規化 + notify_urlフォールバック）
 * - 通知一覧(#notifications)に居るとき「競輪/オート」押下でhomeへ戻す
 * - ガールズアコーディオン(個別選択) + テキスト出力URL削除 + 選手名表示（既存）
 */

const APP_TITLE = "もふタイマー";
const BASE = "https://keirinjingle.github.io";

const MODE_KEIRIN = "keirin";
const MODE_AUTORACE = "autorace";

/* ===== Hash routing ===== */
function getRouteFromHash() {
  const h = (window.location.hash || "").replace("#", "");
  return h === "notifications" ? "notifications" : "home";
}
function setHash(route) {
  window.location.hash = route === "notifications" ? "#notifications" : "#";
}

function getApiBase() {
  const base = (import.meta?.env?.VITE_API_BASE || "").trim();
  return base ? base.replace(/\/$/, "") : "";
}

function apiUrl(path) {
  const base = getApiBase();
  if (!base) return "";
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}/api${p}`;
}

/* ===== 設定/保存 ===== */
const STORAGE_USER_ID = "mofu_anon_user_id";
const STORAGE_OPEN_VENUES = "mofu_open_venues_v1";
const STORAGE_TOGGLED = "mofu_race_toggled_v1";
const STORAGE_SETTINGS = "mofu_settings_v5";

/** token関連 */
const STORAGE_FCM_TOKEN = "mofu_fcm_token_v1";
const STORAGE_FCM_TOKEN_SENT = "mofu_fcm_token_sent_v1";
const STORAGE_FCM_TOKEN_SENT_AT = "mofu_fcm_token_sent_at_v1";

const DEFAULT_SETTINGS = {
  timer1MinutesBefore: 5,
  timer2Enabled: false,
  timer2MinutesBefore: 2,
  linkTarget: "json",
  linkTargetAuto: "autoracejp",
  proCode: "",
  notificationsEnabled: false,
};

/* 通知タップ先（競輪） */
const LINK_TARGETS_KEIRIN = [
  { key: "json", label: "ネット競輪（レース情報）" },
  { key: "oddspark", label: "オッズパーク" },
  { key: "chariloto", label: "チャリロト" },
  { key: "winticket", label: "WINTICKET" },
  { key: "dmm", label: "DMM競輪" },
];

/* 通知タップ先（オート） */
const LINK_TARGETS_AUTO = [
  { key: "autoracejp", label: "AutoRace.JP（公式）" },
  { key: "oddspark", label: "オッズパーク" },
  { key: "chariloto", label: "チャリロト" },
  { key: "winticket", label: "WINTICKET" },
  { key: "json", label: "投票サイトへ飛ばない" },
];

function getLinkUrl(linkTargetKey, raceUrlFromJson, mode) {
  if (mode === MODE_AUTORACE) {
    switch (linkTargetKey) {
      case "autoracejp":
        return "https://autorace.jp/";
      case "oddspark":
        return "https://www.oddspark.com/autorace/";
      case "chariloto":
        return "https://www.chariloto.com/autorace";
      case "winticket":
        return "https://www.winticket.jp/autorace/";
      case "json":
      default:
        return raceUrlFromJson || "";
    }
  }
  switch (linkTargetKey) {
    case "json":
      return raceUrlFromJson || "";
    case "oddspark":
      return "https://www.oddspark.com/";
    case "chariloto":
      return "https://www.chariloto.com/keirin";
    case "winticket":
      return "https://www.winticket.jp/keirin/";
    case "dmm":
      return "https://keirin.dmm.com/";
    default:
      return raceUrlFromJson || "";
  }
}

/* ===== Util ===== */
function pad2(n) {
  return String(n).padStart(2, "0");
}
function todayKeyYYYYMMDD() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}
function toYYYYMMDD(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function formatYMD_JP(ms) {
  if (!ms || !Number.isFinite(Number(ms))) return "";
  const d = new Date(Number(ms));
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}
function toHHMM(dateObj) {
  return `${pad2(dateObj.getHours())}:${pad2(dateObj.getMinutes())}`;
}

/**
 * ★追加：時刻の正規化
 * - "13:05:00" -> "13:05"
 * - "1305"     -> "13:05"
 * - "9:05"     -> "09:05"
 */
function normalizeHHMM(v) {
  const s = String(v || "").trim();
  if (!s) return "";

  // 13:05:00 / 13:05 -> 13:05
  let m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return `${pad2(m[1])}:${m[2]}`;

  // 1305 -> 13:05 / 905 -> 09:05（※ "905" は 9:05 と解釈）
  m = s.match(/^(\d{1,2})(\d{2})$/);
  if (m) return `${pad2(m[1])}:${m[2]}`;

  // その他はそのまま
  return s;
}

function parseHHMMToday(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d;
}
function addMinutes(dateObj, minutes) {
  const d = new Date(dateObj.getTime());
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}
function safeJsonParse(str, fallback) {
  try {
    const v = JSON.parse(str);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function ensureAnonUserId() {
  const existing = localStorage.getItem(STORAGE_USER_ID);
  if (existing) return existing;
  const uuid =
    (crypto && crypto.randomUUID && crypto.randomUUID()) ||
    `anon_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(STORAGE_USER_ID, uuid);
  return uuid;
}
function formatTokenShort(token) {
  const t = String(token || "");
  if (!t) return "";
  if (t.length <= 18) return t;
  return `${t.slice(0, 8)}...${t.slice(-6)}`;
}

/* ===== JSON fetch ===== */
async function fetchRacesJson(mode) {
  const date = todayKeyYYYYMMDD();
  const url =
    mode === MODE_AUTORACE
      ? `${BASE}/autorace/autorace_race_list_${date}.json`
      : `${BASE}/date/keirin_race_list_${date}.json`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`JSON fetch failed: ${res.status}`);
  return await res.json();
}

function normalizeToVenues(raw, mode) {
  const list = Array.isArray(raw)
    ? raw
    : raw && (raw.venues || raw.data || raw.items)
    ? raw.venues || raw.data || raw.items
    : [];

  if (Array.isArray(list) && list.length > 0 && list[0] && Array.isArray(list[0].races)) {
    return list.map((v) => {
      const venueName = v.venue || v.venueName || v.name || "会場";
      const venueKey = `${mode}_${venueName}`;
      const races = (v.races || []).map((r, ri) => normalizeRace(r, mode, { venueName, venueKey }, ri));
      return {
        venueKey,
        venueName,
        grade: v.grade || "",
        races: races.sort((a, b) => (a.raceNo || 0) - (b.raceNo || 0)),
      };
    });
  }
  return [];
}

function normalizeRace(r, mode, v, ri) {
  const venueName = (v && v.venueName) || r.venue || r.venueName || "会場";
  const venueKey = (v && v.venueKey) || `${mode}_${venueName}`;
  const raceNo = Number(r.race_number ?? r.raceNo ?? r.race_no ?? r.race ?? r.no ?? (ri + 1)) || (ri + 1);

  // ★修正：時刻の正規化（秒付き/数値でも吸収）
  const rawClosed = r.closed_at || r.closedAt || r.close_at || r.closeAt || r.deadline || r.shimekiri || "";
  const closedAtHHMM = normalizeHHMM(rawClosed);

  const url = r.url || r.raceUrl || "";
  const title = r.class_category || r.title || r.name || `${raceNo}R`;
  const date = todayKeyYYYYMMDD();
  const raceKey = `${date}_${venueKey}_${pad2(raceNo)}`;
  const players = Array.isArray(r.players) ? r.players : [];
  const classCategory = r.class_category || r.classCategory || "";

  return { raceKey, venueKey, venueName, raceNo, title, closedAtHHMM, url, mode, players, classCategory };
}

/* ===== サーバー連携 ===== */
async function trySendRemoveToServer({ anonUserId, raceKey }) {
  const url = apiUrl("/notifications/remove");
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anon_user_id: anonUserId, race_key: raceKey }),
    });
  } catch {
    // ignore
  }
}

async function postSubscriptionSetToServer(payload) {
  const url = apiUrl("/subscriptions/set");
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`subscriptions/set failed: ${res.status}`);
  } catch (e) {
    console.warn("[subscriptions/set] failed", e);
  }
}

/* ===== ページ：通知一覧 ===== */
function NotificationsPage({ venues, toggled, settings, onBack, onRemoveRaceKey }) {
  const [showText, setShowText] = useState(false);
  const raceMap = useMemo(() => {
    const m = new Map();
    for (const v of venues) for (const r of v.races) m.set(r.raceKey, r);
    return m;
  }, [venues]);

  const selectedRaceKeys = useMemo(() => Object.keys(toggled), [toggled]);

  const rows = useMemo(() => {
    const list = [];
    for (const rk of selectedRaceKeys) {
      const r = raceMap.get(rk);
      if (!r) continue;
      const closedAt = parseHHMMToday(r.closedAtHHMM);
      list.push({
        raceKey: rk,
        venueName: r.venueName,
        raceNo: r.raceNo,
        title: r.title,
        closedAt,
        closedAtHHMM: r.closedAtHHMM,
        url: r.url,
        mode: r.mode,
      });
    }
    list.sort((a, b) => {
      if (a.venueName !== b.venueName) return a.venueName.localeCompare(b.venueName, "ja");
      return (a.raceNo || 0) - (b.raceNo || 0);
    });
    return list;
  }, [selectedRaceKeys, raceMap]);

  // ★URLなし：シンプルなリストのみ
  const textData = useMemo(() => {
    return rows
      .map((r) => `${r.venueName} ${r.raceNo}R ${r.closedAtHHMM}締切`)
      .join("\n");
  }, [rows]);

  return (
    <main style={styles.main}>
      <section className="card">
        <div className="pageHead">
          <div className="pageTitle">通知一覧</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className={`smallBtn ${showText ? "on" : ""}`} onClick={() => setShowText(!showText)}>
              テキスト表示
            </button>
            <button className="btn" onClick={onBack}>
              戻る
            </button>
          </div>
        </div>

        {showText && (
          <div style={{ marginBottom: 16 }}>
            <textarea
              readOnly
              style={{
                width: "100%",
                height: 200,
                fontSize: 13,
                padding: 8,
                borderRadius: 8,
                border: "1px solid #ccc",
                background: "#f9f9f9",
              }}
              value={textData}
            />
            <div style={{ fontSize: 12, opacity: 0.7, textAlign: "right" }}>コピーして使ってください</div>
          </div>
        )}

        {rows.length === 0 ? (
          <div style={{ opacity: 0.85 }}>通知がありません。</div>
        ) : (
          <div className="notifyList">
            {rows.map((x) => {
              const targetKey = x.mode === MODE_AUTORACE ? settings.linkTargetAuto : settings.linkTarget;
              const link = getLinkUrl(targetKey, x.url, x.mode);
              return (
                <div key={x.raceKey} className="notifyRowSimple">
                  <div className="notifyLeftSimple">
                    <div className="notifyLine">
                      <span className="notifyName">
                        {x.venueName} {x.raceNo}R
                      </span>
                      <span className="notifyTitle">{x.title}</span>
                      <span className="notifyDeadline">
                        締切 <b>{x.closedAt ? toHHMM(x.closedAt) : x.closedAtHHMM || "--:--"}</b>
                      </span>
                      <a
                        className="notifyLink"
                        href={link || "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          if (!link) e.preventDefault();
                        }}
                      >
                        レース情報
                      </a>
                    </div>
                  </div>
                  <div className="notifyRightSimple">
                    <button className="btn danger" onClick={() => onRemoveRaceKey(x.raceKey)}>
                      削除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card">
        <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.6 }}>
          ・「削除」は端末内の通知リストから外します。<br />
          ・サーバー連携（VITE_API_BASE）がある場合は同時に削除通知も送ります。
        </div>
      </section>
    </main>
  );
}

export default function App() {
  useEffect(() => {
    document.title = APP_TITLE;
  }, []);
  useEffect(() => {
    ensureAnonUserId();
  }, []);

  const [route, setRoute] = useState(getRouteFromHash());
  useEffect(() => {
    const onHash = () => setRoute(getRouteFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const [mode, setMode] = useState(MODE_KEIRIN);
  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [openVenues, setOpenVenues] = useState(() =>
    safeJsonParse(localStorage.getItem(STORAGE_OPEN_VENUES) || "{}", {})
  );

  // ★ガールズ用アコーディオン開閉
  const [girlsAccordionOpen, setGirlsAccordionOpen] = useState(false);

  const [toggled, setToggled] = useState(() => safeJsonParse(localStorage.getItem(STORAGE_TOGGLED) || "{}", {}));
  const [settings, setSettings] = useState(() => {
    const stored = safeJsonParse(localStorage.getItem(STORAGE_SETTINGS) || "null", null);
    return { ...DEFAULT_SETTINGS, ...(stored || {}) };
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [fcmToken, setFcmToken] = useState(() => localStorage.getItem(STORAGE_FCM_TOKEN) || "");

  const [proState, setProState] = useState({
    loading: false,
    verified: false,
    pro: false,
    maxNotifications: 10,
    timer2Allowed: false,
    adsOff: false,
    expiresAtMs: null,
    period: "",
    message: "",
  });

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr("");
    fetchRacesJson(mode)
      .then((j) => {
        if (alive) setVenues(normalizeToVenues(j, mode));
      })
      .catch((e) => {
        if (alive) {
          setErr(String(e?.message || e));
          setVenues([]);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [mode]);

  useEffect(() => {
    localStorage.setItem(STORAGE_OPEN_VENUES, JSON.stringify(openVenues));
  }, [openVenues]);
  useEffect(() => {
    localStorage.setItem(STORAGE_TOGGLED, JSON.stringify(toggled));
  }, [toggled]);
  useEffect(() => {
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    if (fcmToken) localStorage.setItem(STORAGE_FCM_TOKEN, fcmToken);
  }, [fcmToken]);

  useEffect(() => {
    try {
      async function showForegroundNotification(payload) {
        if (!payload || !("Notification" in window) || Notification.permission !== "granted") return;
        const title = payload?.notification?.title || payload?.data?.title || "もふタイマー";
        const body = payload?.notification?.body || payload?.data?.body || "";
        const icon = payload?.notification?.icon || payload?.data?.icon;

        const url =
          payload?.fcmOptions?.link || payload?.data?.url || "https://mt.qui2.net/#notifications";

        const tag = payload?.data?.race_key || undefined;
        const options = { body, icon, data: { ...(payload?.data || {}), url }, tag, renotify: true };
        const reg = await navigator.serviceWorker?.ready;
        if (reg?.showNotification) {
          await reg.showNotification(title, options);
          return;
        }
        new Notification(title, options);
      }
      const unsub = onMessage(messaging, (payload) => {
        showForegroundNotification(payload);
      });
      return () => unsub();
    } catch {
      /* ignore */
    }
  }, []);

  const todayLabel = useMemo(() => toYYYYMMDD(new Date()), []);
  const selectedCount = useMemo(() => Object.keys(toggled).length, [toggled]);

  // ★ガールズレース抽出
  const girlsRacesList = useMemo(() => {
    if (mode !== MODE_KEIRIN) return [];
    const list = [];
    for (const v of venues) {
      for (const r of v.races) {
        if (r.classCategory && r.classCategory.includes("Ｌ級")) {
          list.push({ ...r, venueName: v.venueName });
        }
      }
    }
    list.sort((a, b) => {
      const ta = parseHHMMToday(a.closedAtHHMM)?.getTime() || 0;
      const tb = parseHHMMToday(b.closedAtHHMM)?.getTime() || 0;
      return ta - tb;
    });
    return list;
  }, [venues, mode]);

  const raceMap = useMemo(() => {
    const m = new Map();
    for (const v of venues) for (const r of v.races) m.set(r.raceKey, r);
    return m;
  }, [venues]);

  // PRO verify
  const verifyTimerRef = useRef(null);
  function defaultsFromProFlag(isPro) {
    return { maxNotifications: isPro ? 999 : 10, timer2Allowed: !!isPro, adsOff: !!isPro };
  }
  async function verifyProCodeNow(code) {
    const trimmed = String(code || "").trim();
    const verifyUrl = apiUrl("/pro/verify");
    if (!verifyUrl) {
      setProState((p) => ({
        ...p,
        loading: false,
        verified: true,
        pro: false,
        ...defaultsFromProFlag(false),
        period: "",
        message: "無料版（API未設定）",
      }));
      return;
    }
    if (!trimmed) {
      setProState((p) => ({
        ...p,
        loading: false,
        verified: true,
        pro: false,
        ...defaultsFromProFlag(false),
        period: "",
        message: "",
      }));
      return;
    }
    setProState((p) => ({ ...p, loading: true, message: "" }));
    const anonUserId = ensureAnonUserId();
    try {
      const res = await fetch(verifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anon_user_id: anonUserId, pro_code: trimmed }),
      });
      if (!res.ok) throw new Error("failed");
      const data = await res.json();
      const plan = String(data?.plan || (data?.pro ? "PRO" : "FREE")).toUpperCase();
      const isPro = plan === "PRO";
      const expiresAtMs = Number.isFinite(Number(data?.expires_at)) ? Number(data.expires_at) : null;
      const expiresLabel = expiresAtMs ? formatYMD_JP(expiresAtMs) : "";
      const periodText = expiresLabel ? `有効期限：${expiresLabel}` : String(data?.period || "");
      const df = defaultsFromProFlag(isPro);
      setProState({
        loading: false,
        verified: true,
        pro: isPro,
        maxNotifications: Number(data?.max_notifications) || df.maxNotifications,
        timer2Allowed: typeof data?.timer2_allowed === "boolean" ? data.timer2_allowed : df.timer2Allowed,
        adsOff: typeof data?.ads_off === "boolean" ? data.ads_off : df.adsOff,
        expiresAtMs,
        period: periodText,
        message: String(data?.message || (isPro ? "PRO" : "無料版")),
      });
      if (!isPro) setSettings((p) => ({ ...p, timer2Enabled: false }));
    } catch {
      setProState((p) => ({
        ...p,
        loading: false,
        verified: true,
        pro: false,
        ...defaultsFromProFlag(false),
        period: "",
        message: "検証失敗",
      }));
      setSettings((p) => ({ ...p, timer2Enabled: false }));
    }
  }
  useEffect(() => {
    if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
    verifyTimerRef.current = setTimeout(() => verifyProCodeNow(settings.proCode), 600);
    return () => {
      if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
    };
  }, [settings.proCode]);

  const isPro = !!proState.pro;
  const timer2Allowed = !!proState.timer2Allowed;
  const adsOff = !!proState.adsOff;
  const maxNotifications = Number(proState.maxNotifications || 10);
  const timer2GateOpen = isPro && timer2Allowed;
  const timer2Active = timer2GateOpen && !!settings.timer2Enabled;

  const [testPushState, setTestPushState] = useState({ loading: false, message: "" });
  async function sendTestPushAfter5s(token) {
    const url = apiUrl("/push/test");
    if (!url) {
      setTestPushState({ loading: false, message: "API未設定" });
      return;
    }
    const anonUserId = ensureAnonUserId();
    const t = String(token || "").trim();
    setTestPushState({ loading: true, message: "送信中..." });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anon_user_id: anonUserId,
          token: t,
          delay_sec: 5,
          url: `${window.location.origin}/#notifications`,
        }),
      });
      if (!res.ok) throw new Error();
      setTestPushState({ loading: false, message: "OK" });
    } catch {
      setTestPushState({ loading: false, message: "失敗" });
    }
  }

  async function postDeviceRegisterIfNeeded(token) {
    const url = apiUrl("/devices/register");
    if (!url) return;
    const anonUserId = ensureAnonUserId();
    const t = String(token || "").trim();
    if (!t || localStorage.getItem(STORAGE_FCM_TOKEN_SENT) === t) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anon_user_id: anonUserId,
          token: t,
          platform: "web",
          ua: navigator.userAgent,
          origin: window.location.origin,
          ts: Date.now(),
        }),
      });
      localStorage.setItem(STORAGE_FCM_TOKEN_SENT, t);
      localStorage.setItem(STORAGE_FCM_TOKEN_SENT_AT, String(Date.now()));
    } catch {
      /* ignore */
    }
  }

  async function requestPushPermissionAndRegister() {
    try {
      const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
      const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
      if (!token) return;
      setFcmToken(token);
      localStorage.setItem(STORAGE_FCM_TOKEN, token);
      await postDeviceRegisterIfNeeded(token);
      setSettings((p) => ({ ...p, notificationsEnabled: true }));
    } catch (e) {
      alert("失敗: " + e);
    }
  }

  function toggleVenueOpen(venueKey) {
    setOpenVenues((prev) => ({ ...prev, [venueKey]: !prev[venueKey] }));
  }

  function setVenueAll(venue, on) {
    setToggled((prev) => {
      const next = { ...prev };
      if (!on) {
        for (const r of venue.races) delete next[r.raceKey];
        return next;
      }
      let remaining = Math.max(0, maxNotifications - Object.keys(next).length);
      for (const r of venue.races) {
        if (next[r.raceKey]) continue;
        if (remaining <= 0) break;
        next[r.raceKey] = true;
        remaining -= 1;
      }
      if (remaining <= 0 && Object.keys(next).length >= maxNotifications) alert(`上限 ${maxNotifications}件`);
      return next;
    });
  }

  // ★一括切替 (ガールズ)
  function toggleGirlsAll(on) {
    setToggled((prev) => {
      const next = { ...prev };
      const targetRaces = [];
      for (const v of venues) {
        for (const r of v.races) {
          if (r.classCategory && r.classCategory.includes("Ｌ級")) targetRaces.push(r);
        }
      }
      if (!on) {
        for (const r of targetRaces) delete next[r.raceKey];
        return next;
      }
      let remaining = Math.max(0, maxNotifications - Object.keys(next).length);
      for (const r of targetRaces) {
        if (next[r.raceKey]) continue;
        if (remaining <= 0) break;
        next[r.raceKey] = true;
        remaining -= 1;
      }
      if (remaining <= 0 && Object.keys(next).length >= maxNotifications) alert(`上限 ${maxNotifications}件`);
      return next;
    });
  }

  function toggleRace(raceKey) {
    const anonUserId = ensureAnonUserId();
    const race = raceMap.get(raceKey);

    setToggled((prev) => {
      const next = { ...prev };

      if (next[raceKey]) {
        delete next[raceKey];
        postSubscriptionSetToServer({ anon_user_id: anonUserId, race_key: raceKey, enabled: false });
        return next;
      }

      if (Object.keys(next).length >= maxNotifications) {
        alert(`通知は最大 ${maxNotifications} 件までです。`);
        return next;
      }

      next[raceKey] = true;

      if (race) {
        const t1 = Number(settings.timer1MinutesBefore);
        const t2 = Number(settings.timer2MinutesBefore);
        const isAuto = race.mode === MODE_AUTORACE;
        const targetKey = isAuto ? settings.linkTargetAuto : settings.linkTarget;

        // ★修正：notify_url が空ならアプリへフォールバック（サーバー必須でも落ちない）
        const appFallbackUrl = `${window.location.origin}/#notifications`;
        const notifyUrl = getLinkUrl(targetKey, race.url, race.mode) || appFallbackUrl;

        const payload = {
          anon_user_id: anonUserId,
          race_key: raceKey,
          enabled: true,
          race_date: todayKeyYYYYMMDD(),
          closed_at_hhmm: race.closedAtHHMM,
          // ★修正：race_url も空なら notifyUrl を入れておく（サーバー実装次第で重要）
          race_url: race.url || notifyUrl,
          link_target: targetKey,
          notify_url: notifyUrl,
          title: `${race.venueName}${race.raceNo}R`,
          timer1_min: Number.isFinite(t1) ? t1 : 5,
          timer2_enabled: !!timer2Active,
          timer2_min: Number.isFinite(t2) ? t2 : 1,
        };
        postSubscriptionSetToServer(payload);
      }

      return next;
    });
  }

  async function removeNotification(raceKey) {
    setToggled((prev) => {
      const next = { ...prev };
      delete next[raceKey];
      return next;
    });
    const anonUserId = ensureAnonUserId();
    await trySendRemoveToServer({ anonUserId, raceKey });
  }

  // 設定変更同期
  const resyncTimerRef = useRef(null);
  useEffect(() => {
    const hasApi = !!apiUrl("/subscriptions/set");
    if (!hasApi) return;

    const keys = Object.keys(toggled || {});
    if (keys.length === 0) return;

    if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);

    resyncTimerRef.current = setTimeout(() => {
      const anonUserId = ensureAnonUserId();
      for (const raceKey of keys) {
        const race = raceMap.get(raceKey);
        if (!race) continue;

        const t1 = Number(settings.timer1MinutesBefore);
        const t2 = Number(settings.timer2MinutesBefore);
        const isAuto = race.mode === MODE_AUTORACE;
        const targetKey = isAuto ? settings.linkTargetAuto : settings.linkTarget;

        // ★修正：ここも同じフォールバック
        const appFallbackUrl = `${window.location.origin}/#notifications`;
        const notifyUrl = getLinkUrl(targetKey, race.url, race.mode) || appFallbackUrl;

        postSubscriptionSetToServer({
          anon_user_id: anonUserId,
          race_key: raceKey,
          enabled: true,
          closed_at_hhmm: race.closedAtHHMM,
          race_url: race.url || notifyUrl,
          link_target: targetKey,
          notify_url: notifyUrl,
          title: `${race.venueName}${race.raceNo}R`,
          timer1_min: Number.isFinite(t1) ? t1 : 5,
          timer2_enabled: !!timer2Active,
          timer2_min: Number.isFinite(t2) ? t2 : 1,
        });
      }
    }, 450);

    return () => {
      if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
    };
  }, [settings, timer2Active, toggled, raceMap]);

  // ===== Header =====
  function Header({ rightHomeIcon }) {
    return (
      <header style={styles.header}>
        <div style={styles.headerTop}>
          <div style={styles.titleRow}>
            <div style={styles.title}>
              {APP_TITLE} <span style={{ opacity: 0.9 }}>🐾</span>
            </div>
            <div style={styles.dateInline}>{todayLabel}</div>
          </div>

          <div style={styles.rightHead}>
            <button className="iconBtn" onClick={() => setSettingsOpen(true)} aria-label="settings">
              ⚙︎
            </button>
            {rightHomeIcon === "notifications" ? (
              <button className="iconBtn" onClick={() => setHash("notifications")} aria-label="notifications">
                ☰
              </button>
            ) : (
              <button className="iconBtn" onClick={() => setHash("home")} aria-label="home">
                ⌂
              </button>
            )}
          </div>
        </div>

        <div style={styles.modeRow}>
          <div style={styles.modeSwitch}>
            {/* ★改善：通知一覧にいるとき、競輪/オートを押したらhomeへ戻す */}
            <button
              className={`chip ${mode === MODE_KEIRIN ? "chipOn" : ""}`}
              onClick={() => {
                setMode(MODE_KEIRIN);
                if (route === "notifications") setHash("home");
              }}
            >
              競輪
            </button>
            <button
              className={`chip ${mode === MODE_AUTORACE ? "chipOn" : ""}`}
              onClick={() => {
                setMode(MODE_AUTORACE);
                if (route === "notifications") setHash("home");
              }}
            >
              オート
            </button>
          </div>

          <div className="tinyMeta">
            <span className={`pill ${isPro ? "pillOn" : "pillOff"}`}>{isPro ? "PRO" : "FREE"}</span>
            <span className="tinyCount">
              通知 {selectedCount}/{maxNotifications}
            </span>
          </div>
        </div>
      </header>
    );
  }

  // ===== route: notifications =====
  if (route === "notifications") {
    return (
      <div style={styles.page}>
        <style>{cssText}</style>
        <Header rightHomeIcon="home" />
        <NotificationsPage
          venues={venues}
          toggled={toggled}
          settings={settings}
          onBack={() => setHash("home")}
          onRemoveRaceKey={removeNotification}
        />
        {settingsOpen && (
          <SettingsModal
            onClose={() => setSettingsOpen(false)}
            settings={settings}
            setSettings={setSettings}
            fcmToken={fcmToken}
            onRequestPushPermission={requestPushPermissionAndRegister}
            onSendTestPush={sendTestPushAfter5s}
            testPushState={testPushState}
            proState={proState}
            isPro={isPro}
            onVerifyProCode={(code) => {
              if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
              verifyProCodeNow(code);
            }}
            maxNotifications={maxNotifications}
            selectedCount={selectedCount}
            timer2GateOpen={timer2GateOpen}
            setToggled={setToggled}
          />
        )}
      </div>
    );
  }

  // ===== route: home =====
  return (
    <div style={styles.page}>
      <style>{cssText}</style>
      <Header rightHomeIcon="notifications" />

      {!adsOff && (
        <div style={styles.main}>
          <div className="adBar">
            <div className="adText">スポンサー枠（有料コードで非表示）</div>
            <div className="adSub">ここに告知やバナーを入れる想定</div>
          </div>
        </div>
      )}

      <main style={styles.main}>
        {/* ガールズ一括アコーディオン（競輪モードのみ・ガールズ開催がある場合） */}
        {mode === MODE_KEIRIN && girlsRacesList.length > 0 && (
          <section className="card">
            <div className="venueHead" onClick={() => setGirlsAccordionOpen(!girlsAccordionOpen)}>
              <div className="venueTitle">
                <span className="chev">{girlsAccordionOpen ? "▼" : "▶"}</span>
                <span className="venueName">ガールズ開催のみ ({girlsRacesList.length}R)</span>
              </div>
              <div className="venueActions" onClick={(e) => e.stopPropagation()}>
                <button className="smallBtn on" onClick={() => toggleGirlsAll(true)} title="まとめてON">
                  ON
                </button>
                <button className="smallBtn off" onClick={() => toggleGirlsAll(false)} title="まとめてOFF">
                  OFF
                </button>
              </div>
            </div>

            {girlsAccordionOpen && (
              <div className="raceList">
                {girlsRacesList.map((r) => {
                  const closedAt = parseHHMMToday(r.closedAtHHMM);
                  const ended = closedAt ? now.getTime() >= closedAt.getTime() : false;
                  const checked = !!toggled[r.raceKey];
                  const link = getLinkUrl(settings.linkTarget, r.url, r.mode);

                  return (
                    <div key={`g_${r.raceKey}`} className={`raceRow ${ended ? "ended" : ""}`}>
                      <div className="raceLeft">
                        <div className="raceTopLine">
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 900,
                              background: "#eee",
                              padding: "2px 6px",
                              borderRadius: 4,
                              marginRight: 6,
                            }}
                          >
                            {r.venueName}
                          </span>
                          <div className="raceNo">{r.raceNo}R</div>
                          <div className="raceDeadline">
                            締切 <b>{closedAt ? toHHMM(closedAt) : "--:--"}</b>
                          </div>
                          <a
                            className="raceLink"
                            href={link || "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => {
                              if (!link) e.preventDefault();
                            }}
                          >
                            レース情報
                          </a>
                        </div>

                        {r.players && r.players.length > 0 && <div className="racePlayers">{r.players.join("　")}</div>}
                      </div>

                      <div className="raceRight">
                        <div className="toggleWrap">
                          <label className="toggle">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleRace(r.raceKey)}
                              disabled={ended}
                            />
                            <span className="slider" />
                          </label>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {loading && <div className="card">読み込み中…</div>}
        {!loading && err && (
          <div className="card error">
            <div style={{ fontWeight: 700 }}>読み込み失敗</div>
            <div>{err}</div>
          </div>
        )}
        {!loading && !err && venues.length === 0 && <div className="card">今日のデータがありません。</div>}

        {!loading &&
          !err &&
          venues.map((v) => {
            const isOpen = !!openVenues[v.venueKey];
            return (
              <section className="card" key={v.venueKey}>
                <div className="venueHead" onClick={() => toggleVenueOpen(v.venueKey)}>
                  <div className="venueTitle">
                    <span className="chev">{isOpen ? "▼" : "▶"}</span>
                    <span className="venueName">{v.venueName}</span>
                    {v.grade ? <span className="grade">{v.grade}</span> : null}
                  </div>
                  <div className="venueActions" onClick={(e) => e.stopPropagation()}>
                    <button className="smallBtn on" onClick={() => setVenueAll(v, true)}>
                      ON
                    </button>
                    <button className="smallBtn off" onClick={() => setVenueAll(v, false)}>
                      OFF
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="raceList">
                    {v.races.map((r) => {
                      const closedAt = parseHHMMToday(r.closedAtHHMM);
                      const ended = closedAt ? now.getTime() >= closedAt.getTime() : false;
                      const checked = !!toggled[r.raceKey];
                      const isAuto = r.mode === MODE_AUTORACE;
                      const targetKey = isAuto ? settings.linkTargetAuto : settings.linkTarget;
                      const link = getLinkUrl(targetKey, r.url, r.mode);

                      return (
                        <div key={r.raceKey} className={`raceRow ${ended ? "ended" : ""}`}>
                          <div className="raceLeft">
                            <div className="raceTopLine">
                              <div className="raceNo">{r.raceNo}R</div>
                              <div className="raceTitle">{r.title}</div>
                              <div className="raceDeadline">
                                締切 <b>{closedAt ? toHHMM(closedAt) : "--:--"}</b>
                              </div>
                              <a
                                className="raceLink"
                                href={link || "#"}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => {
                                  if (!link) e.preventDefault();
                                }}
                              >
                                レース情報
                              </a>
                            </div>

                            {r.players && r.players.length > 0 && <div className="racePlayers">{r.players.join("　")}</div>}
                          </div>

                          <div className="raceRight">
                            <div className="toggleWrap">
                              <label className="toggle">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleRace(r.raceKey)}
                                  disabled={ended}
                                />
                                <span className="slider" />
                              </label>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
      </main>

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          setSettings={setSettings}
          fcmToken={fcmToken}
          onRequestPushPermission={requestPushPermissionAndRegister}
          onSendTestPush={sendTestPushAfter5s}
          testPushState={testPushState}
          proState={proState}
          isPro={isPro}
          onVerifyProCode={(code) => {
            if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
            verifyProCodeNow(code);
          }}
          maxNotifications={maxNotifications}
          selectedCount={selectedCount}
          timer2GateOpen={timer2GateOpen}
          setToggled={setToggled}
        />
      )}
    </div>
  );
}

/* ===== 設定モーダル ===== */
function SettingsModal({
  onClose,
  settings,
  setSettings,
  fcmToken,
  onRequestPushPermission,
  onSendTestPush,
  testPushState,
  proState,
  isPro,
  onVerifyProCode,
  maxNotifications,
  selectedCount,
  timer2GateOpen,
  setToggled,
}) {
  const canRequest = (() => {
    try {
      return "Notification" in window && "serviceWorker" in navigator;
    } catch {
      return false;
    }
  })();
  const permission = (() => {
    try {
      return "Notification" in window ? Notification.permission : "unsupported";
    } catch {
      return "unsupported";
    }
  })();
  const canTest = !!fcmToken && permission === "granted" && !!onSendTestPush;
  const proStatusLabel = String(proState?.message || "");
  const timer2EnabledUI = !!settings.timer2Enabled;
  const timer2ToggleDisabled = !timer2GateOpen;

  function resetAllSelections() {
    setToggled?.({});
    setSettings((s) => ({ ...s, __resetAll: Date.now() }));
  }

  return (
    <div className="modalBack" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modalHead settingsHeader">
          <div className="modalTitle">設定</div>
          <div className="settingsHeaderRight">
            <button type="button" className="iconBtn closeBtn" onClick={onClose} aria-label="close">
              ✕
            </button>
          </div>
        </div>

        <div className="modalBody">
          <div className="row">
            <div className="label">Push通知</div>
            <div style={{ display: "grid", gap: 10 }}>
              {!canRequest ? (
                <div style={{ fontSize: 12, opacity: 0.8, lineHeight: 1.5 }}>利用不可</div>
              ) : permission === "granted" ? (
                <div className="pushGrantRow">
                  <div className="pushGrantLeft">
                    <div style={{ fontWeight: 900 }}>許可済み</div>
                  </div>
                  <div className="pushGrantRight">
                    <div style={{ fontWeight: 900, letterSpacing: 0.2 }}>ON</div>
                    <button
                      type="button"
                      className="btn small pushTestBtn"
                      onClick={() => onSendTestPush?.(fcmToken)}
                      disabled={!canTest || !!testPushState?.loading}
                    >
                      {testPushState?.loading ? "送信中…" : "テスト（5秒後）"}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn" onClick={onRequestPushPermission}>
                  通知を許可する
                </button>
              )}
            </div>
          </div>

          <div className="row">
            <div className="label">1つ目タイマー</div>
            <select
              value={String(settings.timer1MinutesBefore)}
              onChange={(e) => setSettings((s) => ({ ...s, timer1MinutesBefore: e.target.value }))}
            >
              {[1, 2, 3, 4, 5, 7, 10, 15].map((m) => (
                <option key={m} value={String(m)}>
                  {m} 分前
                </option>
              ))}
            </select>
          </div>

          <div className="row">
            <div className="label">2つ目タイマー</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={!!settings.timer2Enabled}
                  onChange={(e) => setSettings((s) => ({ ...s, timer2Enabled: e.target.checked }))}
                  disabled={timer2ToggleDisabled}
                />
                <span className="slider" />
              </label>
              <div style={{ opacity: timer2GateOpen ? 1 : 0.7, fontWeight: 800 }}>
                {timer2EnabledUI ? "ON" : "OFF"}
              </div>
            </div>
            {!timer2GateOpen ? <div className="hint">PRO版で解放</div> : null}
          </div>

          <div className="row">
            <div className="label">2回目（分前）</div>
            <select
              value={String(settings.timer2MinutesBefore)}
              onChange={(e) => setSettings((s) => ({ ...s, timer2MinutesBefore: e.target.value }))}
              disabled={!timer2GateOpen || !settings.timer2Enabled}
            >
              {[1, 2, 3, 4, 5, 7, 10, 15].map((m) => (
                <option key={m} value={String(m)}>
                  {m} 分前
                </option>
              ))}
            </select>
          </div>

          <div className="row">
            <div className="label">通知先(競輪)</div>
            <select value={settings.linkTarget} onChange={(e) => setSettings((s) => ({ ...s, linkTarget: e.target.value }))}>
              {LINK_TARGETS_KEIRIN.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div className="row">
            <div className="label">通知先(オート)</div>
            <select
              value={settings.linkTargetAuto}
              onChange={(e) => setSettings((s) => ({ ...s, linkTargetAuto: e.target.value }))}
            >
              {LINK_TARGETS_AUTO.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div className="row">
            <div className="label">コード入力</div>
            <div style={{ display: "grid", gap: 8 }}>
              <div className="codeRow">
                <input
                  className="codeInput"
                  value={settings.proCode || ""}
                  onChange={(e) => setSettings((s) => ({ ...s, proCode: e.target.value }))}
                  placeholder="コードを入力"
                />
                <button type="button" className="btn small" onClick={() => onVerifyProCode?.(settings.proCode)} disabled={!!proState?.loading}>
                  {proState?.loading ? "送信中…" : "送信"}
                </button>
              </div>
              <div className="codeMeta">
                <div style={{ fontSize: 12, opacity: 0.85 }}>{isPro ? `有効期限：${formatYMD_JP(proState.expiresAtMs) || "—"}` : "無料版"}</div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>{proStatusLabel || ""}</div>
              </div>
            </div>
          </div>

          <div className="row">
            <div className="label">通知上限</div>
            <div style={{ fontWeight: 800 }}>
              現在：{selectedCount} 件 / 上限：{maxNotifications} 件
            </div>
          </div>

          <div className="row">
            <div className="label">選択のリセット</div>
            <div style={{ display: "grid", gap: 8 }}>
              <button type="button" className="btn danger" onClick={resetAllSelections}>
                すべて解除
              </button>
            </div>
          </div>
        </div>

        <div className="modalFoot">
          <button type="button" className="btn" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===== style ===== */
const styles = {
  page: {
    minHeight: "100vh",
    background: "#F6F7F3",
    color: "#111",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontWeight: 400,
  },
  header: {
    position: "sticky",
    top: 0,
    zIndex: 5,
    backdropFilter: "blur(10px)",
    background: "rgba(246,247,243,0.90)",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    padding: "12px 12px 10px",
  },
  headerTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
  titleRow: { display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 },
  title: { fontSize: 18, fontWeight: 900, letterSpacing: 0.2, whiteSpace: "nowrap" },
  dateInline: { fontSize: 12, fontWeight: 700, opacity: 0.7, whiteSpace: "nowrap" },
  rightHead: { display: "flex", alignItems: "center", gap: 10, flexWrap: "nowrap" },
  modeRow: { marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 },
  modeSwitch: { display: "flex", gap: 8, flexWrap: "wrap" },
  main: { padding: 14, maxWidth: 820, margin: "0 auto", display: "grid", gap: 12 },
};

const cssText = `
:root{ --bg: #F6F7F3; --card: #FFFFFF; --ink: #111111; --accent: #2E6F3E; --accent2: #E6F1E7; --border: rgba(0,0,0,0.08); --shadow: 0 10px 22px rgba(0,0,0,0.06); }
*{ box-sizing: border-box; } html, body{ background: var(--bg); }
button, input, select{ font: inherit; } select, input{ border: 1px solid rgba(0,0,0,0.12); border-radius: 14px; padding: 10px 12px; background: #fff; } select{ cursor:pointer; } input{ width: 100%; }
.card{ background: var(--card); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--shadow); padding: 12px; }
.card.error{ border-color: rgba(220,0,0,0.20); background: rgba(255,240,240,0.92); }
.chip{ border: 1px solid rgba(0,0,0,0.10); background: rgba(255,255,255,0.95); padding: 10px 14px; border-radius: 999px; cursor: pointer; font-weight: 900; white-space: nowrap; }
.chipOn{ border-color: rgba(46,111,62,0.28); background: var(--accent2); }
.iconBtn{ border: 1px solid rgba(0,0,0,0.10); background: rgba(255,255,255,0.95); width: 48px; height: 48px; border-radius: 16px; cursor: pointer; font-weight: 900; font-size: 20px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
.btn{ border: 1px solid rgba(0,0,0,0.12); background: #fff; padding: 10px 14px; border-radius: 14px; cursor: pointer; font-weight: 900; }
.btn.small{ padding: 8px 10px; font-size: 12px; border-radius: 12px; }
.btn.danger{ border-color: rgba(220,0,0,0.22); background: rgba(255,240,240,0.9); }
.adBar{ border: 1px dashed rgba(0,0,0,0.14); background: rgba(0,0,0,0.02); border-radius: 16px; padding: 10px 12px; }
.adText{ font-weight: 900; } .adSub{ font-size: 12px; opacity: 0.75; margin-top: 2px; }
.tinyMeta{ display:flex; align-items:center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.tinyCount{ font-size: 12px; opacity: 0.7; white-space: nowrap; }
.pill{ display:inline-flex; align-items:center; justify-content:center; padding: 6px 10px; border-radius: 999px; border: 1px solid rgba(0,0,0,0.12); font-weight: 900; font-size: 12px; white-space: nowrap; }
.pillOn{ background: var(--accent2); border-color: rgba(46,111,62,0.25); } .pillOff{ background: rgba(0,0,0,0.02); opacity: 0.9; }
.venueHead{ display:flex; align-items:center; justify-content: space-between; gap: 10px; cursor: pointer; }
.venueTitle{ display:flex; align-items:center; gap: 10px; min-width: 0; }
.venueName{ font-weight: 900; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46vw; }
.chev{ opacity: 0.7; } .grade{ font-size: 12px; border: 1px solid rgba(0,0,0,0.12); border-radius: 999px; padding: 4px 8px; opacity: 0.8; white-space: nowrap; }
.venueActions{ display:flex; gap: 8px; flex: 0 0 auto; }
.smallBtn{ border: 1px solid rgba(0,0,0,0.12); background: #fff; padding: 8px 10px; border-radius: 12px; cursor:pointer; font-weight: 900; }
.smallBtn.on{ background: var(--accent2); border-color: rgba(46,111,62,0.25); } .smallBtn.off{ background: rgba(0,0,0,0.02); }
.raceList{ margin-top: 10px; display:grid; gap: 10px; }
.raceRow{ display:flex; gap: 10px; align-items: stretch; border: 1px solid rgba(0,0,0,0.08); background: rgba(255,255,255,0.75); border-radius: 16px; padding: 10px; }
.raceRow.ended{ opacity: 0.50; filter: grayscale(20%); }
.raceLeft{ flex: 1 1 auto; min-width: 0; } .raceRight{ flex: 0 0 auto; display:flex; align-items:center; }
.raceTopLine{ display:flex; align-items:center; gap: 10px; flex-wrap: wrap; }
.raceNo{ font-weight: 900; white-space: nowrap; } .raceTitle{ font-weight: 800; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.raceDeadline{ font-size: 12px; opacity: 0.85; white-space: nowrap; }
.raceLink{ font-size: 12px; font-weight: 900; color: var(--ink); text-decoration: underline; white-space: nowrap; cursor: pointer; } .raceLink:hover{ opacity: 0.7; }
.racePlayers{ font-size: 12px; margin-top: 6px; color: #555; line-height: 1.4; opacity: 0.9; word-break: break-all; }
.toggleWrap{ padding-left: 6px; } .toggle{ position: relative; display:inline-block; width: 54px; height: 32px; }
.toggle input{ position:absolute; inset:0; opacity:0; width:100%; height:100%; cursor:pointer; }
.slider{ position:absolute; cursor:pointer; inset:0; background: rgba(0,0,0,0.18); border: 1px solid rgba(0,0,0,0.10); transition: .15s; border-radius: 999px; }
.slider:before{ content:""; position:absolute; height: 24px; width: 24px; left: 3px; top: 3px; background: #fff; transition: .15s; border-radius: 999px; box-shadow: 0 4px 12px rgba(0,0,0,0.16); }
.toggle input:checked + .slider{ background: var(--accent); border-color: rgba(46,111,62,0.30); }
.toggle input:checked + .slider:before{ transform: translateX(22px); }
.pageHead{ display:flex; align-items:center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.pageTitle{ font-size: 16px; font-weight: 900; } .notifyList{ display:grid; gap: 10px; }
.notifyRowSimple{ display:flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid rgba(0,0,0,0.08); background: rgba(255,255,255,0.75); border-radius: 16px; padding: 10px; }
.notifyLeftSimple{ flex: 1 1 auto; min-width: 0; } .notifyRightSimple{ flex: 0 0 auto; display:flex; align-items:center; gap: 8px; }
.notifyLine{ display:flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.notifyName{ font-weight: 900; white-space: nowrap; } .notifyTitle{ font-weight: 800; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notifyDeadline{ font-size: 12px; opacity: 0.85; white-space: nowrap; }
.notifyLink{ font-size: 12px; font-weight: 900; color: var(--ink); text-decoration: underline; white-space: nowrap; } .notifyLink:hover{ opacity: 0.7; }
.modalBack{ position: fixed; inset: 0; background: rgba(0,0,0,0.35); display:flex; align-items: flex-start; justify-content: center; padding: 24px 16px 16px; z-index: 50; }
.modal{ width: min(720px, 100%); background: #fff; border-radius: 20px; border: 1px solid rgba(0,0,0,0.10); box-shadow: 0 18px 40px rgba(0,0,0,0.22); overflow: hidden; max-height: calc(100vh - 40px); display: flex; flex-direction: column; }
.modalHead{ display:flex; align-items:center; justify-content: space-between; gap: 10px; padding: 12px 12px; border-bottom: 1px solid rgba(0,0,0,0.06); }
.modalTitle{ font-weight: 900; } .modalBody{ padding: 12px; display:grid; gap: 10px; overflow: auto; min-height: 0; }
.modalFoot{ padding: 12px; border-top: 1px solid rgba(0,0,0,0.06); display:flex; justify-content: flex-end; }
.row{ display:grid; grid-template-columns: 160px 1fr; gap: 10px; align-items: center; }
.label{ font-size: 13px; font-weight: 900; opacity: 0.80; } .hint{ margin-top: 6px; font-size: 12px; opacity: 0.72; }
@media (max-width: 560px){ .row{ grid-template-columns: 1fr; } .venueName{ max-width: 58vw; } }
.pushGrantRow{ display:flex; align-items:center; justify-content: space-between; gap: 12px; }
.pushGrantLeft{ flex: 0 0 auto; } .pushGrantRight{ display:flex; align-items:center; gap: 10px; flex: 0 0 auto; position: relative; z-index: 10000; }
.pushTestBtn{ pointer-events: auto !important; position: relative; z-index: 10001; }
.settingsHeader, .settingsHeaderRight{ position: relative; z-index: 9999; } .settingsHeaderRight button{ position: relative; z-index: 10000; pointer-events: auto; }
.codeRow{ display:flex; gap: 10px; align-items:center; } .codeInput{ flex: 1 1 auto; min-width: 0; } .codeMeta{ margin-top: 8px; display:grid; gap: 4px; }
.closeBtn{ margin-top: 4px; } .modalBack{ pointer-events:auto; } .modal{ pointer-events:auto; } .modal *{ pointer-events:auto; }
`;
