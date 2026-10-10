#!/usr/bin/env python3
# Status: experimental
# Path: standalone migration script — `python3 -m calendar_sync.db_migration`
"""Database migration for calendar_sync: create user_tokens table (SQLite).

과거 PostgreSQL TIMESTAMPTZ / TEXT[] 스키마를 SQLite TEXT 로 옮겼다.
  - TIMESTAMPTZ  -> TEXT   # 앱이 이미 .isoformat() 문자열로 저장한다
  - TEXT[]       -> TEXT   # 앱이 이미 PG 배열 리터럴 문자열로 저장한다
  - NOW()        -> (datetime('now'))  # SQLite 기본값 함수
"""

import sys
import os

SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, SCRIPTS_DIR)

from lib.db import psql_ok


CREATE_USER_TOKENS_TABLE = """
CREATE TABLE IF NOT EXISTS user_tokens (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_expiry TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_tokens_email ON user_tokens(email);
CREATE INDEX IF NOT EXISTS idx_user_tokens_expiry ON user_tokens(token_expiry);
"""


def main():
    print("Running calendar_sync database migration...")
    ok = psql_ok(CREATE_USER_TOKENS_TABLE)
    if ok:
        print("✓ user_tokens table created successfully")
    else:
        print("✗ Failed to create user_tokens table")
        sys.exit(1)


if __name__ == "__main__":
    main()
