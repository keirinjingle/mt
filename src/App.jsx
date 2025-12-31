import React, { useEffect, useMemo, useState } from "react";
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
 * - ヘッダーに通知ON/OFF
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
const STORAGE_SETTINGS = "mofu_settings_v3";

const DEFAULT_SETTINGS = {
  timer1MinutesBefore: 5,
  timer2Enabled: false,
  timer2MinutesBefore: 2,
  linkTarget: "json",
  proCode: "",
  notificationsEnabled: false, // ★追加：通知ON/OFF（Push購読）
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
  mode,
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
  useEffect(() => {
    ensureAnonUserId();
  }, []);

  // ★ Push購読（通知ON時に呼ぶ）
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

  const [toggled, setToggled] = useState(() => safeJsonParse(localStorage.getItem(STORAGE_TOGGLED) || "{}", {}));

  const [settings, setSettings] = useState(() => {
    const stored = safeJsonParse(localStorage.getItem(STORAGE_SETTINGS) || "null", null);
    return { ...DEFAULT_SETTINGS, ...(stored || {}) };
  });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // ★ 取得したtoken（今は表示しないが、後で /api/devices/register 等に送る用）
  const [fcmToken, setFcmToken] = useState("");

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(t);
  }, []);

  const isPro = !!(settings.proCode && String(settings.proCode).trim().length > 0);
  const timer2Active = isPro && !!settings.timer2Enabled;

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

  function toggleVenueOpen(venueKey) {
    setOpenVenues((prev) => ({ ...prev, [venueKey]: !prev[venueKey] }));
  }

  function setVenueAll(venue, on) {
    setToggled((prev) => {
      const next = { ...prev };
      for (const r of venue.races) {
        if (on) next[r.raceKey] = true;
        else delete next[r.raceKey];
      }
      return next;
    });
  }

  function toggleRace(raceKey) {
    setToggled((prev) => {
      const next = { ...prev };
      if (next[raceKey]) delete next[raceKey];
      else next[raceKey] = true;
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
        // permission denied 等
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

  // ===== route: notifications =====
  if (route === "notifications") {
    return (
      <div style={styles.page}>
        <style>{cssText}</style>

        <header style={styles.header}>
          <div style={styles.headerTop}>
            <div style={styles.titleRow}>
              <div style={styles.title}>
                {APP_TITLE} <span style={{ opacity: 0.9 }}>🐾</span>
              </div>
              <div style={styles.dateInline}>{todayLabel}</div>
            </div>

            <div style={styles.rightHead}>
              {/* 通知ON/OFF */}
              <label className="miniSwitch" title="通知（Push）をON/OFF">
                <span className="miniLabel">通知</span>
                <input
                  type="checkbox"
                  checked={!!settings.notificationsEnabled}
                  onChange={(e) => handleToggleNotifications(e.target.checked)}
                />
                <span className="miniSlider" />
              </label>

              <button className="iconBtn" onClick={() => setSettingsOpen(true)} aria-label="settings">
                ⚙︎
              </button>

              {/* ここは「通知一覧」表示中なので、HOMEへ戻す */}
              <button className="iconBtn" onClick={() => setHash("home")} aria-label="home">
                ⌂
              </button>
            </div>
          </div>

          <div style={styles.modeRow}>
            <div style={styles.modeSwitch}>
              <button className={`chip ${mode === MODE_KEIRIN ? "chipOn" : ""}`} onClick={() => setMode(MODE_KEIRIN)}>
                競輪
              </button>
              <button
                className={`chip ${mode === MODE_AUTORACE ? "chipOn" : ""}`}
                onClick={() => setMode(MODE_AUTORACE)}
              >
                オート
              </button>
            </div>
          </div>
        </header>

        <NotificationsPage
          mode={mode}
          venues={venues}
          toggled={toggled}
          settings={settings}
          timer2Active={timer2Active}
          onBack={() => setHash("home")}
          onRemoveRaceKey={removeNotification}
          onOpenLink={({ url }) => window.open(getLinkUrl(settings.linkTarget, url), "_blank", "noopener,noreferrer")}
        />

        {/* 設定画面（共通） */}
        {settingsOpen && (
          <div className="modalBack" onClick={() => setSettingsOpen(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modalHead">
                <div className="modalTitle">設定</div>
                <button className="iconBtn" onClick={() => setSettingsOpen(false)}>
                  ✕
                </button>
              </div>

              <div className="modalBody">
                <div className="row">
                  <div className="label">通知①（分前）</div>
                  <select
                    value={settings.timer1MinutesBefore}
                    onChange={(e) => setSettings((p) => ({ ...p, timer1MinutesBefore: Number(e.target.value) }))}
                  >
                    {MINUTE_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m} 分前
                      </option>
                    ))}
                  </select>
                </div>

                <div className="row">
                  <div className="label">2つ目タイマー</div>
                  <label className="switchLine">
                    <input
                      type="checkbox"
                      checked={!!settings.timer2Enabled}
                      onChange={(e) => setSettings((p) => ({ ...p, timer2Enabled: e.target.checked }))}
                      disabled={!isPro}
                    />
                    <span>{isPro ? "ON/OFF" : "有料コードで解放"}</span>
                  </label>
                </div>

                <div className="row">
                  <div className="label">通知②（分前）</div>
                  <select
                    value={settings.timer2MinutesBefore}
                    disabled={!isPro || !settings.timer2Enabled}
                    onChange={(e) => setSettings((p) => ({ ...p, timer2MinutesBefore: Number(e.target.value) }))}
                  >
                    {MINUTE_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m} 分前
                      </option>
                    ))}
                  </select>
                </div>

                <div className="row">
                  <div className="label">通知タップ先</div>
                  <select value={settings.linkTarget} onChange={(e) => setSettings((p) => ({ ...p, linkTarget: e.target.value }))}>
                    {LINK_TARGETS.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="row">
                  <div className="label">有料コード（ゆる判定）</div>
                  <input
                    value={settings.proCode || ""}
                    onChange={(e) => setSettings((p) => ({ ...p, proCode: e.target.value }))}
                    placeholder="コードを入力（空なら無料）"
                  />
                  <div className={`pill ${isPro ? "pillOn" : "pillOff"}`}>
                    {isPro ? "PRO：広告OFF / 2回目可" : "FREE：広告ON / 1回目のみ"}
                  </div>
                </div>

                <div className="row">
                  <div className="label">選択のリセット</div>
                  <button className="btn danger" onClick={() => setToggled({})}>
                    すべて解除
                  </button>
                  <div style={{ gridColumn: "2 / 3", fontSize: 12, opacity: 0.8 }}>現在の通知数：{selectedCount}</div>
                </div>

                {/* デバッグ表示（必要なら後で消す） */}
                {fcmToken ? (
                  <div className="row">
                    <div className="label">FCM token（debug）</div>
                    <div style={{ fontSize: 12, wordBreak: "break-all", opacity: 0.9 }}>{fcmToken}</div>
                  </div>
                ) : null}
              </div>

              <div className="modalFoot">
                <button className="btn" onClick={() => setSettingsOpen(false)}>
                  閉じる
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ===== route: home =====
  return (
    <div style={styles.page}>
      <style>{cssText}</style>

      <header style={styles.header}>
        <div style={styles.headerTop}>
          <div style={styles.title}>
            {APP_TITLE} <span style={{ opacity: 0.9 }}>🐾</span>
          </div>

          <div style={styles.rightHead}>
            {/* 通知ON/OFF */}
            <label className="miniSwitch" title="通知（Push）をON/OFF">
              <span className="miniLabel">通知</span>
              <input
                type="checkbox"
                checked={!!settings.notificationsEnabled}
                onChange={(e) => handleToggleNotifications(e.target.checked)}
              />
              <span className="miniSlider" />
            </label>

            <button className="iconBtn bigIcon" onClick={() => setSettingsOpen(true)} aria-label="settings">
              ⚙︎
            </button>

            <button className="iconBtn bigIcon" onClick={() => setHash("notifications")} aria-label="notifications">
              ☰
            </button>

            <div style={styles.modeSwitch}>
              <button className={`chip ${mode === MODE_KEIRIN ? "chipOn" : ""}`} onClick={() => setMode(MODE_KEIRIN)}>
                競輪
              </button>
              <button className={`chip ${mode === MODE_AUTORACE ? "chipOn" : ""}`} onClick={() => setMode(MODE_AUTORACE)}>
                オート
              </button>
            </div>
          </div>
        </div>

        <div style={styles.subRow}>
          <div style={styles.date}>{todayLabel}</div>
        </div>

        {!isPro && (
          <div className="adBar">
            <div className="adText">スポンサー枠（有料コードで非表示）</div>
            <div className="adSub">ここに告知やバナーを入れる想定</div>
          </div>
        )}
      </header>

      <main style={styles.main}>
        {loading && <div className="card">読み込み中…</div>}

        {!loading && err && (
          <div className="card error">
            <div style={{ fontWeight: 600 }}>読み込み失敗</div>
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
                    <span>{v.venueName}</span>
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

      {/* ===== 設定画面 ===== */}
      {settingsOpen && (
        <div className="modalBack" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHead">
              <div className="modalTitle">設定</div>
              <button className="iconBtn" onClick={() => setSettingsOpen(false)}>
                ✕
              </button>
            </div>

            <div className="modalBody">
              <div className="row">
                <div className="label">通知①（分前）</div>
                <select
                  value={settings.timer1MinutesBefore}
                  onChange={(e) => setSettings((p) => ({ ...p, timer1MinutesBefore: Number(e.target.value) }))}
                >
                  {MINUTE_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} 分前
                    </option>
                  ))}
                </select>
              </div>

              <div className="row">
                <div className="label">2つ目タイマー</div>
                <label className="switchLine">
                  <input
                    type="checkbox"
                    checked={!!settings.timer2Enabled}
                    onChange={(e) => setSettings((p) => ({ ...p, timer2Enabled: e.target.checked }))}
                    disabled={!isPro}
                  />
                  <span>{isPro ? "ON/OFF" : "有料コードで解放"}</span>
                </label>
              </div>

              <div className="row">
                <div className="label">通知②（分前）</div>
                <select
                  value={settings.timer2MinutesBefore}
                  disabled={!isPro || !settings.timer2Enabled}
                  onChange={(e) => setSettings((p) => ({ ...p, timer2MinutesBefore: Number(e.target.value) }))}
                >
                  {MINUTE_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} 分前
                    </option>
                  ))}
                </select>
              </div>

              <div className="row">
                <div className="label">通知タップ先</div>
                <select value={settings.linkTarget} onChange={(e) => setSettings((p) => ({ ...p, linkTarget: e.target.value }))}>
                  {LINK_TARGETS.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="row">
                <div className="label">有料コード（ゆる判定）</div>
                <input
                  value={settings.proCode || ""}
                  onChange={(e) => setSettings((p) => ({ ...p, proCode: e.target.value }))}
                  placeholder="コードを入力（空なら無料）"
                />
                <div className={`pill ${isPro ? "pillOn" : "pillOff"}`}>
                  {isPro ? "PRO：広告OFF / 2回目可" : "FREE：広告ON / 1回目のみ"}
                </div>
              </div>

              <div className="row">
                <div className="label">選択のリセット</div>
                <button className="btn danger" onClick={() => setToggled({})}>
                  すべて解除
                </button>
                <div style={{ gridColumn: "2 / 3", fontSize: 12, opacity: 0.8 }}>現在の通知数：{selectedCount}</div>
              </div>

              {fcmToken ? (
                <div className="row">
                  <div className="label">FCM token（debug）</div>
                  <div style={{ fontSize: 12, wordBreak: "break-all", opacity: 0.9 }}>{fcmToken}</div>
                </div>
              ) : null}
            </div>

            <div className="modalFoot">
              <button className="btn" onClick={() => setSettingsOpen(false)}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ===== style ===== */
const styles = {
  titleRow: { display: "flex", alignItems: "baseline", gap: 10 },
  dateInline: { fontSize: 13, fontWeight: 500, opacity: 0.85 },
  modeRow: { marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" },

  page: {
    minHeight: "100vh",
    background:
      "linear-gradient(180deg, rgba(232,245,233,1) 0%, rgba(241,248,242,1) 45%, rgba(255,255,255,1) 100%)",
    color: "#102014",
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans JP", "Hiragino Sans", Arial, sans-serif',
    fontWeight: 400,
  },
  header: {
    position: "sticky",
    top: 0,
    zIndex: 5,
    backdropFilter: "blur(10px)",
    background: "rgba(232,245,233,0.80)",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    padding: "14px 14px 10px",
  },
  headerTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  title: { fontSize: 18, fontWeight: 600, letterSpacing: 0.2 },
  rightHead: { display: "flex", alignItems: "center", gap: 10 },
  modeSwitch: { display: "flex", gap: 8 },
  subRow: {
    marginTop: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    fontSize: 12,
    opacity: 0.92,
  },
  main: {
    padding: 14,
    maxWidth: 820,
    margin: "0 auto",
    display: "grid",
    gap: 12,
  },
  date: { fontWeight: 500 },
};

const cssText = `
.card{
  background: rgba(255,255,255,0.92);
  border: 1px solid rgba(0,0,0,0.06);
  border-radius: 18px;
  box-shadow: 0 10px 28px rgba(0,0,0,0.06);
  padding: 12px;
}
.card.error{
  border-color: rgba(220,0,0,0.2);
  background: rgba(255,240,240,0.92);
}

/* チップ */
.chip{
  border: 1px solid rgba(0,0,0,0.10);
  background: rgba(255,255,255,0.80);
  padding: 9px 14px;
  border-radius: 999px;
  cursor: pointer;
  font-weight: 500;
}
.chipOn{
  border-color: rgba(46,125,50,0.25);
  background: rgba(46,125,50,0.14);
  font-weight: 600;
}

/* アイコンボタン（48x48に統一） */
.iconBtn{
  border: 1px solid rgba(0,0,0,0.10);
  background: rgba(255,255,255,0.80);
  width: 48px;
  height: 48px;
  border-radius: 16px;
  cursor: pointer;
  font-weight: 600;
  font-size: 20px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.iconBtn.bigIcon{
  width: 48px;
  height: 48px;
  border-radius: 16px;
  font-size: 16px;
}

/* 広告枠 */
.adBar{
  margin-top: 10px;
  border: 1px dashed rgba(46,125,50,0.25);
  background: rgba(46,125,50,0.08);
  border-radius: 16px;
  padding: 10px 12px;
}
.adText{ font-weight: 600; }
.adSub{ font-size: 12px; opacity: 0.8; margin-top: 2px; }

/* 右上：通知ON/OFF */
.miniSwitch{
  display:flex;
  align-items:center;
  gap: 10px;
  user-select:none;
  cursor:pointer;
}
.miniSwitch input{ display:none; }
.miniSlider{
  width: 44px;
  height: 26px;
  border-radius: 999px;
  background: rgba(0,0,0,0.16);
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
  box-shadow: 0 4px 14px rgba(0,0,0,0.16);
  transition: .15s;
}
.miniSwitch input:checked + .miniSlider{
  background: rgba(46,125,50,0.55);
  border-color: rgba(46,125,50,0.25);
}
.miniSwitch input:checked + .miniSlider:before{
  transform: translateX(18px);
}
.miniLabel{
  font-weight: 600;
  opacity: 0.9;
}

/* 以下、元のCSS（会場/行/モーダル等）は既存のままでOK想定
   ※あなたの元ファイルが長いので、ここから下は “元の続き” をそのまま残してください。
*/
`;
