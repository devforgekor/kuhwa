// /api/schedule.js
// Vercel Serverless Function
// 한국구화학교(NEIS) 학사일정을 조회하여 JSON으로 반환합니다.

const ATPT_OFCDC_SC_CODE = "B10"; // 서울특별시교육청
const SD_SCHUL_CODE = "7010473"; // 한국구화학교

module.exports = async (req, res) => {
  const apiKey = process.env.NEIS_API_KEY;

  if (!apiKey) {
    res.status(500).json({ error: "NEIS_API_KEY 환경변수가 설정되어 있지 않습니다." });
    return;
  }

  const { year } = req.query || {};
  const targetYear = year ? String(year) : String(new Date().getFullYear());

  if (!/^\d{4}$/.test(targetYear)) {
    res.status(400).json({ error: "year 파라미터는 4자리 숫자여야 합니다." });
    return;
  }

  // NEIS SchoolSchedule API는 AY 파라미터를 제대로 필터링하지 않으므로
  // AA_FROM_YMD / AA_TO_YMD(연도 범위)로 직접 필터링합니다.
  const PAGE_SIZE = 1000;

  try {
    const buildUrl = (pIndex) => {
      const params = new URLSearchParams({
        KEY: apiKey,
        Type: "json",
        pIndex: String(pIndex),
        pSize: String(PAGE_SIZE),
        ATPT_OFCDC_SC_CODE,
        SD_SCHUL_CODE,
        AA_FROM_YMD: `${targetYear}0101`,
        AA_TO_YMD: `${targetYear}1231`,
      });
      return `https://open.neis.go.kr/hub/SchoolSchedule?${params.toString()}`;
    };

    const fetchPage = async (pIndex) => {
      const response = await fetch(buildUrl(pIndex));
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
    };

    // 첫 페이지로 전체 건수를 파악한 뒤, 남은 페이지는 병렬로 가져와 지연을 줄입니다.
    const first = await fetchPage(1);
    let rows = [...first.rows];
    const totalCount = first.totalCount;
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);

    if (totalPages > 1) {
      const remainingPages = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(i + 2))
      );
      for (const page of remainingPages) {
        rows.push(...page.rows);
      }
    }

    if (rows.length === 0) {
      res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
      res.status(200).json({ school: "한국구화학교", year: targetYear, events: [] });
      return;
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

    const events = Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));

    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json({ school: "한국구화학교", year: targetYear, events });
  } catch (err) {
    console.error("[api/schedule] NEIS API 호출 실패:", err);
    res.status(502).json({ error: "NEIS API 호출에 실패했습니다." });
  }
};
