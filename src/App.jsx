import React, { useEffect, useMemo, useRef, useState } from "react";
import { getToken, onMessage } from "firebase/messaging";
import { messaging, VAPID_KEY } from "./firebase";

/**
 * もふタイマー Web（最小・全部入り / 1ファイル）
 * - Vite + React
 * - 本番: mt.qui2.net 直下配信
 * - 当日のみ（GitHub Pages上のJSON）
 * - 会場アコーディオン + レース行トグル（1つ）
 *
 * 追加:
 * - Hash Routing: #notifications で通知一覧ページ
 * - 通知一覧から削除（localStorage更新 + 可能ならサーバーへ通知）
 * - ヘッダーに通知ON/OFF（Push購読）
 * - PRO（有料コード）をAPIで検証（サーバー管理）
 *   - 通知上限（FREE=10など）/ 2つ目タイマー / 広告OFF をサーバーの返答で制御
 *
 * サーバー側想定API:
 * POST {VITE_API_BASE}/pro/verify
 *   body: { anon_user_id: string, pro_code: string }
 *   resp例:
 *     {
 *       ok: true,
 *       pro: true,
 *       max_notifications: 999,   // 未指定なら既定(PRO=999, FREE=10)
 *       timer2_allowed: true,     // 未指定なら既定(PRO=true, FREE=false)
 *       ads_off: true,            // 未指定なら既定(PRO=true, FREE=false)
 *       message: "optional"
 *     }
 *
 * ※ VITE_API_BASE が空なら、常にFREE扱い（PROは無効）にします。
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

/* ===== 設定/保存 ===== */
const MINUTE_OPTIONS = [5, 4, 3, 2, 1];

const STORAGE_USER_ID = "mofu_anon_user_id";
const STORAGE_OPEN_VENUES = "mofu_open_venues_v1";
const STORAGE_TOGGLED = "mofu_race_toggled_v1";
const STORAGE_SETTINGS = "mofu_settings_v4"; // v3→v4（PRO検証状態を含めたいので）

const DEFAULT_SETTINGS = {
  timer1MinutesBefore: 5,
  timer2Enabled: false,
  timer2MinutesBefore: 2,
  linkTarget: "json",

  // 入力値（ユーザーが入れる）
  proCode: "",

  // 通知ON/OFF（Push購読）
  notificationsEnabled: false,
};

/* 通知タップ先 */
const LINK_TARGETS = [
  { key: "json", label: "ネット競輪（レース情報）" },
  { key: "oddspark", label: "オッズパーク" },
  { key: "chariloto", label: "チャリロト" },
  { key: "winticket", label: "WINTICKET" },
  { key: "dmm", label: "DMM競輪" },
];

