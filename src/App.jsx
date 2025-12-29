import React, { useEffect, useMemo, useState } from "react";

/**
 * もふタイマー Web（最小・全部入り）
 * - Vite + React
 * - GitHub Pages: base "/mt/"
 * - 当日のみ（GitHub Pages上のJSON）
 * - 会場アコーディオン + レース行トグル（1つ）
 * - 設定で「2つ目タイマーON」なら 2回分の通知時刻を表示（同一トグル）
 */

const APP_TITLE = "もふタイマー";
const BASE = "https://keirinjingle.github.io";

const MODE_KEIRIN = "keirin";
const MODE_AUTORACE = "autorace";

const MINUTE_OPTIONS = [5, 4, 3, 2, 1];

const STORAGE_USER_ID = "mofu_anon_user_id";
const STORAGE_OPEN_VENUES = "mofu_open_venues_v1";
const STORAGE_TOGGLED = "mofu_race_toggled_v1";
const STORAGE_SETTINGS = "mofu_settings_v2";

const DEFAULT_SETTINGS = {
  timer1MinutesBefore: 5,
  timer2Enabled: false, // ✅ 2つ目ON/OFF
  timer2MinutesBefore: 2,
  linkTarget: "json",
  proCode: "",
};

// 通知タップ先（今は「開く」ボタンに反映）
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

function pad2(n) {
  return String(n).padStart(2, "0");
}
function todayKeyYYYYMMDD() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
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
 *  { venue, grade, races:[{ race_number, start_time, closed_at, url, class_category... }...] },
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

  // ✅ closed_at を堅く拾う（表記ゆれ吸収）
  const closedAtHHMM =
    r.closed_at || r.closedAt || r.close_at || r.closeAt || r.deadline || r.shimekiri || "";

  const url = r.url || r.raceUrl || "";
  const title = r.class_category || r.title || r.name || `${raceNo}R`;

  const date = todayKeyYYYYMMDD();
  const raceKey = `${date}_${venueKey}_${pad2(raceNo)}`;

  return { raceKey, venueKey, venueName, raceNo, title, closedAtHHMM, url };
}

// ✅ closed_at（締切）から minutesBefore 分前を計算
function computeNotifyAt(race, minutesBefore) {
  const closed = parseHHMMToday(race.closedAtHHMM);
  const m = Number(minutesBefore);
  if (!closed || !Number.isFinite(m)) return null;
  return addMinutes(closed, -m);
}

export default function App() {
  useEffect(() => {
    ensureAnonUserId();
  }, []);

  const [mode, setMode] = useState(MODE_KEIRIN);
  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [openVenues, setOpenVenues] = useState(() =>
    safeJsonParse(localStorage.getItem(STORAGE_OPEN_VENUES) || "{}", {})
  );

  // ✅ レースのトグルは1つだけ
  const [toggled, setToggled] = useState(() =>
    safeJsonParse(localStorage.getItem(STORAGE_TOGGLED) || "{}", {})
  );

  // ✅ デフォルト設定を確実にマージ（NaN防止）
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

  const todayLabel = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }, []);

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

  // 表示用カウント（1つだけ）
  const selectedCount = useMemo(() => Object.keys(toggled).length, [toggled]);

  return (
    <div style={styles.page}>
      <style>{cssText}</style>

      <header style={styles.header}>
        <div style={styles.headerTop}>
          <div style={styles.title}>{APP_TITLE}</div>

          <div style={styles.rightHead}>
            <button className="iconBtn" onClick={() => setSettingsOpen(true)} aria-label="settings">
              ⚙︎
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
          <div style={styles.date}>{todayLabel}（当日のみ）</div>
          <div className="counts">
            <span className="countPill">🔔 {selectedCount}</span>
            <span className={`countPill ${timer2Active ? "countOn" : "countOff"}`}>
              2nd {timer2Active ? "ON" : "OFF"}
            </span>
          </div>
        </div>
      </header>

      <main style={styles.main}>
        {loading && <div className="card">読み込み中…</div>}

        {!loading && err && (
          <div className="card error">
            <div style={{ fontWeight: 800 }}>読み込み失敗</div>
            <div style={{ opacity: 0.9, marginTop: 6 }}>{err}</div>
          </div>
        )}

        {!loading && !err && venues.length === 0 && (
          <div className="card">今日のデータがありません。</div>
        )}

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
                    <span className="badge">
                      🔔 {venueSelectedCount}/{v.races.length}
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

                      const n1 = computeNotifyAt(r, settings.timer1MinutesBefore);
                      const past1 = n1 ? now.getTime() >= n1.getTime() : false;

                      const n2 = timer2Active
                        ? computeNotifyAt(r, settings.timer2MinutesBefore)
                        : null;
                      const past2 = timer2Active && n2 ? now.getTime() >= n2.getTime() : false;

                      // ✅ レースは「締切（closed_at）」を過ぎたらグレーアウト（Flutterに近い）
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

                              {!timer2Active && (
                                <span className="timePill timeLocked">
                                  2回目 OFF（設定でON）
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
                  {isPro ? "PRO：2つ目が使える" : "FREE：1つだけ"}
                </div>
              </div>

              <div className="row">
                <div className="label">選択のリセット</div>
                <button className="btn danger" onClick={() => setToggled({})}>
                  すべて解除
                </button>
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
 * 目安：
 * - タイトル/会場名/選択中チップ：600
 * - 通常ボタン/ピル/バッジ：500
 * - 通常テキスト：400
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

/* チップ：通常は500、選択中だけ600 */
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

.iconBtn{
  border: 1px solid rgba(0,0,0,0.10);
  background: rgba(255,255,255,0.80);
  width: 40px;
  height: 40px;
  border-radius: 14px;
  cursor: pointer;
  font-weight: 600;
}

.counts{ display:flex; gap: 8px; }
.countPill{
  font-size: 12px;
  font-weight: 600;
  padding: 7px 12px;
  border-radius: 999px;
  background: rgba(46,125,50,0.12);
  border: 1px solid rgba(46,125,50,0.12);
}
.countPill.countOff{
  background: rgba(0,0,0,0.05);
  border-color: rgba(0,0,0,0.05);
  color: rgba(0,0,0,0.55);
  font-weight: 500;
}
.countPill.countOn{
  background: rgba(46,125,50,0.18);
  border-color: rgba(46,125,50,0.18);
}

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

/* レース番号だけ少し強く（Flutterのlabel感） */
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
.timeLocked{
  background: rgba(0,0,0,0.05);
  border-color: rgba(0,0,0,0.05);
  color: rgba(0,0,0,0.55);
  font-weight: 500;
}

.raceRight{ display:flex; align-items:center; }

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
@media (max-width: 560px){
  .row{ grid-template-columns: 1fr; }
  .pill{ grid-column: auto; }
}
`;
