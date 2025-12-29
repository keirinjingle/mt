import React, { useEffect, useMemo, useState } from "react";

/**
 * =========================
 *  もふタイマー（最小・全部入り）
 *  - 会場アコーディオン
 *  - レースごとトグル（Timer① / Timer②）
 *  - 設定画面（無料1 / 有料2、5/4/3/2/1分前、通知タップ先URL）
 *  - start_time から通知時刻を逆算（closed_atは保険）
 * =========================
 */

// ---- 設定
const APP_TITLE = "もふタイマー";
const BASE = "https://keirinjingle.github.io";

const MODE_KEIRIN = "keirin";
const MODE_AUTORACE = "autorace";

const MINUTE_OPTIONS = [5, 4, 3, 2, 1];

const STORAGE_USER_ID = "mofu_anon_user_id";
const STORAGE_OPEN_VENUES = "mofu_open_venues_v1";

// Timer①/② の選択状態（レースキーごと）
const STORAGE_T1 = "mofu_timer1_selected_v1"; // { [raceKey]: true }
const STORAGE_T2 = "mofu_timer2_selected_v1"; // { [raceKey]: true }

// 設定
const STORAGE_SETTINGS = "mofu_settings_v1";
// { timer1MinutesBefore: 5, timer2MinutesBefore: 2, linkTarget: "json", proCode: "xxxx" }

// ---- 通知タップ先の候補
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

// ---- Utils
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

