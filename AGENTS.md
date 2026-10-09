# kuhwa — Agent Rules (AGENTS.md)

> **Inherited from devforge canonical rules** — `devforge:/home/opc/AGENTS.md` (2026-10-09).
> Canonical lives on devforge and is the only rules file to edit upstream. This file carries the
> **host-independent rules verbatim** (§0, §3–§9, §12) and replaces only host-specific sections
> (§1, §2, §10, §11). **On conflict the canonical file wins** — re-sync by diffing against it.
> Do not edit inherited sections locally; propose changes upstream, then re-copy.
> Repo-scoped copy: `devforgekor/kuhwa` → `/opt/kuhwa`. Ops SSOT: `Obsidian/kuhwa/…핸드오버…`.

---

## 0. Guardrails (highest priority)
- User request / issue / project policy is the final truth.
- Tests are evidence, not intent. On conflict, ASK — never guess.
- Never guess under uncertainty; ask instead.
- Never auto-commit / push / create PRs / switch branches unless explicitly asked.
- Never weaken, delete, or skip tests (`skip` / `only`) to make them pass.
- Never print, log, or commit secrets. Secrets live in **Azure Key Vault** (`kv-common-prod-krc`);
  never echo secret values to stdout/logs — mask or hash only. The git helper
  `/home/ubuntu/.local/bin/git-credential-kv.py` returns them into memory only.
  `az keyvault secret show -o tsv` to a terminal/log is forbidden.
- Get explicit approval before large refactors, public API changes, data migrations.

## 1. Commands (verified — 2026-10-09)

```bash
# deps (uv, one lock per app)          run inside the app dir
cd /opt/kuhwa/apps/cashbook  && uv sync --frozen
cd /opt/kuhwa/apps/timetable && uv sync --frozen
cd /opt/kuhwa/etxfetch       && uv sync --frozen

# services / containers
systemctl status etxfetch nginx rsyslog docker --no-pager
docker compose -f /opt/kuhwa/docker-compose.yml ps     # etextbook · pdf2sheet (+ kuhwa)
docker compose -f /opt/kuhwa/docker-compose.yml up -d --build

# host
sudo ufw status verbose                 # kuhwa 방화벽 = ufw (firewalld 미설치)
systemctl list-timers | grep rsyslog-tls-renew

# HTTP evidence (the repo's only executable check today)
curl -sI https://<host>/ | head -1
```

- **테스트 스위트·ruff·mypy 없음** (2026-10-09 실측: `test_*.py`·`conftest.py`·`ruff.toml`·
  `pytest.ini` 0건, CI는 `update-schedule.yml` 1개뿐). 따라서 "done" 주장의 근거는
  **실측 HTTP/서비스 상태**이며, 반드시 결과를 리포트에 남긴다.
- Python 3.12.3 · uv 0.12.24 · Docker (podman 아님) · systemd **255**

## 2. Boundaries
- ALWAYS: run the executable check above before declaring done; report the evidence.
- ASK FIRST: new files; new dependencies; editing `docs`/`README.md`/`AGENTS.md`; schema /
  migrations; cross-app edits; `docker-compose.yml` changes; Vercel `rootDirectory` changes.
- NEVER: commit secrets; auto-commit / push; duplicate rules into copies (edit canonical
  upstream instead); weaken checks; change firewall (`ufw`) rules without asking;
  touch `/etc/nginx/sites-available/` outside `deploy/nginx/`.
