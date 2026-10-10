#!/usr/bin/env python3
# Status: production
# Path: imported by — calendar_sync/{session_service,oauth_service,db_migration}.py
"""Shared SQLite helpers for timetable (calendar_sync).

과거 이 파일은 PostgreSQL 전용이었다 (psycopg2 직접 연결 / podman psql subprocess).
kuhwa 자체호스팅 전환(Phase3) 이후 kuhwa에는 Postgres 가 없고, timetable 은 로그인
세션과 OAuth 토큰만 저장하면 되므로 **앱 전용 SQLite 파일**로 대체한다.
  - 서버·포트·계정·커넥션 풀 불필요 (SQLite 는 서버 프로세스가 없는 파일 기반 DB)
  - Python 표준 라이브러리 sqlite3 사용 → 의존성 추가 0
  - DB 파일은 /var/lib/kuhwa/timetable/ (systemd unit 의 ReadWritePaths 에 이미 등록됨)

공개 인터페이스는 과거와 동일하게 유지한다 — 호출부(session_service/oauth_service)는
함수명과 시그니처가 그대로여야 한다:
    from lib.db import psql, psql_ok, psql_json, esc_sql, db_table_exists, db_row_exists

PG → SQLite 호환 처리:
    NOW()  ->  datetime('now')   # SQLite 는 UTC 기준 'YYYY-MM-DD HH:MM:SS' 문자열 반환
    ON CONFLICT ... DO UPDATE SET ... = EXCLUDED.x  ->  그대로 지원 (SQLite 3.24+)

주의 — 문자열 이스케이프:
    SQLite 문자열 리터럴에서 이스케이프가 필요한 것은 따옴표('')뿐이다. 백슬래시는
    이스케이프 문자가 아니므로, 과거 PG용 escape_sql_string 처럼 '\\' -> '\\\\' 하면
    데이터가 그대로 손상된다. 그래서 이 스코프에서는 따옴표 치환만 수행한다.
"""

import json
import os
import re
import sqlite3
from typing import Any, Optional

DEFAULT_DB_PATH = "/var/lib/kuhwa/timetable/timetable.db"
DB_PATH = os.environ.get("TIMETABLE_SQLITE_PATH") or DEFAULT_DB_PATH

_NOW_RE = re.compile(r"\bNOW\(\)")


def _connect() -> sqlite3.Connection:
    """Open a fresh connection.

    FastAPI 가 sync 엔드포인트를 스레드풀에서 실행하므로 커넥션을 공유하면 안 된다.
    SQLite 는 파일 open 이 저렴하므로 호출마다 새로 연다.
    """
    parent = os.path.dirname(DB_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    # WAL: 읽기/쓰기 병렬화 (기본 journal 보다 동시성 좋음). 같은 파일시스템 필요.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def _to_sqlite(sql: str) -> str:
    """standalone NOW() 토큰만 datetime('now') 로 치환."""
    return _NOW_RE.sub("datetime('now')", sql)


def _exec(conn: sqlite3.Connection, sql: str) -> None:
    """단일/복수 문장을 모두 처리하고 커밋."""
    try:
        conn.execute(sql)
    except sqlite3.Error as e:
        # db_migration 등은 CREATE TABLE; CREATE INDEX; 복수 문장을 한 번에 넘긴다.
        # 파이썬 sqlite3 은 이를 OperationalError 가 아닌 ProgrammingError 로 던진다.
        if "one statement" in str(e).lower():
            conn.executescript(sql)
            conn.commit()
            return
        raise
    conn.commit()


def psql(sql: str, timeout: int = 30) -> str:
    """Execute SQL, return stripped first-column-of-first-row.

    (과거 psql --tuples-only semantics — SELECT 결과의 첫 행 첫 열 문자열)
    """
    sql = _to_sqlite(sql)
    try:
        conn = _connect()
        try:
            cur = conn.execute(sql)
            if cur.description:
                row = cur.fetchone()
                if row is None or row[0] is None:
                    return ""
                return str(row[0])
            conn.commit()
            return ""
        finally:
            conn.close()
    except Exception as e:
        print(f"  SQL ERROR: {e}")
        return ""


def psql_json(sql: str, timeout: int = 30) -> list[dict]:
    """Execute SELECT, return list of dicts.

    (과거는 row_to_json 으로 감싸 JSONL 을 파싱했다 — SQLite 는 Row 를 dict 로 바로 변환)
    """
    sql = _to_sqlite(sql)
    try:
        conn = _connect()
        try:
            cur = conn.execute(sql)
            if not cur.description:
                return []
            return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()
    except Exception as e:
        print(f"  SQL ERROR: {e}")
        return []


def psql_ok(sql: str, timeout: int = 30) -> bool:
    """Execute SQL, return True if it succeeded."""
    sql = _to_sqlite(sql)
    try:
        conn = _connect()
        try:
            _exec(conn, sql)
            return True
        finally:
            conn.close()
    except Exception as e:
        print(f"  SQL ERROR: {e}")
        return False


def db_table_exists(table: str) -> bool:
    """Check if table exists (과거 pg_tables → sqlite_master)."""
    try:
        conn = _connect()
        try:
            cur = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (table,),
            )
            return cur.fetchone() is not None
        finally:
            conn.close()
    except Exception:
        return False


def db_row_exists(sql: str) -> bool:
    """Check if query returns any rows."""
    sql = _to_sqlite(sql)
    try:
        conn = _connect()
        try:
            cur = conn.execute(sql)
            return cur.fetchone() is not None
        finally:
            conn.close()
    except Exception:
        return False


def escape_sql_string(s: str) -> str:
    """Escape string for safe SQL literal interpolation (SQLite).

    따옴표('') 치환만 수행한다 — SQLite 는 백슬래시를 이스케이프 문자로 쓰지 않는다.
    """
    return s.replace("\x00", "").replace("'", "''")


esc_sql = escape_sql_string
