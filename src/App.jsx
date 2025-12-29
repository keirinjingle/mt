import React, { useEffect, useMemo, useState } from "react";

/**
 * もふタイマー Web（最小・全部入り / 1ファイル）
 * - Vite + React
 * - GitHub Pages: base "/mt/"
 * - 当日のみ（GitHub Pages上のJSON）
 * - 会場アコーディオン + レース行トグル（1つ）
 * - 設定で「2つ目タイマーON」なら 2回分の通知を鳴らす（同一トグル）
 *
 * 追加（今回）:
 * - Hash Routing: #notifications で通知一覧ページ
 * - 通知一覧から削除（localStorage更新 + 可能ならサーバーへ通知）
 * - ヘッダーから通知数表示を削除し、通知ON/OFFを配置
 * - 設定ボタンを他と同じサイズに + 隣に通知一覧リンク
 * - タイトルに🐾 + 日付表示（「当日のみ」削除）
 * - ベル/2nd表示を削除し、広告枠（有料コードで非表示）
 * - アコーディオン内「2回目 OFF...」文言削除
 */

const APP_TITLE = "もふタイマー";
const BASE = "https://keirinjingle.github.io";

const MODE_KEIRIN = "keirin";
const MODE_AUTORACE = "autorace";

/* ===== Hash routing（GitHub Pages向け）===== */
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
const STORAGE_SETTINGS = "mofu_settings_v3"; // ★ v3 に更新

const DEFAULT_SETTINGS = {
  notificationsEnabled: true, // ★ 追加：全体ON/OFF（ヘッダーで切替）
  timer1MinutesBefore: 5,
  timer2Enabled: false, // 2つ目ON/OFF（有料＆設定で有効化）
  timer2MinutesBefore: 2,
  linkTarget: "json",
  proCode: "",
};