- **`systemd-analyze --user …` is banned on this class of host (inherited precaution).**
  Upstream bug systemd#36540 — `verify` unlinks→binds a private user-manager socket and leaves
  an orphan inode; live listeners lose the pathname → `ECONNREFUSED`, services die.
  Fixed in v258 (#36719); **devforge (252) crashed twice (2026-10-06)**. kuhwa runs **255**
  (still pre-fix) — treat the same ban. Safe alternative:
  `/usr/lib/systemd/user-generators/podman-user-generator <in> <in> <tmpdir>` (not applicable
  here — no Quadlet on kuhwa). Recovery if hit: `systemctl --user daemon-reexec`.

## 3. Communication
- User-facing responses: Korean. Machine-readable (identifiers, logs, prompts, commits, DB): English.
- All LLM prompt strings: English (prompts are machine instructions).
- Internals (logs, timers): UTC. User-facing times: KST (UTC+9).
- Docs: human-facing Korean (≤400 lines); machine-readable English.
- Be concise. Never echo secrets.
- **Code is SSOT**: when code and docs disagree, the code is correct — update the doc.

## 4. Context priority
- Reading: tests → type hints / structure → git log / blame → comments (WHY / WARNING only).
- Writing: user requirements → tests → type hints / structure → git history → comments.

## 5. Code
- Explicit > clever. Pure functions; isolate I/O, network, DB, time, random at boundaries.
- Errors explicit (types / result objects). No bare `except`. Retry with Tenacity or a loop.
- Python: never `utcnow()`; stdlib before third-party.
- Red → Green. Refactor only when asked.
- Search before adding; ≥70% overlap → extend the existing file.
- New file only with approval; state why existing files are insufficient.
- Dead code is worse than none. Keep the file count low. Surgical changes; preserve behavior.
- Respect bounded contexts; do not modify files outside the assigned app without asking.
- CAUTION: over-engineering → warn; proceed only if repeated.

## 6. Comments
- Comments explain WHY, never WHAT / WHEN.
- Allowed: `[WHY]` business rule · `[WARNING]` do-not-touch · `[WORKAROUND]` external bug.
- Forbidden: `# add A and B`, `# fixed bug 2024-09`, `# TODO` (use the issue tracker).
- No divider comments, no trivial docstrings. Function name = what it does.
- Public API docstrings stay. Complex algorithms / regex / security may be documented.

## 7. File header (every `.py`)
```python
#!/usr/bin/env python3
# Status: production|experimental|deprecated
# Path: <callers — or "none — reason">
"""<one-line summary>"""
```
- `Status` is SSOT for risk triage: production → P0 fix · experimental → warn · deprecated → do not modify.
- Missing header → treat as production.

## 8. Tests
- Descriptive names: `test_should_<behavior>_<condition>`.
- Edge cases: 0, null, negative, empty, boundaries, permissions, concurrency.
- Behavior change → add/update tests. Legacy refactor → characterization test first.
- **No suite exists in this repo** — so behavior change evidence = the §1 executable check
  (HTTP status, container health, service state) recorded in the commit/report.
- Never claim done without evidence.

## 9. Git
- Conventional Commits: `feat|fix|refactor|test|docs|chore(scope): ...`.
- **Commit messages are English** (§3 — machine-readable).
- Small, logical commits; never mix behavior change with formatting / refactor.
- **Commit triggers** (no per-commit approval, no `auto: sync` on main — main is intent-only):
  - a commit-time just before each push (KST 12:00/24:00) and session end;
  - each trigger emits SEPARATE logically-grouped commits — never one lumped commit;
  - group criteria: (1) one revertable concern per commit — `scope` = feature/domain,
    type = change character; (2) tests + related SSOT docs ride with their code in the same
    commit; (3) state/runtime files → the `chore(state)` group; (4) mirrors
    (`deploy/`, `etxfetch/etxfetch.service`) are repo-as-SSOT — commit with the code.
- Bot/automation commits are **noise, not history**: `Auto-sync: …`, `auto: workspace sync …`,
  `chore: update NEIS schedule data`, `chore: update auto-generated state files` —
  exclude them when reading history or judging change.
- PR only on request: Context / Changes / Verification / Risks.

## 10. Workflow
- **Evaluation-first**: define pass/fail criteria before implementing; verify before claiming done.
- Trivial (typo, comment, log/const, docs-only): edit, run the §1 check, done.
- Non-trivial: requirements → read existing code → git context → narrow scope → plan / ask →
  implement → §1 check → report (commit per §9 triggers; PR only if asked).
- Host changes (services, ufw, nginx, rsyslog, cron) → record in the handover doc (§5 log).

## 11. Pointers (do not duplicate content)
- **Ops SSOT (handover)**: `Obsidian/kuhwa/30_Responses/kuhwa-핸드오버-2026-10-07.md`
- **Plan / design**: `Obsidian/kuhwa/30_Responses/kuhwa-모노레포-계획.md`
- **Repo**: `/opt/kuhwa` → `https://github.com/devforgekor/kuhwa.git`
- **Canonical agent rules**: `devforge:/home/opc/AGENTS.md` (this file inherits from it)
- **Secrets / Key Vault**: `kv-common-prod-krc` via `/home/ubuntu/.local/bin/git-credential-kv.py` (values never printed)
- **Vercel**: `kuhwa` · `mini-cashbook` · `mini-timetable` (token: KV `VERCEL-TOKEN-KEY`)
- Backups: `/opt/kuhwa/deploy/backup/kuhwa-state-backup.sh` (cron 00:00 KST) · `~/kuhwa-backup.log`

## 12. Philosophy
> Intent → issues / requirements. Verification → tests. History → git/PR. Warnings → comments.
