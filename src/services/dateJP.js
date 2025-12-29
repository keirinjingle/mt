export function formatDateJP(date = new Date()) {
  const week = ["日", "月", "火", "水", "木", "金", "土"][date.getDay()];
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${y}年${m}月${d}日（${week}）`;
}