function getLinkUrl(linkTargetKey, raceUrlFromJson) {
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
function toHHMM(dateObj) {
  return `${pad2(dateObj.getHours())}:${pad2(dateObj.getMinutes())}`;
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
      const races = (v.races || []).map((r, ri) =>
        normalizeRace(r, mode, { venueName, venueKey }, ri)
      );
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

  const raceNo =
    Number(r.race_number ?? r.raceNo ?? r.race_no ?? r.race ?? r.no ?? (ri + 1)) || (ri + 1);

  const closedAtHHMM =
    r.closed_at || r.closedAt || r.close_at || r.closeAt || r.deadline || r.shimekiri || "";

  const url = r.url || r.raceUrl || "";
  const title = r.class_category || r.title || r.name || `${raceNo}R`;

  const date = todayKeyYYYYMMDD();
  const raceKey = `${date}_${venueKey}_${pad2(raceNo)}`;

  return { raceKey, venueKey, venueName, raceNo, title, closedAtHHMM, url };
}

function computeNotifyAt(race, minutesBefore) {
  const closed = parseHHMMToday(race.closedAtHHMM);
  const m = Number(minutesBefore);
  if (!closed || !Number.isFinite(m)) return null;
  return addMinutes(closed, -m);
}

async function trySendRemoveToServer({ anonUserId, raceKey }) {
  const apiBase = (import.meta?.env?.VITE_API_BASE || "").trim();
  if (!apiBase) return;
  try {
    await fetch(`${apiBase.replace(/\/$/, "")}/notifications/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anon_user_id: anonUserId, race_key: raceKey }),
    });
  } catch {
    // ignore
  }
}

/* ===== ページ：通知一覧 ===== */
function NotificationsPage({
  venues,
  toggled,
  settings,
  timer2Active,
  onBack,
  onRemoveRaceKey,
  onOpenLink,
}) {
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
      const n1 = computeNotifyAt(r, settings.timer1MinutesBefore);
      const n2 = timer2Active ? computeNotifyAt(r, settings.timer2MinutesBefore) : null;

      list.push({
        raceKey: rk,
        venueName: r.venueName,
        raceNo: r.raceNo,
        title: r.title,
        closedAtHHMM: r.closedAtHHMM,
        url: r.url,
        n1,
        n2,
      });
    }
    list.sort((a, b) => {
      if (a.venueName !== b.venueName) return a.venueName.localeCompare(b.venueName, "ja");
      return (a.raceNo || 0) - (b.raceNo || 0);
    });
    return list;
  }, [selectedRaceKeys, raceMap, settings, timer2Active]);

  return (
    <main style={styles.main}>
      <section className="card">
        <div className="pageHead">
          <div className="pageTitle">通知一覧</div>
          <button className="btn" onClick={onBack}>
            戻る
          </button>
        </div>

        {rows.length === 0 ? (
          <div style={{ opacity: 0.85 }}>通知がありません。</div>
        ) : (
          <div className="notifyList">
            {rows.map((x) => (
              <div key={x.raceKey} className="notifyRow">
                <div className="notifyLeft">
                  <div className="notifyTop">
                    <div className="notifyName">
                      {x.venueName} {x.raceNo}R
                    </div>
                    <div className="notifyTitle">{x.title}</div>
                  </div>

                  <div className="notifyTimes">
                    <span className="timePill">
                      締切 <b>{x.closedAtHHMM || "--:--"}</b>
                    </span>
                    <span className="timePill">
                      通知 <b>{x.n1 ? toHHMM(x.n1) : "--:--"}</b>（{settings.timer1MinutesBefore}分前）
                    </span>
                    {timer2Active && (
                      <span className="timePill">
                        2回目 <b>{x.n2 ? toHHMM(x.n2) : "--:--"}</b>（{settings.timer2MinutesBefore}分前）
                      </span>
                    )}
                  </div>
                </div>

                <div className="notifyRight">
                  <button className="linkBtn" onClick={() => onOpenLink({ url: x.url })}>
                    開く
                  </button>
                  <button className="btn danger" onClick={() => onRemoveRaceKey(x.raceKey)}>
                    削除
                  </button>
                </div>
              </div>
            ))}
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
  // タブタイトル
  useEffect(() => {
    document.title = APP_TITLE;
  }, []);

  // anon id
  useEffect(() => {
    ensureAnonUserId();
  }, []);

  async function handleToggleNotifications(nextOn) {
  // UI状態を先に更新
  setSettings((p) => ({ ...p, notificationsEnabled: nextOn }));

  if (!nextOn) {
    // まずはOFFにするだけ（購読解除やtoken破棄は後でOK）
    setFcmToken("");
    return;
  }

  try {
    const token = await ensurePushSubscribed();
    if (!token) {
      // permission denied等
      setSettings((p) => ({ ...p, notificationsEnabled: false }));
      return;
    }
    setFcmToken(token);
  } catch (e) {
    console.error("[Push subscribe error]", e);
    setSettings((p) => ({ ...p, notificationsEnabled: false }));
    alert(`Push購読に失敗しました: ${String(e?.message || e)}`);
  }
}

  /* route */
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
  const [toggled, setToggled] = useState(() =>
    safeJsonParse(localStorage.getItem(STORAGE_TOGGLED) || "{}", {})
  );

  const [settings, setSettings] = useState(() => {
    const stored = safeJsonParse(localStorage.getItem(STORAGE_SETTINGS) || "null", null);
    return { ...DEFAULT_SETTINGS, ...(stored || {}) };
  });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Push token（debug用・将来 /devices/register に送る）
  const [fcmToken, setFcmToken] = useState("");

  // PRO状態（サーバー検証結果）
  const [proState, setProState] = useState({
    loading: false,
    verified: false, // 一度でも検証したか
    pro: false,
    maxNotifications: 10,
    timer2Allowed: false,
    adsOff: false,
    message: "",
  });

  // 時刻更新
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(t);
  }, []);

  // データ取得
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr("");

    fetchRacesJson(mode)
      .then((j) => {
        if (!alive) return;
        setVenues(normalizeToVenues(j, mode));
      })
      .catch((e) => {
        if (!alive) return;
        setErr(String(e?.message || e));
        setVenues([]);
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [mode]);

  // 永続化
  useEffect(() => {
    localStorage.setItem(STORAGE_OPEN_VENUES, JSON.stringify(openVenues));
  }, [openVenues]);
  useEffect(() => {
    localStorage.setItem(STORAGE_TOGGLED, JSON.stringify(toggled));
  }, [toggled]);
  useEffect(() => {
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
  }, [settings]);

  // foreground message（開いてる最中にPushが来た時）
  useEffect(() => {
    try {
      const unsub = onMessage(messaging, (payload) => {
        console.log("[FCM foreground message]", payload);
      });
      return () => unsub();
    } catch {
      // ignore
    }
  }, []);

  const todayLabel = useMemo(() => toYYYYMMDD(new Date()), []);
  const selectedCount = useMemo(() => Object.keys(toggled).length, [toggled]);

  // ===== PRO検証（APIでサーバー管理）=====
  const verifyTimerRef = useRef(null);

  function getApiBase() {
    return (import.meta?.env?.VITE_API_BASE || "").trim().replace(/\/$/, "");
  }

  function defaultsFromProFlag(isPro) {
    // サーバーが何も返さない時の保険
    return {
      maxNotifications: isPro ? 999 : 10,
      timer2Allowed: !!isPro,
      adsOff: !!isPro,
    };
  }

  async function verifyProCodeNow(code) {
    const apiBase = getApiBase();
    const trimmed = String(code || "").trim();

    // APIが無い/空ならFREE固定
    if (!apiBase) {
      setProState((p) => ({
        ...p,
        loading: false,
        verified: true,
        pro: false,
        ...defaultsFromProFlag(false),
        message: "API未設定のためFREE扱い",
      }));
      return;
    }

    // 空ならFREE扱い（サーバー呼ばない）
    if (!trimmed) {
      setProState((p) => ({
        ...p,
        loading: false,
        verified: true,
        pro: false,
        ...defaultsFromProFlag(false),
        message: "",
      }));
      return;
    }

    setProState((p) => ({ ...p, loading: true, message: "" }));

    const anonUserId = ensureAnonUserId();
    try {
      const res = await fetch(`${apiBase}/pro/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anon_user_id: anonUserId, pro_code: trimmed }),
      });
      if (!res.ok) throw new Error(`verify failed: ${res.status}`);

      const data = await res.json();
      const isPro = !!data?.pro;

      const df = defaultsFromProFlag(isPro);
      const maxNotifications = Number.isFinite(Number(data?.max_notifications))
        ? Number(data.max_notifications)
        : df.maxNotifications;

      const timer2Allowed =
        typeof data?.timer2_allowed === "boolean" ? data.timer2_allowed : df.timer2Allowed;
      const adsOff = typeof data?.ads_off === "boolean" ? data.ads_off : df.adsOff;

      setProState({
        loading: false,
        verified: true,
        pro: isPro,
        maxNotifications,
        timer2Allowed,
        adsOff,
        message: String(data?.message || ""),
      });

      // PRO→FREEに落ちた時、2つ目タイマーONならOFFに戻す（事故防止）
      if (!isPro) {
        setSettings((p) => ({ ...p, timer2Enabled: false }));
      }
    } catch (e) {
      console.error("[PRO verify error]", e);
      // エラー時は安全側（FREE）
      setProState((p) => ({
        ...p,
        loading: false,
        verified: true,
        pro: false,
        ...defaultsFromProFlag(false),
        message: "検証に失敗しました（FREE扱い）",
      }));
      setSettings((p) => ({ ...p, timer2Enabled: false }));
    }
  }

  // proCode入力が変わったら、少し待ってから検証（打ち終わり想定）
  useEffect(() => {
    const code = settings.proCode;

    if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
    verifyTimerRef.current = setTimeout(() => {
      verifyProCodeNow(code);
    }, 600);

    return () => {
      if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.proCode]);

  const isPro = !!proState.pro;
  const timer2Allowed = !!proState.timer2Allowed;
  const adsOff = !!proState.adsOff;
  const maxNotifications = Number(proState.maxNotifications || (isPro ? 999 : 10)) || (isPro ? 999 : 10);

  const timer2Active = isPro && timer2Allowed && !!settings.timer2Enabled;

  // ===== Push購読 =====
  async function ensurePushSubscribed() {
    if (!("serviceWorker" in navigator)) throw new Error("This browser does not support Service Worker.");
    if (!("Notification" in window)) throw new Error("This browser does not support Notification.");

    // iOS PWA 前提：ここでSW登録（同一オリジン直下）
    const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");

    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      console.log("[Push] permission not granted:", perm);
      return null;
    }

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: reg,
    });

    console.log("[FCM token]", token);
    return token;
  }

  // ★ 通知ON/OFF（ONの瞬間にトークン取得）
  async function handleToggleNotifications(nextOn) {
    setSettings((p) => ({ ...p, notificationsEnabled: nextOn }));

    if (!nextOn) {
      // 今回は「購読解除・token削除」まではやらない（段階実装）
      console.log("[Push] disabled (UI only)");
      return;
    }

    try {
      const token = await ensurePushSubscribed();
      if (!token) {
        setSettings((p) => ({ ...p, notificationsEnabled: false }));
        return;
      }
      setFcmToken(token);
    } catch (e) {
      console.error("[Push subscribe error]", e);
      setSettings((p) => ({ ...p, notificationsEnabled: false }));
      alert(`Push購読に失敗しました: ${String(e?.message || e)}`);
    }
  }

  // ===== 選択ロジック（通知上限）=====
  function canAddMoreSelections() {
    return selectedCount < maxNotifications;
  }

  function toggleVenueOpen(venueKey) {
    setOpenVenues((prev) => ({ ...prev, [venueKey]: !prev[venueKey] }));
  }

  // 会場ON/OFF（FREE上限対応：残枠分だけON）
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

      if (remaining <= 0 && Object.keys(next).length >= maxNotifications) {
        // 追加できない（枠いっぱい）
        // ここはアラートを出す/出さないは好み。最小は出す。
        alert(`通知は最大 ${maxNotifications} 件までです。`);
      }
      return next;
    });
  }

  // 個別トグル（FREE上限対応）
  function toggleRace(raceKey) {
    setToggled((prev) => {
      const next = { ...prev };

      if (next[raceKey]) {
        delete next[raceKey];
        return next;
      }

      // 追加しようとしている
      const currentCount = Object.keys(next).length;
      if (currentCount >= maxNotifications) {
        alert(`通知は最大 ${maxNotifications} 件までです。`);
        return next;
      }

      next[raceKey] = true;
      return next;
    });
  }

  function openLinkForRace(race) {
    const url = getLinkUrl(settings.linkTarget, race.url);
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
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

  // ===== 共通ヘッダー =====
  function Header({ rightHomeIcon }) {
    // rightHomeIcon: "notifications" なら☰（通知一覧へ）
    // rightHomeIcon: "home" なら⌂（HOMEへ）
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
            <button className={`chip ${mode === MODE_KEIRIN ? "chipOn" : ""}`} onClick={() => setMode(MODE_KEIRIN)}>
              競輪
            </button>
            <button className={`chip ${mode === MODE_AUTORACE ? "chipOn" : ""}`} onClick={() => setMode(MODE_AUTORACE)}>
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

        {/* 広告はnotificationsでは基本出さない（必要なら出す） */}
        <NotificationsPage
          venues={venues}
          toggled={toggled}
          settings={settings}
          timer2Active={timer2Active}
          onBack={() => setHash("home")}
          onRemoveRaceKey={removeNotification}
          onOpenLink={({ url }) => window.open(getLinkUrl(settings.linkTarget, url), "_blank", "noopener,noreferrer")}
        />

        {/* 設定（共通） */}
        {settingsOpen && (
          <SettingsModal
            onClose={() => setSettingsOpen(false)}
            settings={settings}
            setSettings={setSettings}
            isPro={isPro}
            proState={proState}
            maxNotifications={maxNotifications}
            timer2Allowed={timer2Allowed}
            selectedCount={selectedCount}
            setToggled={setToggled}
            fcmToken={fcmToken}
            handleToggleNotifications={handleToggleNotifications} // ★これを追加
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

      {/* 広告：header外、mainの上（崩れにくい） */}
      {!adsOff && (
        <div style={styles.main}>
          <div className="adBar">
            <div className="adText">スポンサー枠（有料コードで非表示）</div>
            <div className="adSub">ここに告知やバナーを入れる想定</div>
          </div>
        </div>
      )}

      <main style={styles.main}>
        {loading && <div className="card">読み込み中…</div>}

        {!loading && err && (
          <div className="card error">
            <div style={{ fontWeight: 700 }}>読み込み失敗</div>
            <div style={{ opacity: 0.9, marginTop: 6 }}>{err}</div>
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
                    <button className="smallBtn on" onClick={() => setVenueAll(v, true)} title="この会場をまとめてON">
                      ON
                    </button>
                    <button className="smallBtn off" onClick={() => setVenueAll(v, false)} title="この会場をまとめてOFF">
                      OFF
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="raceList">
                    {v.races.map((r) => {
                      const closedAt = parseHHMMToday(r.closedAtHHMM);

                      const n1 = computeNotifyAt(r, settings.timer1MinutesBefore);
                      const n2 = timer2Active ? computeNotifyAt(r, settings.timer2MinutesBefore) : null;

                      const past1 = n1 ? now.getTime() >= n1.getTime() : false;
                      const past2 = n2 ? now.getTime() >= n2.getTime() : false;

                      const ended = closedAt ? now.getTime() >= closedAt.getTime() : false;
                      const checked = !!toggled[r.raceKey];

                      return (
                        <div key={r.raceKey} className={`raceRow ${ended ? "ended" : ""}`}>
                          <div className="raceLeft">
                            <div className="raceTopLine">
                              <div className="raceNo">{r.raceNo}R</div>
                              <div className="raceTitle">{r.title}</div>
                              <button className="linkBtn" onClick={() => openLinkForRace(r)}>
                                開く
                              </button>
                            </div>

                            <div className="raceTimeLine">
                              <span className="timePill">
                                締切 <b>{closedAt ? toHHMM(closedAt) : "--:--"}</b>
                              </span>

                              <span className={`timePill ${past1 ? "timePast" : ""}`}>
                                通知 <b>{n1 ? toHHMM(n1) : "--:--"}</b>（{settings.timer1MinutesBefore}分前）
                              </span>

                              {timer2Active && (
                                <span className={`timePill ${past2 ? "timePast" : ""}`}>
                                  2回目 <b>{n2 ? toHHMM(n2) : "--:--"}</b>（{settings.timer2MinutesBefore}分前）
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="raceRight">
                            <div className="toggleWrap">
                              <label className="toggle" title={checked ? "通知ON" : "通知OFF"}>
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

      {/* 設定（共通） */}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          setSettings={setSettings}
          isPro={isPro}
          proState={proState}
          maxNotifications={maxNotifications}
          timer2Allowed={timer2Allowed}
          selectedCount={selectedCount}
          setToggled={setToggled}
          fcmToken={fcmToken}
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
  isPro,
  proState,
  maxNotifications,
  timer2Allowed,
  selectedCount,
  setToggled,
  fcmToken,
  handleToggleNotifications,
}) {
  const canUseTimer2 = isPro && timer2Allowed;

  return (
    <div className="modalBack" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modalHead">
          <div className="modalTitle">設定</div>
          <button className="iconBtn" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>

        <div className="modalBody">
          {/* Push通知 */}
          <div className="row">
            <div className="label">Push通知</div>

            <div className="fieldBox">
              <label className="switchLine" style={{ justifyContent: "space-between" }}>
                <div className="switchWrap" aria-label="push-switch">
                  <input
                    type="checkbox"
                    checked={!!settings.notificationsEnabled}
                    onChange={(e) => handleToggleNotifications(e.target.checked)}
                  />
                  <span className="switchUi" />
                </div>

                <span className="switchText">{settings.notificationsEnabled ? "ON" : "OFF"}</span>
              </label>

              <div className="note">
                ※ONにすると許可ダイアログが出るので必ず許可してください。なお
                <a
                  className="link"
                  href="https://mt.qui2.net/attention.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  iPhoneはホーム画面追加しないと通知できません
                </a>
                。
              </div>
            </div>
          </div>

          {/* 1つ目タイマー（旧：通知①（分前）） */}
          <div className="row">
            <div className="label">1つ目タイマー</div>

            <div className="fieldBox">
              <select
                value={settings.timer1MinutesBefore}
                onChange={(e) =>
                  setSettings((p) => ({ ...p, timer1MinutesBefore: Number(e.target.value) }))
                }
              >
                {[5, 4, 3, 2, 1].map((m) => (
                  <option key={m} value={m}>
                    {m} 分前
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 2つ目タイマー（スイッチ化 + PRO案内を通常フォントで） */}
          <div className="row">
            <div className="label">2つ目タイマー</div>

            <div className="fieldBox">
              <label
                className="switchLine"
                style={{ justifyContent: "space-between", opacity: canUseTimer2 ? 1 : 0.55 }}
              >
                <div className="switchWrap" aria-label="timer2-switch">
                  <input
                    type="checkbox"
                    checked={!!settings.timer2Enabled}
                    onChange={(e) => setSettings((p) => ({ ...p, timer2Enabled: e.target.checked }))}
                    disabled={!canUseTimer2}
                  />
                  <span className="switchUi" />
                </div>

                <span className="switchText">{settings.timer2Enabled ? "ON" : "OFF"}</span>
              </label>

              {!canUseTimer2 && <div className="note">PRO版で解放</div>}
            </div>
          </div>

          {/* 通知②（分前） */}
          <div className="row">
            <div className="label">2回目（分前）</div>

            <div className="fieldBox">
              <select
                value={settings.timer2MinutesBefore}
                disabled={!canUseTimer2 || !settings.timer2Enabled}
                onChange={(e) =>
                  setSettings((p) => ({ ...p, timer2MinutesBefore: Number(e.target.value) }))
                }
              >
                {[5, 4, 3, 2, 1].map((m) => (
                  <option key={m} value={m}>
                    {m} 分前
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 通知タップ先 */}
          <div className="row">
            <div className="label">通知タップ先</div>
            <div className="fieldBox">
              <select
                value={settings.linkTarget}
                onChange={(e) => setSettings((p) => ({ ...p, linkTarget: e.target.value }))}
              >
                <option value="json">ネット競輪（レース情報）</option>
                <option value="oddspark">オッズパーク</option>
                <option value="chariloto">チャリロト</option>
                <option value="winticket">WINTICKET</option>
                <option value="dmm">DMM競輪</option>
              </select>
            </div>
          </div>

          {/* 有料コード（期間文を追加） */}
          <div className="row">
            <div className="label">有料コード</div>

            <div className="fieldBox">
              <input
                value={settings.proCode || ""}
                onChange={(e) => setSettings((p) => ({ ...p, proCode: e.target.value }))}
                placeholder="コードを入力"
              />

              <div className="note">
                期間：登録日から月末まで（20日を過ぎてからの登録は翌々月の月末まで）
              </div>

              {proState?.verified && proState?.message ? (
                <div className="note" style={{ opacity: 0.85 }}>
                  {proState.message}
                </div>
              ) : null}
            </div>
          </div>

          {/* 通知上限 */}
          <div className="row">
            <div className="label">通知上限</div>
            <div className="fieldBox">
              <div style={{ fontSize: 14, opacity: 0.9 }}>
                現在：{selectedCount} 件 / 上限：{maxNotifications} 件
              </div>
            </div>
          </div>

          {/* 選択のリセット */}
          <div className="row">
            <div className="label">選択のリセット</div>
            <div className="fieldBox">
              <button className="btn danger" onClick={() => setToggled({})}>
                すべて解除
              </button>
              <div className="note">現在の通知数：{selectedCount}</div>
            </div>
          </div>

          {/* デバッグ表示（必要なら後で消す） */}
          {fcmToken ? (
            <div className="row">
              <div className="label">FCM token（debug）</div>
              <div className="fieldBox">
                <div style={{ fontSize: 12, wordBreak: "break-all", opacity: 0.9 }}>{fcmToken}</div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="modalFoot">
          <button className="btn" onClick={onClose}>
            閉じる
          </button>
        </div>

        {/* SettingsModal専用の最小CSS（既存CSSに追加してOK） */}
        <style>{`
          .fieldBox{ grid-column: 2 / 3; display: grid; gap: 8px; }
          .note{ font-size: 12px; opacity: .75; line-height: 1.45; }
          .link{ color: inherit; text-decoration: underline; text-underline-offset: 3px; }

          .switchWrap{ position: relative; width: 54px; height: 30px; }
          .switchWrap input{
            position:absolute; inset:0;
            width:100%; height:100%;
            opacity:0; margin:0;
            cursor:pointer;
            z-index:2;
          }
          .switchUi{
            position:absolute; inset:0;
            border-radius:999px;
            background: rgba(0,0,0,0.16);
            border: 1px solid rgba(0,0,0,0.10);
            transition: .15s;
          }
          .switchUi:before{
            content:"";
            position:absolute;
            width: 22px; height: 22px;
            border-radius:50%;
            top: 3px; left: 3px;
            background:#fff;
            box-shadow: 0 4px 14px rgba(0,0,0,0.16);
            transition: .15s;
          }
          .switchWrap input:checked + .switchUi{
            background: rgba(46,125,50,0.55);
            border-color: rgba(46,125,50,0.25);
          }
          .switchWrap input:checked + .switchUi:before{
            transform: translateX(24px);
          }
          .switchText{ font-weight: 600; opacity: .9; }

          .switchLine{
            display:flex;
            align-items:center;
            gap: 10px;
            user-select:none;
          }
        `}</style>
      </div>
    </div>
  );
}


/* ===== style ===== */
const styles = {
  page: {
    minHeight: "100vh",
    background: "#F6F7F3", // ほんのりアイボリー
    color: "#111",
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans JP", "Hiragino Sans", Arial, sans-serif',
    fontWeight: 400,
  },

  header: {
    position: "sticky",
    top: 0,
    zIndex: 5,
    backdropFilter: "blur(10px)",
    background: "rgba(246,247,243,0.90)", // page背景に合わせる
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    padding: "12px 12px 10px",
  },

  headerTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },

  titleRow: { display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 },
  title: { fontSize: 18, fontWeight: 900, letterSpacing: 0.2, whiteSpace: "nowrap" },
  dateInline: { fontSize: 12, fontWeight: 700, opacity: 0.7, whiteSpace: "nowrap" },

  // ヘッダー右は「設定」「一覧」だけ置く想定（通知は設定へ）
  rightHead: { display: "flex", alignItems: "center", gap: 10, flexWrap: "nowrap" },

  modeRow: { marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 },
  modeSwitch: { display: "flex", gap: 8, flexWrap: "wrap" },

  main: {
    padding: 14,
    maxWidth: 820,
    margin: "0 auto",
    display: "grid",
    gap: 12,
  },
};

const cssText = `
/* --- theme tokens --- */
:root{
  --bg: #F6F7F3;
  --card: #FFFFFF;
  --ink: #111111;

  /* ネイティブ寄りの緑（トグルONなど） */
  --accent: #2E6F3E;      /* 深緑 */
  --accent2: #E6F1E7;     /* 薄緑 */
  --border: rgba(0,0,0,0.08);
  --shadow: 0 10px 22px rgba(0,0,0,0.06);
}

/* --- base --- */
*{ box-sizing: border-box; }
html, body{ background: var(--bg); }
button, input, select{ font: inherit; }
select, input{
  border: 1px solid rgba(0,0,0,0.12);
  border-radius: 14px;
  padding: 10px 12px;
  background: #fff;
}
select{ cursor:pointer; }
input{ width: 100%; }

.card{
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 18px;
  box-shadow: var(--shadow);
  padding: 12px;
}
.card.error{
  border-color: rgba(220,0,0,0.20);
  background: rgba(255,240,240,0.92);
}

/* --- chips --- */
.chip{
  border: 1px solid rgba(0,0,0,0.10);
  background: rgba(255,255,255,0.95);
  padding: 10px 14px;
  border-radius: 999px;
  cursor: pointer;
  font-weight: 900;
  white-space: nowrap;
}
.chipOn{
  border-color: rgba(46,111,62,0.28);
  background: var(--accent2);
}

/* --- icon buttons --- */
.iconBtn{
  border: 1px solid rgba(0,0,0,0.10);
  background: rgba(255,255,255,0.95);
  width: 48px;
  height: 48px;
  border-radius: 16px;
  cursor: pointer;
  font-weight: 900;
  font-size: 20px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* --- buttons --- */
.btn{
  border: 1px solid rgba(0,0,0,0.12);
  background: #fff;
  padding: 10px 14px;
  border-radius: 14px;
  cursor: pointer;
  font-weight: 900;
}
.btn.danger{
  border-color: rgba(220,0,0,0.22);
  background: rgba(255,240,240,0.9);
}
.linkBtn{
  border: 1px solid rgba(0,0,0,0.12);
  background: rgba(0,0,0,0.03);
  padding: 8px 12px;
  border-radius: 999px;
  cursor: pointer;
  font-weight: 900;
  white-space: nowrap;
}

/* --- ad --- */
.adBar{
  border: 1px dashed rgba(0,0,0,0.14);
  background: rgba(0,0,0,0.02);
  border-radius: 16px;
  padding: 10px 12px;
}
.adText{ font-weight: 900; }
.adSub{ font-size: 12px; opacity: 0.75; margin-top: 2px; }

/* --- mini switch (push on/off) --- */
.miniSwitch{
  display:flex;
  align-items:center;
  gap: 10px;
  user-select:none;
  cursor:pointer;
  flex: 0 0 auto;
}
.miniSwitch input{ display:none; }
.miniLabel{
  font-weight: 900;
  opacity: 0.9;
  white-space: nowrap;
}
.miniSlider{
  width: 44px;
  height: 26px;
  border-radius: 999px;
  background: rgba(0,0,0,0.18);
  border: 1px solid rgba(0,0,0,0.10);
  position: relative;
  transition: .15s;
}
.miniSlider:before{
  content:"";
  position:absolute;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  top: 2px;
  left: 2px;
  background: #fff;
  box-shadow: 0 4px 12px rgba(0,0,0,0.16);
  transition: .15s;
}
.miniSwitch input:checked + .miniSlider{
  background: var(--accent);
  border-color: rgba(46,111,62,0.30);
}
.miniSwitch input:checked + .miniSlider:before{
  transform: translateX(18px);
}

/* --- tiny meta --- */
.tinyMeta{
  display:flex;
  align-items:center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.tinyCount{
  font-size: 12px;
  opacity: 0.7;
  white-space: nowrap;
}

/* --- pill --- */
.pill{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid rgba(0,0,0,0.12);
  font-weight: 900;
  font-size: 12px;
  white-space: nowrap;
}
.pillOn{
  background: var(--accent2);
  border-color: rgba(46,111,62,0.25);
}
.pillOff{
  background: rgba(0,0,0,0.02);
  opacity: 0.9;
}

/* --- venue --- */
.venueHead{
  display:flex;
  align-items:center;
  justify-content: space-between;
  gap: 10px;
  cursor: pointer;
}
.venueTitle{
  display:flex;
  align-items:center;
  gap: 10px;
  min-width: 0;
}
.venueName{
  font-weight: 900;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 46vw;
}
.chev{ opacity: 0.7; }
.grade{
  font-size: 12px;
  border: 1px solid rgba(0,0,0,0.12);
  border-radius: 999px;
  padding: 4px 8px;
  opacity: 0.8;
  white-space: nowrap;
}
.venueActions{ display:flex; gap: 8px; flex: 0 0 auto; }
.smallBtn{
  border: 1px solid rgba(0,0,0,0.12);
  background: #fff;
  padding: 8px 10px;
  border-radius: 12px;
  cursor:pointer;
  font-weight: 900;
}
.smallBtn.on{ background: var(--accent2); border-color: rgba(46,111,62,0.25); }
.smallBtn.off{ background: rgba(0,0,0,0.02); }

/* --- races --- */
.raceList{ margin-top: 10px; display:grid; gap: 10px; }
.raceRow{
  display:flex;
  gap: 10px;
  align-items: stretch;
  border: 1px solid rgba(0,0,0,0.08);
  background: rgba(255,255,255,0.75);
  border-radius: 16px;
  padding: 10px;
}
.raceRow.ended{
  opacity: 0.50;
  filter: grayscale(20%);
}
.raceLeft{ flex: 1 1 auto; min-width: 0; }
.raceRight{ flex: 0 0 auto; display:flex; align-items:center; }
.raceTopLine{
  display:flex;
  align-items:center;
  gap: 10px;
}
.raceNo{
  font-weight: 900;
  white-space: nowrap;
}
.raceTitle{
  font-weight: 800;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.raceTimeLine{
  margin-top: 8px;
  display:flex;
  gap: 8px;
  flex-wrap: wrap;
}
.timePill{
  border: 1px solid rgba(0,0,0,0.10);
  background: rgba(255,255,255,0.92);
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  white-space: nowrap;
}
.timePast{
  opacity: 0.6;
}

/* --- toggle --- */
.toggleWrap{ padding-left: 6px; }
.toggle{ position: relative; display:inline-block; width: 54px; height: 32px; }
.toggle input{ display:none; }
.slider{
  position:absolute; cursor:pointer; inset:0;
  background: rgba(0,0,0,0.18);
  border: 1px solid rgba(0,0,0,0.10);
  transition: .15s;
  border-radius: 999px;
}
.slider:before{
  content:"";
  position:absolute;
  height: 24px; width: 24px;
  left: 3px; top: 3px;
  background: #fff;
  transition: .15s;
  border-radius: 999px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.16);
}
.toggle input:checked + .slider{
  background: var(--accent);
  border-color: rgba(46,111,62,0.30);
}
.toggle input:checked + .slider:before{ transform: translateX(22px); }

/* --- settings helpers (Pro note 1行) --- */
.proNote{
  font-weight: 900;
  opacity: 0.55;
  margin-left: 6px;
  white-space: nowrap;
}

/* --- notifications page --- */
.pageHead{
  display:flex;
  align-items:center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.pageTitle{ font-size: 16px; font-weight: 900; }
.notifyList{ display:grid; gap: 10px; }
.notifyRow{
  display:flex;
  align-items: stretch;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid rgba(0,0,0,0.08);
  background: rgba(255,255,255,0.75);
  border-radius: 16px;
  padding: 10px;
}
.notifyLeft{ flex: 1 1 auto; min-width: 0; }
.notifyTop{ display:flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.notifyName{ font-weight: 900; white-space: nowrap; }
.notifyTitle{ font-weight: 800; min-width: 0; overflow:hidden; text-overflow: ellipsis; white-space: nowrap; }
.notifyTimes{ margin-top: 8px; display:flex; gap: 8px; flex-wrap: wrap; }
.notifyRight{ display:flex; gap: 8px; align-items:center; flex: 0 0 auto; }

/* --- modal --- */
.modalBack{
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.35);
  display:flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 50;
}
.modal{
  width: min(720px, 100%);
  background: #fff;
  border-radius: 20px;
  border: 1px solid rgba(0,0,0,0.10);
  box-shadow: 0 18px 40px rgba(0,0,0,0.22);
  overflow: hidden;
}
.modalHead{
  display:flex;
  align-items:center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 12px;
  border-bottom: 1px solid rgba(0,0,0,0.06);
}
.modalTitle{ font-weight: 900; }
.modalBody{
  padding: 12px;
  display:grid;
  gap: 10px;
}
.modalFoot{
  padding: 12px;
  border-top: 1px solid rgba(0,0,0,0.06);
  display:flex;
  justify-content: flex-end;
}
.row{
  display:grid;
  grid-template-columns: 160px 1fr;
  gap: 10px;
  align-items: center;
}
.label{
  font-size: 13px;
  font-weight: 900;
  opacity: 0.80;
}
.switchLine{
  display:flex;
  align-items:center;
  gap: 10px;
  font-weight: 900;
}
@media (max-width: 560px){
  .row{ grid-template-columns: 1fr; }
  .venueName{ max-width: 58vw; }
}

/* 設定：右側カラムの入れ物 */
.pushBox{
  display:flex;
  flex-direction:column;
  gap:10px;
  width:100%;
}

/* スイッチ（モーダル用） */
.switchLine{
  display:flex;
  align-items:center;
  gap:12px;
  user-select:none;
}
.switchLine input{ display:none; }

.switchUi{
  width: 56px;
  height: 32px;
  border-radius: 999px;
  background: rgba(0,0,0,0.16);
  border: 1px solid rgba(0,0,0,0.10);
  position: relative;
  transition: .15s;
  flex: 0 0 auto;
}
.switchUi:before{
  content:"";
  position:absolute;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  top: 2px;
  left: 2px;
  background: #fff;
  box-shadow: 0 4px 14px rgba(0,0,0,0.16);
  transition: .15s;
}

.switchLine input:checked + .switchUi{
  background: rgba(46,125,50,0.55);
  border-color: rgba(46,125,50,0.25);
}
.switchLine input:checked + .switchUi:before{
  transform: translateX(24px);
}

.switchText{
  font-weight:600;
  opacity:0.9;
}

/* 注意書き */
.note{
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.85;
}

.note .link{
  text-decoration: underline;
}


`;