// ---- Fetch
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
 *  { venue, grade, races:[{ race_number, start_time, closed_at, url, class_category, players... }...] },
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

  const startTimeHHMM = r.start_time || r.startTime || r.start || "";
  const closedAtHHMM = r.closed_at || r.closedAt || ""; // 保険（5分前固定など）

  const url = r.url || r.raceUrl || "";
  const title = r.class_category || r.title || r.name || `${raceNo}R`;

  const date = todayKeyYYYYMMDD();
  const raceKey = `${date}_${venueKey}_${pad2(raceNo)}`;

  return { raceKey, venueKey, venueName, raceNo, title, startTimeHHMM, closedAtHHMM, url };
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

  const [t1, setT1] = useState(() =>
    safeJsonParse(localStorage.getItem(STORAGE_T1) || "{}", {})
  );
  const [t2, setT2] = useState(() =>
    safeJsonParse(localStorage.getItem(STORAGE_T2) || "{}", {})
  );

  const [settings, setSettings] = useState(() =>
    safeJsonParse(localStorage.getItem(STORAGE_SETTINGS) || "{}", {
      timer1MinutesBefore: 5,
      timer2MinutesBefore: 2,
      linkTarget: "json",
      proCode: "",
    })
  );

  // 設定画面の開閉（簡易）
  const [settingsOpen, setSettingsOpen] = useState(false);

  // now（グレーアウト更新）
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(t);
  }, []);

  // pro判定（ゆるく：コードが入ってれば有料扱い）
  const isPro = !!(settings.proCode && String(settings.proCode).trim().length > 0);

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
    localStorage.setItem(STORAGE_T1, JSON.stringify(t1));
  }, [t1]);
  useEffect(() => {
    localStorage.setItem(STORAGE_T2, JSON.stringify(t2));
  }, [t2]);
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

  function setVenueAll(venue, timerIndex, on) {
    if (timerIndex === 1) {
      setT1((prev) => {
        const next = { ...prev };
        for (const r of venue.races) {
          if (on) next[r.raceKey] = true;
          else delete next[r.raceKey];
        }
        return next;
      });
      return;
    }
    if (timerIndex === 2) {
      setT2((prev) => {
        const next = { ...prev };
        for (const r of venue.races) {
          if (on) next[r.raceKey] = true;
          else delete next[r.raceKey];
        }
        return next;
      });
    }
  }

  function toggleRace(timerIndex, raceKey) {
    if (timerIndex === 1) {
      setT1((prev) => {
        const next = { ...prev };
        if (next[raceKey]) delete next[raceKey];
        else next[raceKey] = true;
        return next;
      });
      return;
    }
    if (timerIndex === 2) {
      setT2((prev) => {
        const next = { ...prev };
        if (next[raceKey]) delete next[raceKey];
        else next[raceKey] = true;
        return next;
      });
    }
  }

  // start_time があればそこから逆算、無ければ closed_at を使う
  function computeNotifyAt(race, minutesBefore) {
    const start = parseHHMMToday(race.startTimeHHMM);
    if (start) return addMinutes(start, -minutesBefore);

    const closed = parseHHMMToday(race.closedAtHHMM);
    if (closed) return closed; // フォールバック（JSONがすでに5分前など）
    return null;
  }

  function openLinkForRace(race) {
    const url = getLinkUrl(settings.linkTarget, race.url);
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // 表示用カウント
  const t1Count = useMemo(() => Object.keys(t1).length, [t1]);
  const t2Count = useMemo(() => Object.keys(t2).length, [t2]);

  return (
    <div style={styles.page}>
      <style>{cssText}</style>

      <header style={styles.header}>
        <div style={styles.headerTop}>
          <div style={styles.title}>{APP_TITLE}</div>

          <div style={styles.rightHead}>
            <button className="iconBtn" onClick={() => setSettingsOpen(true)}>
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
            <span className="countPill">① {t1Count}</span>
            <span className={`countPill ${isPro ? "" : "locked"}`}>
              ② {isPro ? t2Count : "LOCK"}
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

            const t1SelectedCount = v.races.reduce((acc, r) => acc + (t1[r.raceKey] ? 1 : 0), 0);
            const t2SelectedCount = v.races.reduce((acc, r) => acc + (t2[r.raceKey] ? 1 : 0), 0);

            return (
              <section className="card" key={v.venueKey}>
                <div className="venueHead" onClick={() => toggleVenueOpen(v.venueKey)}>
                  <div className="venueTitle">
                    <span className="chev">{isOpen ? "▼" : "▶"}</span>
                    <span>{v.venueName}</span>
                    {v.grade ? <span className="grade">{v.grade}</span> : null}
                  </div>

                  <div className="venueMeta">
                    <span className="badge">① {t1SelectedCount}/{v.races.length}</span>
                    <span className={`badge ${isPro ? "" : "badgeLocked"}`}>
                      ② {isPro ? `${t2SelectedCount}/${v.races.length}` : "LOCK"}
                    </span>
                  </div>
                </div>

                <div className="venueControls">
                  <button className="btn" onClick={() => setVenueAll(v, 1, true)}>
                    ① 全ON
                  </button>
                  <button className="btn ghost" onClick={() => setVenueAll(v, 1, false)}>
                    ① 全OFF
                  </button>

                  <div className="sep" />

                  <button
                    className={`btn ${isPro ? "" : "btnLocked"}`}
                    onClick={() => isPro && setVenueAll(v, 2, true)}
                    title={isPro ? "" : "有料ロック中"}
                  >
                    ② 全ON
                  </button>
                  <button
                    className={`btn ghost ${isPro ? "" : "btnLocked"}`}
                    onClick={() => isPro && setVenueAll(v, 2, false)}
                    title={isPro ? "" : "有料ロック中"}
                  >
                    ② 全OFF
                  </button>
                </div>

                {isOpen && (
                  <div className="raceList">
                    {v.races.map((r) => {
                      const n1 = computeNotifyAt(r, settings.timer1MinutesBefore);
                      const past1 = n1 ? now.getTime() >= n1.getTime() : false;

                      const n2 = isPro ? computeNotifyAt(r, settings.timer2MinutesBefore) : null;
                      const past2 = isPro && n2 ? now.getTime() >= n2.getTime() : false;

                      const checked1 = !!t1[r.raceKey];
                      const checked2 = !!t2[r.raceKey];

                      return (
                        <div key={r.raceKey} className={`raceRow ${past1 && past2 ? "past" : ""}`}>
                          <div className="raceLeft">
                            <div className="raceTopLine">
                              <div className="raceNo">{r.raceNo}R</div>
                              <div className="raceTitle">{r.title}</div>
                              <button className="linkBtn" onClick={() => openLinkForRace(r)}>
                                開く
                              </button>
                            </div>

                            <div className="raceTimeLine">
                              <span className={`timePill ${past1 ? "timePast" : ""}`}>
                                ① 締切 <b>{n1 ? toHHMM(n1) : "--:--"}</b>（{settings.timer1MinutesBefore}分前）
                              </span>

                              <span className={`timePill ${isPro ? "" : "timeLocked"} ${past2 ? "timePast" : ""}`}>
                                ② 締切{" "}
                                <b>{isPro ? (n2 ? toHHMM(n2) : "--:--") : "LOCK"}</b>
                                {isPro ? `（${settings.timer2MinutesBefore}分前）` : ""}
                              </span>
                            </div>
                          </div>

                          <div className="raceRight">
                            <div className="toggles">
                              <div className={`toggleWrap ${past1 ? "togglePast" : ""}`}>
                                <div className="toggleLabel">①</div>
                                <label className="toggle">
                                  <input
                                    type="checkbox"
                                    checked={checked1}
                                    onChange={() => toggleRace(1, r.raceKey)}
                                    disabled={past1}
                                  />
                                  <span className="slider" />
                                </label>
                              </div>

                              <div className={`toggleWrap ${isPro ? "" : "toggleLocked"} ${past2 ? "togglePast" : ""}`}>
                                <div className="toggleLabel">②</div>
                                <label className="toggle">
                                  <input
                                    type="checkbox"
                                    checked={checked2}
                                    onChange={() => toggleRace(2, r.raceKey)}
                                    disabled={!isPro || past2}
                                  />
                                  <span className="slider" />
                                </label>
                              </div>
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

      <footer style={styles.footer}>
        <div style={{ opacity: 0.85 }}>
          ※ 次は「通知の実装（Web Push / ネイティブ連携）」に進めます
        </div>
      </footer>

      {/* ===== 設定画面（簡易モーダル） ===== */}
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
                <div className="label">タイマー①（無料）</div>
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
                <div className="label">タイマー②（有料）</div>
                <select
                  value={settings.timer2MinutesBefore}
                  disabled={!isPro}
                  onChange={(e) =>
                    setSettings((p) => ({ ...p, timer2MinutesBefore: Number(e.target.value) }))
                  }
                  title={isPro ? "" : "有料ロック中"}
                >
                  {MINUTE_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} 分前
                    </option>
                  ))}
                </select>
                {!isPro && <div className="hint">※ 有料コードを入れると有効</div>}
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
                  {isPro ? "PRO：②タイマー有効" : "FREE：①のみ"}
                </div>
              </div>

              <div className="row">
                <div className="label">選択のリセット</div>
                <button
                  className="btn danger"
                  onClick={() => {
                    setT1({});
                    setT2({});
                  }}
                >
                  ①② を全解除
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
 * =========================
 *  Styles
 * =========================
 */
const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #eef9f2 0%, #f7fbf8 50%, #ffffff 100%)",
    color: "#123",
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", Segoe UI, Roboto, Arial',
  },
  header: {
    position: "sticky",
    top: 0,
    zIndex: 5,
    backdropFilter: "blur(10px)",
    background: "rgba(238, 249, 242, 0.75)",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    padding: "14px 14px 10px",
  },
  headerTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  title: { fontSize: 18, fontWeight: 900, letterSpacing: 0.2 },
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
    maxWidth: 780,
    margin: "0 auto",
    display: "grid",
    gap: 12,
  },
  footer: {
    padding: 20,
    textAlign: "center",
    fontSize: 12,
    color: "rgba(0,0,0,0.55)",
  },
};

const cssText = `
.card{
  background: rgba(255,255,255,0.92);
  border: 1px solid rgba(0,0,0,0.06);
  border-radius: 16px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.05);
  padding: 12px;
}
.card.error{
  border-color: rgba(220,0,0,0.2);
  background: rgba(255,240,240,0.92);
}

.chip{
  border: 1px solid rgba(0,0,0,0.10);
  background: rgba(255,255,255,0.75);
  padding: 8px 12px;
  border-radius: 999px;
  cursor: pointer;
  font-weight: 800;
}
.chipOn{
  border-color: rgba(0,120,70,0.25);
  background: rgba(140, 230, 170, 0.26);
}

.iconBtn{
  border: 1px solid rgba(0,0,0,0.10);
  background: rgba(255,255,255,0.75);
  width: 36px;
  height: 36px;
  border-radius: 12px;
  cursor: pointer;
  font-weight: 900;
}

.counts{ display:flex; gap: 8px; }
.countPill{
  font-size: 12px;
  font-weight: 900;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(0, 120, 70, 0.12);
  border: 1px solid rgba(0, 120, 70, 0.12);
}
.countPill.locked{
  background: rgba(0,0,0,0.06);
  border-color: rgba(0,0,0,0.06);
  color: rgba(0,0,0,0.45);
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
  gap: 8px;
  font-weight: 900;
}
.grade{
  font-size: 12px;
  font-weight: 900;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(0, 120, 70, 0.10);
  border: 1px solid rgba(0, 120, 70, 0.10);
  opacity: 0.9;
}
.chev{ width: 20px; display:inline-flex; justify-content:center; opacity:0.7; }
.venueMeta{ display:flex; gap: 8px; }
.badge{
  font-size: 12px;
  font-weight: 900;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(0, 120, 70, 0.12);
  border: 1px solid rgba(0, 120, 70, 0.12);
}
.badgeLocked{
  background: rgba(0,0,0,0.06);
  border-color: rgba(0,0,0,0.06);
  color: rgba(0,0,0,0.45);
}

.venueControls{
  display:flex;
  gap: 8px;
  align-items:center;
  padding: 0 6px 10px;
  flex-wrap: wrap;
}
.sep{ width: 1px; height: 24px; background: rgba(0,0,0,0.08); margin: 0 4px; }

.btn{
  border: 1px solid rgba(0,0,0,0.10);
  background: rgba(255,255,255,0.75);
  padding: 8px 10px;
  border-radius: 12px;
  cursor: pointer;
  font-weight: 900;
}
.btn.ghost{ background: rgba(0,0,0,0.02); }
.btnLocked{ opacity: 0.45; cursor: not-allowed; }
.btn.danger{
  border-color: rgba(220,0,0,0.2);
  background: rgba(255,230,230,0.8);
}

.raceList{ display:grid; gap: 8px; padding: 0 6px 6px; }

.raceRow{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap: 10px;
  padding: 10px 10px;
  border-radius: 14px;
  border: 1px solid rgba(0,0,0,0.06);
  background: rgba(255,255,255,0.82);
}
.raceRow.past{ opacity: 0.55; }

.raceLeft{ min-width: 0; flex: 1; }
.raceTopLine{ display:flex; align-items:center; gap: 10px; }
.raceNo{ font-weight: 900; font-size: 14px; }
.raceTitle{ font-size: 12px; opacity: 0.88; }
.linkBtn{
  margin-left: auto;
  border: 1px solid rgba(0,0,0,0.10);
  background: rgba(255,255,255,0.75);
  padding: 6px 10px;
  border-radius: 999px;
  cursor: pointer;
  font-weight: 900;
  font-size: 12px;
}

.raceTimeLine{
  display:flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.timePill{
  font-size: 12px;
  font-weight: 900;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(0, 120, 70, 0.10);
  border: 1px solid rgba(0, 120, 70, 0.10);
}
.timePast{ opacity: 0.55; }
.timeLocked{
  background: rgba(0,0,0,0.06);
  border-color: rgba(0,0,0,0.06);
  color: rgba(0,0,0,0.45);
}

.raceRight{ display:flex; align-items:center; }
.toggles{ display:flex; gap: 10px; }
.toggleWrap{ display:flex; align-items:center; gap: 6px; }
.toggleLocked{ opacity: 0.45; }
.togglePast{ opacity: 0.55; }

.toggleLabel{
  width: 18px;
  text-align:center;
  font-weight: 900;
  font-size: 12px;
  opacity: 0.9;
}

.toggle{
  position: relative;
  display: inline-block;
  width: 46px;
  height: 28px;
}
.toggle input{ display:none; }
.slider{
  position:absolute;
  cursor:pointer;
  inset:0;
  background: rgba(0,0,0,0.12);
  border-radius: 999px;
  transition: 0.15s;
}
.slider:before{
  content:"";
  position:absolute;
  height: 22px;
  width: 22px;
  left: 3px;
  top: 3px;
  background: white;
  border-radius: 50%;
  box-shadow: 0 3px 10px rgba(0,0,0,0.15);
  transition: 0.15s;
}
.toggle input:checked + .slider{ background: rgba(0, 140, 80, 0.45); }
.toggle input:checked + .slider:before{ transform: translateX(18px); }
.toggle input:disabled + .slider{ cursor:not-allowed; opacity: 0.8; }

/* ===== Modal ===== */
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
  width: min(680px, 100%);
  background: rgba(255,255,255,0.98);
  border: 1px solid rgba(0,0,0,0.10);
  border-radius: 18px;
  box-shadow: 0 18px 50px rgba(0,0,0,0.18);
  overflow:hidden;
}
.modalHead{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding: 12px 12px;
  border-bottom: 1px solid rgba(0,0,0,0.08);
  background: rgba(238, 249, 242, 0.7);
}
.modalTitle{ font-weight: 900; font-size: 14px; }
.modalBody{ padding: 12px; display:grid; gap: 12px; }
.modalFoot{ padding: 12px; border-top: 1px solid rgba(0,0,0,0.08); display:flex; justify-content:flex-end; }

.row{
  display:grid;
  grid-template-columns: 180px 1fr;
  gap: 10px;
  align-items:center;
}
.label{ font-weight: 900; font-size: 12px; opacity: 0.9; }
select, input{
  border: 1px solid rgba(0,0,0,0.12);
  background: rgba(255,255,255,0.9);
  padding: 10px 12px;
  border-radius: 12px;
  font-weight: 800;
  outline: none;
}
.hint{
  grid-column: 2 / 3;
  font-size: 12px;
  color: rgba(0,0,0,0.55);
}

.pill{
  grid-column: 2 / 3;
  width: fit-content;
  font-size: 12px;
  font-weight: 900;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid rgba(0,0,0,0.08);
}
.pillOn{
  background: rgba(140, 230, 170, 0.26);
  border-color: rgba(0,120,70,0.18);
}
.pillOff{
  background: rgba(0,0,0,0.04);
  color: rgba(0,0,0,0.55);
}
@media (max-width: 560px){
  .row{ grid-template-columns: 1fr; }
  .hint, .pill{ grid-column: auto; }
}
`;
