// /api/calendar.js
// Vercel Serverless Function
// 한국구화학교 학사일정을 iCalendar(.ics) 형식으로 반환합니다.
// 구글 캘린더 등에서 "URL로 캘린더 추가" 기능으로 구독하면 자동으로 동기화됩니다.
//
// 매일 KST 07:00 GitHub Actions(scripts/fetch-schedule.js)가 생성해두는
// public/data/{year}.json 정적 파일을 우선 사용합니다(웹 달력과 동일한 소스 → 데이터 일치, 응답 속도 개선).
// 해당 연도 파일이 없을 경우에만 NEIS API를 직접 호출하는 방식으로 폴백합니다.

const fs = require("fs");
const path = require("path");

const ATPT_OFCDC_SC_CODE = "B10"; // 서울특별시교육청
const SD_SCHUL_CODE = "7010473"; // 한국구화학교
const PAGE_SIZE = 1000;

function readStaticYear(year) {
  try {
    const filePath = path.join(__dirname, "..", "public", "data", `${year}.json`);
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    return data.events || null;
  } catch {
    return null;
  }
}

async function fetchYearRows(apiKey, year) {
  const rows = [];
  let pIndex = 1;
  let totalCount = null;

  while (totalCount === null || rows.length < totalCount) {
    const params = new URLSearchParams({
      KEY: apiKey,
      Type: "json",
      pIndex: String(pIndex),
      pSize: String(PAGE_SIZE),
      ATPT_OFCDC_SC_CODE,
      SD_SCHUL_CODE,
      AA_FROM_YMD: `${year}0101`,
      AA_TO_YMD: `${year}1231`,
    });

    const url = `https://open.neis.go.kr/hub/SchoolSchedule?${params.toString()}`;
    const response = await fetch(url);
    const data = await response.json();

    const resultCode = data?.RESULT?.CODE;
    // NEIS는 "조회할 데이터가 없습니다"(INFO-200)는 정상 상황(빈 결과)이지만,
    // 그 외 에러 코드(인증키 오류, 요청 제한 등)는 실제 호출 실패이므로 예외로 처리합니다.
    if (resultCode && resultCode !== "INFO-200") {
      throw new Error(`NEIS API 호출 실패 (${resultCode}): ${data.RESULT.MESSAGE}`);
    }

    const sched = data?.SchoolSchedule;
    if (!sched) break;

    totalCount = sched[0]?.head?.[0]?.list_total_count ?? 0;
    const pageRows = sched[1]?.row || [];
    rows.push(...pageRows);

    if (pageRows.length === 0) break;
    pIndex += 1;
  }

  return rows;
}

// NEIS 원본 row를 정적 파일의 이벤트 형식({date, name, content, type})으로 변환합니다.
function rowsToEvents(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = `${row.AA_YMD}_${row.EVENT_NM}`;
    if (!merged.has(key)) {
      merged.set(key, {
        date: row.AA_YMD,
        name: row.EVENT_NM,
        content: (row.EVENT_CNTNT || "").trim(),
        type: row.SBTR_DD_SC_NM,
        courses: [row.SCHUL_CRSE_SC_NM].filter(Boolean),
      });
    } else {
      const existing = merged.get(key);
      if (row.SCHUL_CRSE_SC_NM && !existing.courses.includes(row.SCHUL_CRSE_SC_NM)) {
        existing.courses.push(row.SCHUL_CRSE_SC_NM);
      }
    }
  }
  return Array.from(merged.values());
}

async function getYearEvents(apiKey, year) {
  const staticEvents = readStaticYear(year);
  if (staticEvents) return staticEvents;
  if (!apiKey) {
    throw new Error(`${year}년 정적 데이터가 없고 NEIS_API_KEY 환경변수도 설정되어 있지 않습니다.`);
  }
  const rows = await fetchYearRows(apiKey, year);
  return rowsToEvents(rows);
}

function escapeIcsText(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function nextDayYmd(ymd) {
  const y = parseInt(ymd.slice(0, 4), 10);
  const m = parseInt(ymd.slice(4, 6), 10);
  const d = parseInt(ymd.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}${pad2(dt.getUTCMonth() + 1)}${pad2(dt.getUTCDate())}`;
}

module.exports = async (req, res) => {
  // 정적 파일(public/data/{year}.json)이 이미 준비돼 있으면 NEIS_API_KEY 없이도 동작합니다.
  const apiKey = process.env.NEIS_API_KEY || null;

  const nowYear = new Date().getFullYear();
  const years = [nowYear - 1, nowYear, nowYear + 1];

  try {
    const yearEventsList = await Promise.all(years.map((year) => getYearEvents(apiKey, year)));

    // 정적 파일은 이미 날짜+행사명 기준으로 병합되어 있지만, 폴백(실시간 NEIS) 경로와
    // 연도 간 중복 가능성에 대비해 다시 한번 날짜+행사명 기준으로 합칩니다.
    const merged = new Map();
    for (const events of yearEventsList) {
      for (const ev of events) {
        const key = `${ev.date}_${ev.name}`;
        if (!merged.has(key)) merged.set(key, ev);
      }
    }

    const events = Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));

    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, "0");
    const dtStamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;

    const lines = [];
    lines.push("BEGIN:VCALENDAR");
    lines.push("VERSION:2.0");
    lines.push("PRODID:-//kuhwa//NEIS School Schedule//KO");
    lines.push("CALSCALE:GREGORIAN");
    lines.push("METHOD:PUBLISH");
    lines.push("X-WR-CALNAME:한국구화학교 학사일정");
    lines.push("X-WR-TIMEZONE:Asia/Seoul");

    events.forEach((ev) => {
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${ev.date}-${Buffer.from(ev.name).toString("hex")}@kuhwa.vercel.app`);
      lines.push(`DTSTAMP:${dtStamp}`);
      lines.push(`DTSTART;VALUE=DATE:${ev.date}`);
      lines.push(`DTEND;VALUE=DATE:${nextDayYmd(ev.date)}`);
      lines.push(`SUMMARY:${escapeIcsText(ev.name)}`);
      if (ev.content || (ev.courses && ev.courses.length > 0)) {
        const desc = [];
        if (ev.courses && ev.courses.length > 0) {
          desc.push(`학교급: ${ev.courses.join(", ")}`);
        }
        if (ev.content) {
          desc.push(ev.content);
        }
        lines.push(`DESCRIPTION:${escapeIcsText(desc.join("\\n"))}`);
      }
      lines.push(`CATEGORIES:${escapeIcsText(ev.type || "학사일정")}`);
      lines.push("END:VEVENT");
    });

    lines.push("END:VCALENDAR");

    const body = lines.join("\r\n");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    const filename = encodeURIComponent("한국구화학교 학사일정.ics");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="school-schedule.ics"; filename*=UTF-8''${filename}`
    );
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");
    res.status(200).send(body);
  } catch (err) {
    console.error("[api/calendar] NEIS API 호출 실패:", err);
    res.status(502).json({ error: "NEIS API 호출에 실패했습니다." });
  }
};
