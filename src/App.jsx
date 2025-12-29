import { useEffect, useMemo, useState } from "react";
import { fetchTodayVenues } from "./services/racesApi.js";
import { formatDateJP } from "./services/dateJP.js";

function IconButton({ title, children, onClick }) {
  return (
    <button className="iconBtn" title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}

function PillTabs({ value, onChange }) {
  return (
    <div className="pillTabs" role="tablist" aria-label="種別">
      <button
        className={`pill ${value === "keirin" ? "active" : ""}`}
        onClick={() => onChange("keirin")}
        role="tab"
        aria-selected={value === "keirin"}
      >
        <span className="pillCheck">{value === "keirin" ? "✓" : ""}</span>
        競輪
      </button>
      <button
        className={`pill ${value === "auto" ? "active" : ""}`}
        onClick={() => onChange("auto")}
        role="tab"
        aria-selected={value === "auto"}
      >
        <span className="pillCheck">{value === "auto" ? "✓" : ""}</span>
        オート
      </button>
    </div>
  );
}

function Switch({ checked, disabled, onChange, ariaLabel }) {
  return (
    <label className={`switch ${disabled ? "disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
      />
      <span className="track" />
      <span className="thumb" />
    </label>
  );
}

const LINK_TARGETS = [
  { key: "netkeirin", label: "ネット競輪（JSONのURL）" },
  { key: "oddspark", label: "オッズパーク", url: "https://www.oddspark.com/" },
  { key: "chariloto", label: "チャリロト", url: "https://www.chariloto.com/keirin" },
  { key: "winticket", label: "WINTICKET", url: "https://www.winticket.jp/keirin/" },
  { key: "dmm", label: "DMM競輪", url: "https://keirin.dmm.com/" },
];

function buildRaceLink({ linkTarget, race }) {
  if (linkTarget === "netkeirin") {
    // JSONにURLが入っている想定（無ければ空）
    return race.netkeirinUrl || "";
  }
  const t = LINK_TARGETS.find((x) => x.key === linkTarget);
  return t?.url || "";
}

function VenueCard({
  venue,
  races,
  expanded,
  onToggleExpand,
  raceOnMap,
  onToggleRace,
  onAllOn,
  onAllOff,
}) {
  return (
    <section className="venueCard">
      <div className="venueHeader">
        <div className="venueTitle">{venue}</div>

        <div className="venueHeaderRight">
          <button className="chip" onClick={onAllOn}>すべてON</button>
          <button className="chip" onClick={onAllOff}>すべてOFF</button>
          <button className="chevBtn" onClick={onToggleExpand} aria-label="開閉">
            {expanded ? "︿" : "﹀"}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="venueBody">
          {races.map((r) => (
            <div key={r.id} className={`raceRow ${r.closed ? "closed" : ""}`}>
              <div className="raceLeft">
                <div className="raceTop">
                  <span className="raceNo">{r.no}R</span>
                  <span className="raceTime">
                    通知 {r.notifyAt || "--:--"}
                  </span>
                  <span className="raceTimeSub">
                    （締切 {r.deadline || "--:--"}）
                  </span>
                  {r.start ? <span className="raceTime">／ 発走 {r.start}</span> : null}
                </div>
              </div>

              <div className="raceRight">
                <Switch
                  checked={!!raceOnMap[r.id]}
                  disabled={r.closed}
                  onChange={(v) => onToggleRace(r.id, v)}
                  ariaLabel={`${venue}${r.no}R`}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState("keirin"); // keirin | auto
  const [page, setPage] = useState("home"); // home | my | settings
  const [expandedVenue, setExpandedVenue] = useState(null);

  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  // トグルON/OFF（次でlocalStorage永続化する）
  const [raceOn, setRaceOn] = useState({}); // { [raceId]: boolean }

  // ===== 設定（まずはフロント側state。次でlocalStorageへ） =====
  const [proCode, setProCode] = useState("");
  const isPro = proCode.trim().length > 0; // 仮：コードが入ってたら有料扱い

  const TIMER_CHOICES = [5, 4, 3, 2, 1];
  const [timer1Min, setTimer1Min] = useState(5); // 無料: 1つ目
  const [timer2Enabled, setTimer2Enabled] = useState(false); // 有料: 2つ目 ON/OFF
  const [timer2Min, setTimer2Min] = useState(1);

  const [showLinkInNotification, setShowLinkInNotification] = useState(true);
  const [linkTarget, setLinkTarget] = useState("netkeirin"); // netkeirin | oddspark | ...

  const todayLabel = useMemo(() => formatDateJP(new Date()), []);

  useEffect(() => {
    if (page !== "home") return;

    let cancelled = false;
    setLoading(true);
    setLoadError("");

    fetchTodayVenues(tab)
      .then((v) => {
        if (cancelled) return;
        setVenues(v);
        if (v.length > 0) setExpandedVenue((cur) => cur ?? v[0].venue);
      })
      .catch((e) => {
        if (cancelled) return;
        setVenues([]);
        setLoadError(String(e?.message ?? e));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [tab, page]);

  const allRaceIdsInTab = useMemo(() => {
    return venues.flatMap((v) => v.races.map((r) => r.id));
  }, [venues]);

  const setAllInTab = (value) => {
    setRaceOn((prev) => {
      const next = { ...prev };
      for (const id of allRaceIdsInTab) next[id] = value;
      return next;
    });
  };

  const toggleRace = (raceId, value) => {
    setRaceOn((prev) => ({ ...prev, [raceId]: value }));
  };

  // myタイマー表示用（id→表示情報を引けるように index 作る）
  const raceIndex = useMemo(() => {
    const map = new Map();
    for (const v of venues) {
      for (const r of v.races) {
        map.set(r.id, { venue: v.venue, race: r });
      }
    }
    return map;
  }, [venues]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="titleRow">
          <div className="titleLeft">
            <div className="appTitle">もふタイマー</div>
          </div>
          <div className="titleRight">
            <IconButton title="通知">🔔</IconButton>
            <IconButton title="設定" onClick={() => setPage("settings")}>⚙️</IconButton>
            <IconButton title="タイマー一覧" onClick={() => setPage("my")}>▶︎</IconButton>
          </div>
        </div>
      </header>

      <main className="content">
        {/* HOME */}
        {page === "home" && (
          <>
            <div className="dateRow">{todayLabel}</div>

            <div className="tabsRow">
              <PillTabs value={tab} onChange={(v) => setTab(v)} />
            </div>

            <div className="adBanner">スポンサー枠（小さめバナー）</div>

            <div className="listHeader">
              <div className="listHeaderLeft">{tab === "keirin" ? "競輪場名" : "オート場名"}</div>
              <div className="listHeaderRight">
                <button className="textBtn" onClick={() => setAllInTab(true)}>すべてON</button>
                <button className="textBtn" onClick={() => setAllInTab(false)}>すべてOFF</button>
              </div>
            </div>

            {loading && <div className="empty">読み込み中…</div>}

            {!loading && !!loadError && (
              <div className="empty">
                取得できませんでした：{loadError}
                <br />
                （当日JSONがまだ無い日か、JSON構造が違う可能性があります）
              </div>
            )}

            {!loading && !loadError && venues.length === 0 && (
              <div className="empty">本日のレースがありません</div>
            )}

            {!loading && !loadError && venues.length > 0 && (
              <div className="venueList">
                {venues.map((v) => (
                  <VenueCard
                    key={v.venue}
                    venue={v.venue}
                    races={v.races}
                    expanded={expandedVenue === v.venue}
                    onToggleExpand={() => setExpandedVenue((cur) => (cur === v.venue ? null : v.venue))}
                    raceOnMap={raceOn}
                    onToggleRace={toggleRace}
                    onAllOn={() => {
                      setRaceOn((prev) => {
                        const next = { ...prev };
                        for (const r of v.races) next[r.id] = true;
                        return next;
                      });
                    }}
                    onAllOff={() => {
                      setRaceOn((prev) => {
                        const next = { ...prev };
                        for (const r of v.races) next[r.id] = false;
                        return next;
                      });
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* MY TIMERS */}
        {page === "my" && (
          <>
            <div className="pageHeader">
              <button className="backBtn" onClick={() => setPage("home")}>←</button>
              <div className="pageTitle">myタイマー</div>
            </div>

            <div className="myList">
              {Object.entries(raceOn)
                .filter(([, on]) => on)
                .map(([id]) => {
                  const info = raceIndex.get(id);
                  const label = info
                    ? `${info.venue} ${info.race.no}R  通知 ${info.race.notifyAt || "--:--"}（締切 ${info.race.deadline || "--:--"}）`
                    : id;

                  const url = info ? buildRaceLink({ linkTarget, race: info.race }) : "";
                  return (
                    <div className="myRow" key={id}>
                      <div className="myRowLeft">
                        <div className="myMain">{label}</div>
                        {showLinkInNotification && url ? (
                          <div className="mySub">{url}</div>
                        ) : null}
                      </div>
                      <div className="myRowRight">
                        <button className="chip" onClick={() => toggleRace(id, false)}>削除</button>
                      </div>
                    </div>
                  );
                })}

              {Object.values(raceOn).every((v) => !v) && (
                <div className="empty">登録されたタイマーがありません</div>
              )}
            </div>
          </>
        )}

        {/* SETTINGS */}
        {page === "settings" && (
          <>
            <div className="pageHeader">
              <button className="backBtn" onClick={() => setPage("home")}>←</button>
              <div className="pageTitle">設定</div>
            </div>

            <div className="settings">
              {/* 有料コード */}
              <div className="card">
                <div className="cardTitle">有料コード</div>
                <input
                  className="input"
                  placeholder="コードを入力（仮：入力があれば有料扱い）"
                  value={proCode}
                  onChange={(e) => setProCode(e.target.value)}
                />
                <div className="hint">
                  ※プライベートブラウズだと設定が消えることがあります
                </div>
              </div>

              {/* タイマー設定 */}
              <div className="card">
                <div className="cardTitle">タイマー設定</div>

                <div className="settingRow">
                  <div className="settingLabel">
                    1つ目タイマー（無料）
                    <div className="settingHelp">通知は 5/4/3/2/1 分前から選択</div>
                  </div>
                  <select
                    className="select"
                    value={timer1Min}
                    onChange={(e) => setTimer1Min(Number(e.target.value))}
                  >
                    {TIMER_CHOICES.map((m) => (
                      <option key={m} value={m}>{m}分前</option>
                    ))}
                  </select>
                </div>

                <div className="settingRow">
                  <div className="settingLabel">
                    2つ目タイマー（有料）
                    <div className="settingHelp">有料のみ：ONにすると2回目通知が使えます</div>
                  </div>
                  <Switch
                    checked={timer2Enabled}
                    disabled={!isPro}
                    onChange={(v) => setTimer2Enabled(v)}
                    ariaLabel="2つ目タイマー"
                  />
                </div>

                <div className="settingRow">
                  <div className="settingLabel">2つ目タイマーの通知</div>
                  <select
                    className="select"
                    value={timer2Min}
                    disabled={!isPro || !timer2Enabled}
                    onChange={(e) => setTimer2Min(Number(e.target.value))}
                  >
                    {TIMER_CHOICES.map((m) => (
                      <option key={m} value={m}>{m}分前</option>
                    ))}
                  </select>
                </div>

                <div className="hint">
                  ※いまはUIのみ。次にこの設定を通知処理に反映します。
                </div>
              </div>

              {/* 通知リンク */}
              <div className="card">
                <div className="cardTitle">通知リンク</div>

                <div className="settingRow">
                  <div className="settingLabel">URLを通知に表示</div>
                  <Switch
                    checked={showLinkInNotification}
                    onChange={setShowLinkInNotification}
                    ariaLabel="URL表示"
                  />
                </div>

                <div className="settingRow">
                  <div className="settingLabel">
                    リンク先
                    <div className="settingHelp">ネット競輪はJSON内のURLを使用</div>
                  </div>
                  <select
                    className="select"
                    value={linkTarget}
                    onChange={(e) => setLinkTarget(e.target.value)}
                  >
                    {LINK_TARGETS.map((t) => (
                      <option key={t.key} value={t.key}>{t.label}</option>
                    ))}
                  </select>
                </div>

                <div className="hint">
                  ※「アプリに飛ばす（deeplink）」は次の段階で対応します（iOS/Android別）。
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
