// scripts/fetch-schedule.js
// NEIS 학사일정을 미리 가져와 public/data/{year}.json 정적 파일로 저장합니다.
// Diff가 있을 때만 GitHub에 커밋/푸시합니다.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const nodemailer = require("nodemailer");

const ATPT_OFCDC_SC_CODE = "B10"; // 서울특별시교육청
const SD_SCHUL_CODE = "7010473"; // 한국구화학교
const PAGE_SIZE = 1000;

async function fetchPage(apiKey, year, pIndex) {
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
  if (!sched) return { totalCount: 0, rows: [] };
  const totalCount = sched[0]?.head?.[0]?.list_total_count ?? 0;
  const rows = sched[1]?.row || [];
  return { totalCount, rows };
}

async function fetchYearEvents(apiKey, year) {
  const first = await fetchPage(apiKey, year, 1);
  let rows = [...first.rows];
  const totalPages = Math.ceil(first.totalCount / PAGE_SIZE);

  if (totalPages > 1) {
    const remainingPages = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(apiKey, year, i + 2))
    );
    for (const page of remainingPages) {
      rows.push(...page.rows);
    }
  }

  // 같은 날짜/행사명이 학교급(초/중/고 등)별로 중복 등록되므로 날짜+행사명 기준으로 합칩니다.
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

  return Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function sendFailureMail(error) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, MAIL_TO } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) {
    console.error("SMTP 환경변수가 설정되어 있지 않아 실패 알림 메일을 보낼 수 없습니다.");
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    });
    await transporter.sendMail({
      from: SMTP_USER,
      to: MAIL_TO || SMTP_USER,
      subject: "[kuhwa] NEIS 학사일정 갱신 실패",
      text: `NEIS 학사일정 정기 갱신(scripts/fetch-schedule.js)이 실패했습니다.\n\n시각: ${new Date().toISOString()}\n에러: ${error?.stack || error}`,
    });
    console.log("실패 알림 메일을 발송했습니다.");
  } catch (mailErr) {
    console.error("실패 알림 메일 발송 중 오류:", mailErr);
  }
}

async function main() {
  const apiKey = process.env.NEIS_API_KEY;
  if (!apiKey) {
    const err = new Error("NEIS_API_KEY 환경변수가 설정되어 있지 않습니다.");
    console.error(err.message);
    await sendFailureMail(err);
    process.exit(1);
  }

  const nowYear = new Date().getFullYear();
  const years = [nowYear - 1, nowYear, nowYear + 1];

  const outDir = path.join(__dirname, "..", "public", "data");
  fs.mkdirSync(outDir, { recursive: true });

  const results = await Promise.all(years.map((year) => fetchYearEvents(apiKey, year)));

  let hasChanges = false;
  years.forEach((year, i) => {
    const events = results[i];
    const outPath = path.join(outDir, `${year}.json`);
    const payload = {
      school: "한국구화학교",
      year: String(year),
      updatedAt: new Date().toISOString(),
      events,
    };
    // 기존 파일과 이벤트 데이터만 비교 (updatedAt 제외)
    let existingEvents = null;
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, "utf-8"));
      existingEvents = existing.events;
    } catch {}
    const newEventsStr = JSON.stringify(events);
    const existingEventsStr = JSON.stringify(existingEvents);
    if (newEventsStr !== existingEventsStr) {
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
      console.log(`wrote ${outPath} (${events.length} events)`);
      hasChanges = true;
    } else {
      console.log(`unchanged ${outPath} (${events.length} events)`);
    }
  });

  // 이벤트 데이터 변경 없으면 종료
  if (!hasChanges) {
    console.log("No changes to commit");
    return;
  }

  // 커밋/푸시 (이 디렉토리는 독립 git repo = devforgekor/kuhwa. GitHub은 백업)
  const repoDir = path.join(__dirname, "..");
  execSync("git add -f public/data", { cwd: repoDir, stdio: "inherit" });
  execSync('git config user.name "devforge[bot]"', { cwd: repoDir });
  execSync('git config user.email "devforge[bot]@users.noreply.github.com"', { cwd: repoDir });
  execSync('git commit -m "chore: update NEIS schedule data"', { cwd: repoDir, stdio: "inherit" });
  execSync("git pull --rebase --autostash origin main", { cwd: repoDir, stdio: "inherit" });
  execSync("git push origin main", { cwd: repoDir, stdio: "inherit" });
  console.log("Pushed to GitHub (backup)");
}

main().catch(async (err) => {
  console.error(err);
  await sendFailureMail(err);
  process.exit(1);
});
