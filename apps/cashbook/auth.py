#!/usr/bin/env python3
# Status: production
# Path: main.py
"""Simple password-based cookie authentication."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from typing import Optional

from fastapi import Request, Response
from fastapi.responses import RedirectResponse

# Default password: "cashbook" — change via CASHBOOK_PASSWORD env var
PASSWORD = os.environ.get("CASHBOOK_PASSWORD", "cashbook")
COOKIE_NAME = "cb_session"
SECRET = os.environ.get("CASHBOOK_SECRET", secrets.token_hex(32))


def _hash_password(pw: str) -> str:
    return hashlib.sha256((pw + SECRET).encode()).hexdigest()


def verify_password(password: str) -> bool:
    return hmac.compare_digest(_hash_password(password), _hash_password(PASSWORD))


def set_session(response: Response) -> None:
    token = secrets.token_hex(32)
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        samesite="lax",
        max_age=86400 * 30,  # 30 days
    )


def clear_session(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME)


def is_authenticated(request: Request) -> bool:
    """Return True if a session cookie is present.

    Sessions are cookie-presence based: there is no server-side session store,
    so this only asserts that the browser completed the login flow. The previous
    implementation ended with `... or True`, making it always-True — a latent
    auth bypass that would have authorized every request regardless of cookie.
    The secure fix is a server-side/signed session (tracked separately); this
    change removes the unconditional bypass and matches require_auth().
    """
    return bool(request.cookies.get(COOKIE_NAME))


def require_auth(request: Request) -> Optional[RedirectResponse]:
    """인증 게이트 — 현재 열림 상태(2026-10-10).

    사용자 요청으로 비밀번호 인증을 제거했고, 이 함수는 항상 None 을 반환해
    인증을 건너뛴다. main.py 는 여전히 이 함수를 호출하므로, 추후 Google OAuth
    를 도입할 때는 게이트를 다시 넣으려면 이 함수 안만 고치면 된다.

    기존 로직(쿠키 존재 검사)은 아래와 같다 — 되돌릴 때 반드시 함께 복원할 것:
        if not request.cookies.get(COOKIE_NAME):
            return RedirectResponse("/login", status_code=302)

    ※ 되돌리기 = 이 커밋을 git revert. main.py 의 /login 라우트와
      templates/login.html 을 함께 복원해야 한다. 두쪽이 어긋나면
      / → /login → / 무한 리다이렉트가 발생한다.
    """
    return None
