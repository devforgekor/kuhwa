#!/usr/bin/env node
// kuhwa portal build — 의존성 0 (Node 내장 모듈만).
// 규칙 소스: kuhwa-Taxonomy-도입-상세계획.md 5장 (1~8) — 위반 시 exit 1 → CI 배포 중단.
// YAML 파서는 concepts.yml 스키마 한정 부분 파서(주석·중첩맵·블록 시퀀스·인라인 flow).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const YAML_PATH = join(HERE, "taxonomy", "concepts.yml");
const TEMPLATE_PATH = join(HERE, "template.html");
const OUT_DIR = join(HERE, "dist");
const OUT_PATH = join(OUT_DIR, "index.html");

// 규칙6: L0은4개 고정
const L0_FIXED = ["neis", "education-tools", "library", "misc"];

// ---------------- YAML 부분 파서 ----------------

function stripComment(line) {
  let inQ = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) { if (ch === inQ) inQ = null; continue; }
    if (ch === '"' || ch === "'") { inQ = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

// 최상위 콤마 분리 (따옴표·중첩 브래킷 보호)
function splitTop(s) {
  const parts = [];
  let depth = 0, inQ = null, cur = "";
  for (const ch of s) {
    if (inQ) { cur += ch; if (ch === inQ) inQ = null; continue; }
    if (ch === '"' || ch === "'") { inQ = ch; cur += ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function scalar(v) {
  v = v.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    return splitTop(v.slice(1, -1)).map(scalar);
  }
  if (v.startsWith("{") && v.endsWith("}")) {
    const obj = {};
    for (const kv of splitTop(v.slice(1, -1))) {
      const ci = kv.indexOf(":");
      if (ci < 0) throw new Error(`flow map 파싱 실패: ${kv}`);
      obj[kv.slice(0, ci).trim()] = scalar(kv.slice(ci + 1));
    }
    return obj;
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseYaml(text) {
  const lines = text.split("\n").map((l) => stripComment(l).replace(/\s+$/, ""));
  let i = 0;
  const indentOf = (l) => l.match(/^ */)[0].length;

  function parseBlock(minIndent) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) return {};
    const ind = indentOf(lines[i]);
    if (ind < minIndent) return {};
    return lines[i].trim().startsWith("- ") ? parseSeq(ind) : parseMap(ind);
  }

  function parseSeq(ind) {
    const arr = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (indentOf(line) !== ind || !line.trim().startsWith("- ")) break;
      const rest = line.trim().slice(2).trim();
      i++;
      if (rest.startsWith("{") || rest.startsWith("[")) {
        arr.push(scalar(rest));
      } else if (rest.includes(":")) {
        // 블록 맵 시퀀스 항목: "- id: neis" + 후속 indent>ind 키들
        const obj = {};
        const ci = rest.indexOf(":");
        obj[rest.slice(0, ci).trim()] = scalar(rest.slice(ci + 1));
        while (i < lines.length) {
          if (!lines[i].trim()) { i++; continue; } // 주석행(빈 줄)은 건너뛰고 항목 계속
          if (indentOf(lines[i]) <= ind) break;    // 다음 시퀀스 항목/상위 블록 시작
          const l2 = lines[i];
          const c2 = l2.indexOf(":");
          if (c2 < 0) throw new Error(`맵 키 파싱 실패: ${l2}`);
          obj[l2.slice(0, c2).trim()] = scalar(l2.slice(c2 + 1));
          i++;
        }
        arr.push(obj);
      } else if (rest) {
        arr.push(scalar(rest));
      } else {
        arr.push(parseBlock(ind + 1));
      }
    }
    return arr;
  }

  function parseMap(ind) {
    const obj = {};
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (indentOf(line) !== ind) break;
      const ci = line.indexOf(":");
      if (ci < 0) throw new Error(`맵 키 파싱 실패: ${line}`);
      const key = line.slice(0, ci).trim();
      const val = line.slice(ci + 1).trim();
      i++;
      obj[key] = val === "" ? parseBlock(ind + 1) : scalar(val);
    }
    return obj;
  }

  return parseBlock(0);
}

// ---------------- 렌더링 보조 ----------------

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------- 본문 ----------------

const raw = readFileSync(YAML_PATH, "utf8");
let data;
try {
  data = parseYaml(raw);
} catch (e) {
  console.error(`❌ YAML 파싱 실패: ${e.message}`);
  process.exit(1);
}

const scheme = data.scheme || {};
const types = Array.isArray(data.types) ? data.types : [];
const concepts = Array.isArray(data.concepts) ? data.concepts : [];
const errors = [];

// ---- 규칙1: ID 중복 없음 + 트리↔목록 집합 동치 ----
const ids = concepts.map((c) => c.id);
const seen = new Set();
for (const id of ids) {
  if (seen.has(id)) errors.push(`규칙1: ID 중복 — ${id}`);
  seen.add(id);
}
const byId = new Map(concepts.map((c) => [c.id, c]));
const roots = concepts.filter((c) => !c.broader); // L0
const reachable = new Set();
const queue = roots.map((c) => c.id);
while (queue.length) {
  const id = queue.shift();
  if (reachable.has(id)) continue;
  reachable.add(id);
  const c = byId.get(id);
  for (const ch of (c && c.children) || []) queue.push(ch);
}
for (const id of ids) if (!reachable.has(id)) errors.push(`규칙1: 트리에서 도달 불가(고아 개념) — ${id}`);
for (const id of reachable) if (!seen.has(id)) errors.push(`규칙1: children에 참조되나 미선언 — ${id}`);

// ---- 규칙2: 모든 broader/children/related 참조는 선언된 ID ----
for (const c of concepts) {
  for (const field of ["broader", "related"]) {
    const v = c[field];
    if (v === undefined) continue;
    for (const ref of Array.isArray(v) ? v : [v]) {
      if (!seen.has(ref)) errors.push(`규칙2: ${c.id}.${field} → 미선언 ID '${ref}'`);
    }
  }
  for (const ref of c.children || []) {
    if (!seen.has(ref)) errors.push(`규칙2: ${c.id}.children → 미선언 ID '${ref}'`);
  }
}

// ---- 규칙3: children ↔ broader 역방향 일치 ----
for (const c of concepts) {
  for (const ch of c.children || []) {
    const child = byId.get(ch);
    if (child && child.broader !== c.id) {
      errors.push(`규칙3: ${c.id}.children에 '${ch}' 있으나 ${ch}.broader=${child.broader ?? "(없음)"}`);
    }
  }
  if (c.broader) {
    const parent = byId.get(c.broader);
    if (!parent || !(parent.children || []).includes(c.id)) {
      errors.push(`규칙3: ${c.id}.broader=${c.broader} 이나 부모 children에 없음`);
    }
  }
}

// ---- 규칙4: type ∈ types 용어집 ----
const typeIds = new Set(types.map((t) => t.id));
for (const c of concepts) {
  if (c.type !== undefined && !typeIds.has(c.type)) {
    errors.push(`규칙4: ${c.id}.type='${c.type}' — 용어집에 없음 (${[...typeIds].join("/")})`);
  }
}

// ---- 규칙5: path 형식 / 규칙 예외 ----
for (const c of concepts) {
  if (c.path !== undefined) {
    if (!/^\/(.*)\/$/.test(c.path)) errors.push(`규칙5: ${c.id}.path='${c.path}' — /로 시작·끝 필요`);
    if (c.url !== undefined) errors.push(`규칙5: ${c.id} — path와 url 동시 보유 불가`);
  }
  if (c.url !== undefined && c.path !== undefined) {
    errors.push(`규칙5: ${c.id} — url 보유 concept은 path 없어야 함`);
  }
}
const isL0 = (c) => !c.broader;
const isLeaf = (c) => !isL0(c) && (!c.children || c.children.length === 0);
for (const c of concepts) {
  if (!isLeaf(c)) continue;
  if (c.path === undefined && c.url === undefined && c.internal === undefined) {
    errors.push(`규칙5: 리프 '${c.id}' — path/url/internal 중 하나 필수`);
  }
}

// ---- 규칙6: L0은4개 고정 ----
const l0Ids = roots.map((c) => c.id);
for (const id of L0_FIXED) {
  if (!l0Ids.includes(id)) errors.push(`규칙6: 고정 L0 '${id}' 누락`);
}
for (const id of l0Ids) {
  if (!L0_FIXED.includes(id)) errors.push(`규칙6: 비고정 L0 '${id}' — L0 추가는 계획서3.1 개정 필요`);
}

if (errors.length) {
  console.error(`❌ Taxonomy 규칙 위반 ${errors.length}건 — 빌드 중단:`);
  for (const e of errors) console.error(`   - ${e}`);
  process.exit(1);
}

// ---- 규칙8(경고): version bump 확인 (비치명) ----
try {
  const prev = execSync("git show HEAD~1:apps/portal/taxonomy/concepts.yml", {
    cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const vOf = (t) => (t.match(/^  version:\s*(\S+)/m) || [])[1];
  if (prev.trim() !== raw.trim() && vOf(prev) === vOf(raw)) {
    console.warn(`⚠️ 규칙8: concepts.yml 변경되었으나 scheme.version 미갱신(현재 v${scheme.version}) — 용어 변경 시 bump 권장`);
  }
} catch { /* HEAD~1 없음(최초) 등 — 스킵 */ }

// ---------------- 템플릿 치환 ----------------

const leaves = concepts.filter(isLeaf);
// 렌더 순서: L0 순서 → children 순서 (BFS)
const orderedLeaves = [];
for (const l0 of roots) {
  const q = [...(l0.children || [])];
  while (q.length) {
    const c = byId.get(q.shift());
    if (!c) continue;
    if (c.children && c.children.length) q.push(...c.children);
    else orderedLeaves.push(c);
  }
}

// TREE: L0 → 자식 링크
const treeHtml = roots.map((l0) => {
  const kids = (l0.children || []).map((id) => byId.get(id)).filter(Boolean);
  const items = kids.map((k) =>
    k.internal
      ? `<span class="tree-internal">${esc(k.label)}</span>`
      : k.url
        ? `<a href="${esc(k.url)}" target="_blank" rel="noopener">${esc(k.label)}</a>`
        : `<a href="${esc(k.path)}">${esc(k.label)}</a>`
  ).join("\n      ");
  return `<span class="tree-l0">${esc(l0.label)}</span>\n      <ul>\n      ${items}\n      </ul>`;
}).join("\n      ");

// ROWS: 리프 카드 (data-testid="portal-row" — 규칙7 검증 대상)
const rowsHtml = orderedLeaves.map((c) => {
  const attrs = [
    `data-testid="portal-row"`,
    `data-label="${esc(c.label)}"`,
    c.type ? `data-type="${esc(c.type)}"` : "",
    c.path ? `data-path="${esc(c.path)}"` : "",
    c.url ? `data-url="${esc(c.url)}"` : "",
    c.tech ? `data-tech="${esc(c.tech.join(","))}"` : "",
  ].filter(Boolean).join(" ");
  if (c.internal) {
    return `<div class="card internal" ${attrs}>
      <h2>${esc(c.label)}</h2>
      <p>${esc(c.description || "")}</p>
      <span class="tag">내부 문서</span>
    </div>`;
  }
  const href = c.path || c.url;
  const tag = c.path || new URL(c.url).hostname;
  const ext = c.url ? ` target="_blank" rel="noopener"` : "";
  return `<a class="card" ${attrs} href="${esc(href)}"${ext}>
      <h2>${esc(c.label)}</h2>
      <p>${esc(c.description || "")}</p>
      <span class="tag">${esc(tag)}</span>
    </a>`;
}).join("\n    ");

const breadcrumbHtml =
  `<a href="/">kuhwa</a> <span class="sep">›</span> <span>전체 서비스</span>`;

let template = readFileSync(TEMPLATE_PATH, "utf8");
for (const ph of ["<!--TREE-->", "<!--ROWS-->", "<!--BREADCRUMB-->"]) {
  if (!template.includes(ph)) {
    console.error(`❌ 템플릿에 자리표시자 ${ph} 없음 — 빌드 중단`);
    process.exit(1);
  }
}
const builtComment =
  `<!-- built from taxonomy/concepts.yml (scheme=${scheme.id} v${scheme.version} updated=${scheme.updated}) -->\n`;
template = template
  .replace("<!--TREE-->", treeHtml)
  .replace("<!--ROWS-->", rowsHtml)
  .replace("<!--BREADCRUMB-->", breadcrumbHtml)
  .replace(/(<meta name="description"[^>]*>\n)/, `$1${builtComment}`);

// ---- 규칙7: 산출 HTML의 portal-row 개수 = 리프 수 ----
const rowCount = (template.match(/data-testid="portal-row"/g) || []).length;
if (rowCount !== leaves.length) {
  console.error(`❌ 규칙7: portal-row ${rowCount}개 ≠ 리프 ${leaves.length}개 — 빌드 중단`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_PATH, template);
console.log(`✅ 규칙1~7 통과 — concepts ${concepts.length}개 / 리프 ${leaves.length}개 → ${OUT_PATH}`);
