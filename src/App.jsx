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
          <button className="chip" onClick={onAllOn}>
            すべてON
          </button>
          <button className="chip" onClick={onAllOff}>
            すべてOFF
          </button>

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
                  <span className="raceTime">締切 {r.deadline || "--:--"}</span>
                  {r.start ? <span className="raceTime">／ 発走 {r.start}</span> : null}
                </div>
                {/* 選手等の詳細は今回は出さない（仕様：会場ごと/締切時刻のみ） */}
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

  // 取得結果
  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  // レースON/OFF（まずはローカル状態。次にlocalStorage永続化へ）
  const [raceOn, setRaceOn] = useState({}); // { [raceId]: boolean }

  const todayLabel = useMemo(() => formatDateJP(new Date()), []);

  // タブ切替で当日JSONを取りに行く
  useEffect(() => {
    if (page !== "home") return;

    let cancelled = false;
    setLoading(true);
    setLoadError("");

    fetchTodayVenues(tab)
      .then((v) => {
        if (cancelled) return;
        setVenues(v);
        // 初回だけ最初の会場を開く
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

    return () => {
      cancelled = true;
    };
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

  return (
    <div className="app">
      {/* Top bar */}
      <header className="topbar">
        <div className="titleRow">
          <div className="titleLeft">
            <div className="appTitle">もふタイマー</div>
          </div>

          <div className="titleRight">
            {/* アイコンは仮（後で差し替えOK） */}
            <IconButton title="通知">{/* bell */}🔔</IconButton>
            <IconButton title="設定" onClick={() => setPage("settings")}>
              ⚙️
            </IconButton>
            <IconButton title="タイマー一覧" onClick={() => setPage("my")}>
              ▶︎
            </IconButton>
          </div>
        </div>
      </header>

      <main className="content">
        {/* Home */}
        {page === "home" && (
          <>
            <div className="dateRow">{todayLabel}</div>

            <div className="tabsRow">
              <PillTabs value={tab} onChange={(v) => setTab(v)} />
            </div>

            {/* 小さめ広告（有料で非表示にする想定） */}
            <div className="adBanner">スポンサー枠（小さめバナー）</div>

            <div className="listHeader">
              <div className="listHeaderLeft">{tab === "keirin" ? "競輪場名" : "オート場名"}</div>
              <div className="listHeaderRight">
                <button className="textBtn" onClick={() => setAllInTab(true)}>
                  すべてON
                </button>
                <button className="textBtn" onClick={() => setAllInTab(false)}>
                  すべてOFF
                </button>
              </div>
            </div>

            {/* 読み込み・エラー */}
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

            {/* 会場リスト */}
            {!loading && !loadError && venues.length > 0 && (
              <div className="venueList">
                {venues.map((v) => (
                  <VenueCard
                    key={v.venue}
                    venue={v.venue}
                    races={v.races}
                    expanded={expandedVenue === v.venue}
                    onToggleExpand={() =>
                      setExpandedVenue((cur) => (cur === v.venue ? null : v.venue))
                    }
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

        {/* My Timers */}
        {page === "my" && (
          <>
            <div className="pageHeader">
              <button className="backBtn" onClick={() => setPage("home")}>
                ←
              </button>
              <div className="pageTitle">myタイマー</div>
            </div>

            <div className="myList">
              {Object.entries(raceOn)
                .filter(([, on]) => on)
                .map(([id]) => (
                  <div className="myRow" key={id}>
                    {id}（仮表示）
                    <div className="myRowRight">
                      <button className="chip">編集</button>
                      <button className="chip">削除</button>
                    </div>
                  </div>
                ))}

              {Object.values(raceOn).every((v) => !v) && (
                <div className="empty">登録されたタイマーがありません</div>
              )}
            </div>
          </>
        )}

        {/* Settings */}
        {page === "settings" && (
          <>
            <div className="pageHeader">
              <button className="backBtn" onClick={() => setPage("home")}>
                ←
              </button>
              <div className="pageTitle">設定</div>
            </div>

            <div className="settings">
              <div className="card">
                <div className="cardTitle">有料コード</div>
                <input className="input" placeholder="コードを入力" />
                <button className="primaryBtn">有料にする</button>
                <div className="hint">※プライベートブラウズだと設定が消えることがあります</div>
              </div>

              <div className="card">
                <div className="cardTitle">通知リンク</div>
                <label className="row">
                  <span>URLを通知に表示</span>
                  <Switch checked={true} onChange={() => {}} ariaLabel="URL表示" />
                </label>

                <div className="row">
                  <span>リンク先</span>
                  <select className="select">
                    <option>ネット競輪</option>
                    <option>オッズパーク</option>
                    <option>ウインチケット</option>
                    <option>その他（URL指定）</option>
                  </select>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