/* 通知タップ先（今は「開く」ボタンに反映） */
const LINK_TARGETS = [
  { key: "json", label: "ネット競輪（JSON内のURL）" },
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

/**
 * raw = [
 *  { venue, grade, races:[{ race_number, closed_at, url, class_category... }...] },
 *  ...
 * ]
 */
function normalizeToVenues(raw, mode) {
  if (Array.isArray(raw) && raw.length > 0 && raw[0] && Array.isArray(raw[0].races)) {
    return raw.map((v) => {
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

  // closed_at を堅く拾う（表記ゆれ吸収）
  const closedAtHHMM =
    r.closed_at || r.closedAt || r.close_at || r.closeAt || r.deadline || r.shimekiri || "";

  const url = r.url || r.raceUrl || "";
  const title = r.class_category || r.title || r.name || `${raceNo}R`;

  const date = todayKeyYYYYMMDD();
  const raceKey = `${date}_${venueKey}_${pad2(raceNo)}`;

  return { raceKey, venueKey, venueName, raceNo, title, closedAtHHMM, url };
}

/* closed_at（締切）から minutesBefore 分前を計算 */
function computeNotifyAt(race, minutesBefore) {
  const closed = parseHHMMToday(race.closedAtHHMM);
  const m = Number(minutesBefore);
  if (!closed || !Number.isFinite(m)) return null;
  return addMinutes(closed, -m);
}

/**
 * 「通知削除」をサーバーにも知らせたい場合のフック（任意）
 * - VITE_API_BASE が設定されていれば POST する
 * - 失敗しても UI は壊さない（ローカル削除が正）
 */
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
    // 失敗しても無視（GitHub Pages運用でも困らない）
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
  // venue/race 参照できる辞書を作る
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
      const n1 = settings.notificationsEnabled ? computeNotifyAt(r, settings.timer1MinutesBefore) : null;
      const n2 =
        settings.notificationsEnabled && timer2Active
          ? computeNotifyAt(r, settings.timer2MinutesBefore)
          : null;

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
    // 会場→R順（わかりやすさ）
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

  // レースのトグルは1つだけ
  const [toggled, setToggled] = useState(() =>
    safeJsonParse(localStorage.getItem(STORAGE_TOGGLED) || "{}", {})
  );

  // デフォルト設定を確実にマージ（NaN防止）
  const [settings, setSettings] = useState(() => {
    const stored = safeJsonParse(localStorage.getItem(STORAGE_SETTINGS) || "null", null);
    return { ...DEFAULT_SETTINGS, ...(stored || {}) };
  });

  const [settingsOpen, setSettingsOpen] = useState(false);

  // now（グレーアウト更新）
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(t);
  }, []);

  // pro判定（ゆるく：コードが入ってれば有料扱い）
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

  const todayLabel = useMemo(() => toYYYYMMDD(new Date()), []);

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
    // ローカルから外す
    setToggled((prev) => {
      const next = { ...prev };
      delete next[raceKey];
      return next;
    });

    // 可能ならサーバーにも通知
    const anonUserId = ensureAnonUserId();
    await trySendRemoveToServer({ anonUserId, raceKey });
  }

  // 表示用カウント（※ヘッダーでは表示しない／通知一覧用にだけ残す）
  const selectedCount = useMemo(() => Object.keys(toggled).length, [toggled]);

  // ===== route: notifications =====
  if (route === "notifications") {
    return (
      <div style={styles.page}>
        <style>{cssText}</style>

        <header style={styles.header}>
          <div style={styles.headerTop}>
            <div style={styles.title}>
              {APP_TITLE} <span style={{ opacity: 0.9 }}>🐾</span>
            </div>

            <div style={styles.rightHead}>
              <button className="iconBtn" onClick={() => setHash("home")} aria-label="home">
                ←
              </button>

              <div style={styles.modeSwitch}>
                <button
                  className={`chip ${mode === MODE_KEIRIN ? "chipOn" : ""}`}
                  onClick={() => setMode(MODE_KEIRIN)}
                >
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
          </div>

          <div style={styles.subRow}>
            <div style={styles.date}>{todayLabel}</div>

            {/* ヘッダー：通知ON/OFF（縦幅を取らない） */}
            <label className="miniSwitch" title="通知 全体ON/OFF">
              <input
                type="checkbox"
                checked={!!settings.notificationsEnabled}
                onChange={(e) => setSettings((p) => ({ ...p, notificationsEnabled: e.target.checked }))}
              />
              <span className="miniSlider" />
              <span className="miniLabel">{settings.notificationsEnabled ? "通知ON" : "通知OFF"}</span>
            </label>
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
            {/* アイコンを他と同じサイズに（48） */}
            <button className="iconBtn bigIcon" onClick={() => setSettingsOpen(true)} aria-label="settings">
              ⚙︎
            </button>

            {/* 通知一覧リンク（隣） */}
            <button className="iconBtn bigIcon" onClick={() => setHash("notifications")} aria-label="notifications">
              ☰
            </button>

            <div style={styles.modeSwitch}>
              <button
                className={`chip ${mode === MODE_KEIRIN ? "chipOn" : ""}`}
                onClick={() => setMode(MODE_KEIRIN)}
              >
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
        </div>

        <div style={styles.subRow}>
          {/* 日付のみ（「当日のみ」削除） */}
          <div style={styles.date}>{todayLabel}</div>

          {/* 通知ON/OFFをここへ（ベル数表示は削除） */}
          <label className="miniSwitch" title="通知 全体ON/OFF">
            <input
              type="checkbox"
              checked={!!settings.notificationsEnabled}
              onChange={(e) => setSettings((p) => ({ ...p, notificationsEnabled: e.target.checked }))}
            />
            <span className="miniSlider" />
            <span className="miniLabel">{settings.notificationsEnabled ? "通知ON" : "通知OFF"}</span>
          </label>
        </div>

        {/* 広告枠：有料コードで消える */}
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

            const venueSelectedCount = v.races.reduce(
              (acc, r) => acc + (toggled[r.raceKey] ? 1 : 0),
              0
            );

            return (
              <section className="card" key={v.venueKey}>
                <div className="venueHead" onClick={() => toggleVenueOpen(v.venueKey)}>
                  <div className="venueTitle">
                    <span className="chev">{isOpen ? "▼" : "▶"}</span>
                    <span>{v.venueName}</span>
                    {v.grade ? <span className="grade">{v.grade}</span> : null}
                  </div>

                  <div className="venueMeta">
                    {/* ベルは外す（数だけ） */}
                    <span className="badge">
                      {venueSelectedCount}/{v.races.length}
                    </span>
                  </div>
                </div>

                <div className="venueControls">
                  <button className="btn" onClick={() => setVenueAll(v, true)}>
                    すべてON
                  </button>
                  <button className="btn ghost" onClick={() => setVenueAll(v, false)}>
                    すべてOFF
                  </button>
                </div>

                {isOpen && (
                  <div className="raceList">
                    {v.races.map((r) => {
                      const closedAt = parseHHMMToday(r.closedAtHHMM);

                      // 通知計算：通知OFFなら表示も null
                      const n1 =
                        settings.notificationsEnabled ? computeNotifyAt(r, settings.timer1MinutesBefore) : null;

                      const n2 =
                        settings.notificationsEnabled && timer2Active
                          ? computeNotifyAt(r, settings.timer2MinutesBefore)
                          : null;

                      // 「通知時刻を過ぎたら」薄くする（通知① 기준）
                      const past1 = n1 ? now.getTime() >= n1.getTime() : false;
                      const past2 = n2 ? now.getTime() >= n2.getTime() : false;

                      // 締切を過ぎたらグレーアウト
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

                              {/* 2回目：ONのときだけ表示（OFF文言は削除） */}
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
                <div className="label">通知 全体</div>
                <label className="switchLine">
                  <input
                    type="checkbox"
                    checked={!!settings.notificationsEnabled}
                    onChange={(e) =>
                      setSettings((p) => ({ ...p, notificationsEnabled: e.target.checked }))
                    }
                  />
                  <span>{settings.notificationsEnabled ? "ON" : "OFF"}</span>
                </label>
              </div>

              <div className="row">
                <div className="label">通知①（分前）</div>
                <select
                  value={settings.timer1MinutesBefore}
                  onChange={(e) =>
                    setSettings((p) => ({ ...p, timer1MinutesBefore: Number(e.target.value) }))
                  }
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
                  onChange={(e) =>
                    setSettings((p) => ({ ...p, timer2MinutesBefore: Number(e.target.value) }))
                  }
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
                <select
                  value={settings.linkTarget}
                  onChange={(e) => setSettings((p) => ({ ...p, linkTarget: e.target.value }))}
                >
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
                <div style={{ gridColumn: "2 / 3", fontSize: 12, opacity: 0.8 }}>
                  現在の通知数：{selectedCount}
                </div>
              </div>
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

/**
 * Flutter(Material3, green seed)っぽい見た目に寄せる（太字を抑える）
 */
const styles = {
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
  width: 40px;
  height: 40px;
  border-radius: 14px;
  cursor: pointer;
  font-weight: 600;
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

/* 右上：通知ON/OFF（縦幅取らない） */
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

/* 会場 */
.venueHead{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap: 10px;
  cursor:pointer;
  padding: 6px 6px 10px;
}
.venueTitle{
  display:flex;
  align-items:center;
  gap: 10px;
  font-weight: 600;
  font-size: 18px;
}
.grade{
  font-size: 12px;
  font-weight: 500;
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(46,125,50,0.10);
  border: 1px solid rgba(46,125,50,0.10);
  opacity: 0.9;
}
.chev{ width: 22px; display:inline-flex; justify-content:center; opacity:0.7; }
.venueMeta{ display:flex; gap: 8px; }
.badge{
  font-size: 12px;
  font-weight: 600;
  padding: 7px 12px;
  border-radius: 999px;
  background: rgba(46,125,50,0.12);
  border: 1px solid rgba(46,125,50,0.12);
}

.venueControls{
  display:flex;
  gap: 10px;
  align-items:center;
  padding: 0 6px 12px;
  flex-wrap: wrap;
}

.btn{
  border: 1px solid rgba(0,0,0,0.10);
  background: rgba(255,255,255,0.80);
  padding: 10px 12px;
  border-radius: 14px;
  cursor: pointer;
  font-weight: 500;
}
.btn.ghost{ background: rgba(0,0,0,0.02); }
.btn.danger{
  border-color: rgba(220,0,0,0.2);
  background: rgba(255,230,230,0.85);
  font-weight: 600;
}

/* レース */
.raceList{ display:grid; gap: 10px; padding: 0 6px 6px; }

.raceRow{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap: 12px;
  padding: 12px 12px;
  border-radius: 18px;
  border: 1px solid rgba(0,0,0,0.06);
  background: rgba(255,255,255,0.88);
}
.raceRow.ended{
  opacity: 0.45;
}

.raceLeft{ min-width: 0; flex: 1; }
.raceTopLine{ display:flex; align-items:center; gap: 12px; }
.raceNo{ font-weight: 600; font-size: 18px; }
.raceTitle{ font-size: 14px; opacity: 0.88; font-weight: 400; }

.linkBtn{
  margin-left: auto;
  border: 1px solid rgba(0,0,0,0.10);
  background: rgba(255,255,255,0.85);
  padding: 8px 12px;
  border-radius: 999px;
  cursor: pointer;
  font-weight: 600;
  font-size: 12px;
}

.raceTimeLine{
  display:flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.timePill{
  font-size: 12px;
  font-weight: 500;
  padding: 7px 12px;
  border-radius: 999px;
  background: rgba(46,125,50,0.10);
  border: 1px solid rgba(46,125,50,0.10);
}
.timePast{ opacity: 0.55; }

/* Toggle */
.toggleWrap{ display:flex; align-items:center; }
.toggle{
  position: relative;
  display: inline-block;
  width: 52px;
  height: 32px;
}
.toggle input{ display:none; }
.slider{
  position:absolute;
  cursor:pointer;
  inset:0;
  background: rgba(0,0,0,0.16);
  border-radius: 999px;
  transition: 0.15s;
}
.slider:before{
  content:"";
  position:absolute;
  height: 26px;
  width: 26px;
  left: 3px;
  top: 3px;
  background: white;
  border-radius: 50%;
  box-shadow: 0 4px 14px rgba(0,0,0,0.18);
  transition: 0.15s;
}
.toggle input:checked + .slider{ background: rgba(46,125,50,0.55); }
.toggle input:checked + .slider:before{ transform: translateX(20px); }
.toggle input:disabled + .slider{ cursor:not-allowed; opacity: 0.8; }

/* Modal */
.modalBack{
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.25);
  display:flex;
  align-items:center;
  justify-content:center;
  padding: 16px;
  z-index: 50;
}
.modal{
  width: min(720px, 100%);
  background: rgba(255,255,255,0.98);
  border: 1px solid rgba(0,0,0,0.10);
  border-radius: 20px;
  box-shadow: 0 18px 60px rgba(0,0,0,0.18);
  overflow:hidden;
}
.modalHead{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding: 12px 12px;
  border-bottom: 1px solid rgba(0,0,0,0.08);
  background: rgba(232,245,233,0.75);
}
.modalTitle{ font-weight: 600; font-size: 14px; }
.modalBody{ padding: 12px; display:grid; gap: 12px; }
.modalFoot{ padding: 12px; border-top: 1px solid rgba(0,0,0,0.08); display:flex; justify-content:flex-end; }

.row{
  display:grid;
  grid-template-columns: 180px 1fr;
  gap: 10px;
  align-items:center;
}
.label{ font-weight: 500; font-size: 12px; opacity: 0.9; }
select, input{
  border: 1px solid rgba(0,0,0,0.12);
  background: rgba(255,255,255,0.92);
  padding: 10px 12px;
  border-radius: 14px;
  font-weight: 400;
  outline: none;
}
.switchLine{
  display:flex;
  align-items:center;
  gap: 10px;
  font-weight: 500;
}
.switchLine input{
  width: 18px;
  height: 18px;
}

/* PRO pill */
.pill{
  grid-column: 2 / 3;
  width: fit-content;
  font-size: 12px;
  font-weight: 500;
  padding: 7px 12px;
  border-radius: 999px;
  border: 1px solid rgba(0,0,0,0.08);
}
.pillOn{
  background: rgba(46,125,50,0.14);
  border-color: rgba(46,125,50,0.18);
  font-weight: 600;
}
.pillOff{
  background: rgba(0,0,0,0.04);
  color: rgba(0,0,0,0.55);
}

/* Notifications page */
.pageHead{ display:flex; align-items:center; justify-content:space-between; gap: 12px; margin-bottom: 10px; }
.pageTitle{ font-weight: 600; font-size: 16px; }
.notifyList{ display:grid; gap: 10px; }
.notifyRow{
  display:flex;
  justify-content:space-between;
  gap: 12px;
  border: 1px solid rgba(0,0,0,0.06);
  background: rgba(255,255,255,0.88);
  border-radius: 16px;
  padding: 12px;
}
.notifyLeft{ min-width: 0; flex: 1; }
.notifyTop{ display:flex; align-items:baseline; gap: 10px; flex-wrap: wrap; }
.notifyName{ font-weight: 600; }
.notifyTitle{ font-size: 12px; opacity: 0.85; }
.notifyTimes{ display:flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.notifyRight{ display:flex; align-items:center; gap: 10px; }

@media (max-width: 560px){
  .row{ grid-template-columns: 1fr; }
  .pill{ grid-column: auto; }
  .notifyRow{ flex-direction: column; }
  .notifyRight{ justify-content: flex-end; }
}
`;
