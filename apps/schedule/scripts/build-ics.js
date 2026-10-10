// scripts/build-ics.js
// 정적 .ics 생성 유틸 (사용자 결정 2026-10-10) — fetch-schedule.js 가
// public/data/calendar.ics 로 쓴다. 3개년 JSON 과 동일한 이벤트 데이터를 쓴다.

// RFC5545 §3.2 — 텍스트 이스케이프: 백슬래시·세미콜론·쉼줄·개행
function icsEscape(v) {
  return String(v == null ? "" : v)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// RFC5545 §3.1 — 한 줄은 75옥테트 초과 금지. 한글은 3바이트라 문자 단위가 아니라
// UTF-8 바이트 단위로 폴딩해야 중간 바이트가 끊기지 않는다(continuation 은 공백1자).
function foldLine(line) {
  const buf = Buffer.from(line, "utf8");
  if (buf.length <= 75) return line;
  const out = [];
  let start = 0;
  let first = true;
  while (start < buf.length) {
    let end = Math.min(start + (first ? 75 : 74), buf.length);
    while (end < buf.length && (buf[end] & 0xc0) === 0x80) end--; // 멀티바이트 중간 회피
    out.push((first ? "" : " ") + buf.toString("utf8", start, end));
    start = end;
    first = false;
  }
  return out.join("\r\n");
}

// all-day 이벤트 DTEND 는 배타적(다음날)
function nextYmd(ymd) {
  const p = (n) => String(n).padStart(2, "0");
  const dt = new Date(
    Date.UTC(
      Number(ymd.slice(0, 4)),
      Number(ymd.slice(4, 6)) - 1,
      Number(ymd.slice(6, 8)) + 1
    )
  );
  return `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}`;
}

// ISO8601 → RFC5545 UTC stamp (2026-10-10T06:43:39.508Z → 20261010T064339Z)
function toUtcStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

function buildIcs(events, dtstampIso) {
  const dtstamp = toUtcStamp(dtstampIso);
  if (!dtstamp) throw new Error(`DTSTAMP 변환 실패: ${dtstampIso}`);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//kuhwa//NEIS School Schedule//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:" + icsEscape("한국구화학교 학사일정"),
    "X-WR-TIMEZONE:Asia/Seoul",
  ];

  for (const ev of events) {
    const desc = [ev.type, ev.content, (ev.courses || []).join("/")].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(`${ev.date}-${ev.name}@kuhwa.duckdns.org`)}`,
      `DTSTAMP:${dtstamp}`,
      "DTSTART;VALUE=DATE:" + ev.date,
      "DTEND;VALUE=DATE:" + nextYmd(ev.date),
      "SUMMARY:" + icsEscape(ev.name),
      "DESCRIPTION:" + icsEscape(desc),
      "CATEGORIES:" + icsEscape(ev.type || "학사일정"),
      "TRANSP:TRANSPARENT",
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

module.exports = { icsEscape, foldLine, nextYmd, toUtcStamp, buildIcs };
