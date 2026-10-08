#!/usr/bin/env python3
"""etxfetch — kuhwa 전자교과서 온디맨드 캐시 페처

nginx 의 `@etx_fetch` location 이 캐시 미스를 넘겨주면 object storage 에서
해당 객체를 받아 캐시에 쓰고 `X-Accel-Redirect` 로 되돌려 준다.

동시에 그 객체가 속한 unit(레슨 단위 등)을 LOW 우선순위 백그라운드 큐에 넣어
같은 묶음을 미리 받아 둔다. 사용자의 챕터 클릭이 곧 prefetch 트리거다.

  GET  /            상태 JSON
  POST /prefetch/<unit>   LOW 강제 enqueue
  GET  /_ping       health

nginx 는 miss 시 `X-Original-URI` 헤더로 원래 요청 URI 를 보낸다.
"""

from __future__ import annotations

import json
import os
import re
import signal
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Queue
from urllib.parse import unquote

import oci

# ------------------------------------------------------------------ config
CACHE_ROOT = Path("/data/cache/app/etextbook")
URI_PREFIX = "/app/etextbook"
BUCKET = "etextbook-test"
NAMESPACE = "nrhe1zafhd0v"
CACHE_CAP = int(float(os.environ.get("ETX_CACHE_CAP_GIB", "5")) * 1024**3)
HOST, PORT = "127.0.0.1", 8090
LOW_WORKERS = 3
# 단위 내 병렬 fetch 수. 작은 객체는 중앙값 119ms 의 요청 레이턴시가 지배적이므로
# 4~6으로 병렬화해야 단위 완료 시간이 크게 줄어든다.
FETCH_WORKERS = 4
MAX_RETRIES = 3
PROTECTED_UNITS = {"base", "share"}
STATE_FILE = Path("/var/lib/etxfetch/state.json")
RETRY_BACKOFF = (0.5, 1.5, 4.0)

umask = os.umask(0o027)

# ------------------------------------------------------------------ logging
def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}", flush=True)


# ------------------------------------------------------------------ oci
# 인스턴스 자격증(Instance Principals) 사용. 서버에 API 키/설정파일을 두지 않는다.
# 전제: dynamic group `kuhwa-instance` + policy `kuhwa-instance-principals`
#       (allow dynamic-group kuhwa-instance to manage object-family in tenancy)
_tls = threading.local()


def _signer():
    # 스레드마다 하나씩. SecurityTokenSigner 는 만료 시 sign() 중 자동 갱신한다.
    s = getattr(_tls, "signer", None)
    if s is None:
        s = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
        _tls.signer = s
    return s


def client():
    c = getattr(_tls, "client", None)
    if c is None:
        s = _signer()
        c = oci.object_storage.ObjectStorageClient(config={}, signer=s, region=s.region)
        _tls.client = c
    return c


# ------------------------------------------------------------------ unit 매핑
LESSON_RE = re.compile(r"^(?:data|contents)/1/(lesson\d+|공통자료)/")


def unit_of(key: str) -> str | None:
    if key.startswith("ebook/1/ebook.epub/"):
        return "ebook-epub"
    m = LESSON_RE.match(key)
    if m:
        return f"lesson:{m.group(1)}"
    if key.startswith("_share/"):
        return "share"
    if key.startswith("include/") or key.startswith("ebook/1/"):
        return "base"
    return None


def prefixes_of(unit: str) -> list[str]:
    if unit.startswith("lesson:"):
        name = unit.split(":", 1)[1]
        return [f"data/1/{name}/", f"contents/1/{name}/"]
    if unit == "ebook-epub":
        return ["ebook/1/ebook.epub/"]
    if unit == "share":
        return ["_share/"]
    if unit == "base":
        return ["include/", "ebook/1/"]
    return []


def decode_uri(raw: str) -> str:
    """nginx $uri 를 복원한다.

    nginx 는 디코딩된 UTF-8 경로를 X-Original-URI 헤더로 보내는데, HTTP 헤더는
    latin-1 로 디코딩되므로 한글이 mojibake 로 들어온다(이미지 -> ìë¸ì).
    원본 바이트(latin-1) 를 다시 UTF-8 로 읽고 남아있을 수 있는 '%' 를 푼다.
    ($uri 는 쿼리스트링이 없는 정규화 경로이므로 split('?') 도 함께 수행.)
    """
    raw = raw.split("?", 1)[0]
    if raw.isascii():
        return unquote(raw)
    try:
        raw = raw.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    return unquote(raw)


def uri_to_key(uri: str) -> str | None:
    if not uri.startswith(URI_PREFIX):
        return None
    p = uri[len(URI_PREFIX):]
    if p.startswith("/resource/"):
        return p[len("/resource/"):]
    if p.startswith("/_share/"):
        return "_share/" + p[len("/_share/"):]
    return p.lstrip("/")


def uri_to_cache(uri: str) -> Path | None:
    if not uri.startswith(URI_PREFIX):
        return None
    dest = (CACHE_ROOT / uri[len(URI_PREFIX):].lstrip("/")).resolve()
    if CACHE_ROOT.resolve() not in dest.parents and dest != CACHE_ROOT.resolve():
        return None
    return dest


def key_to_uri(key: str) -> str:
    """object storage 키 -> 공개 URI (_share 는 resource/ 가 아니라 루트)."""
    if key.startswith("_share/"):
        return f"{URI_PREFIX}/_share/{key[len('_share/'):]}"
    return f"{URI_PREFIX}/resource/{key}"


# ------------------------------------------------------------------ fetch
_locks_lock = threading.Lock()
_key_locks: dict[str, threading.Lock] = {}


def key_lock(key: str) -> threading.Lock:
    with _locks_lock:
        lk = _key_locks.get(key)
        if lk is None:
            lk = _key_locks[key] = threading.Lock()
        return lk


def ensure_dirs(path: Path) -> None:
    # parents=True 로 CACHE_ROOT 아래 중간 디렉토리를 전부 만든다.
    # mode 는 0750 만 준다: systemd `RestrictSUIDSGID=true` 가 mkdir/chmod 에
    # setgid 비트를 심는 것을 seccomp 로 막아 EPERM 이 난다(파일 그룹은
    # `Group=www-data` 가 이미 보장한다).
    # 단, 부모가 eviction 등으로 사라질 수 있으므로 호출부는 재시도 루프 안에 둔다.
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)


def fetch_object(key: str, dest: Path) -> str:
    """성공='ok', 없음='404', 실패='error'."""
    # 빈 키(裸 디렉토리 URI 등)는 OCI SDK 가 ValueError 로 거절한다 → 404 로 통일.
    if not key or not key.strip():
        log(f"MISS 404 (empty key)")
        return "404"
    tmp = dest.with_name(f".{dest.name}.{os.getpid()}.{threading.get_ident()}.part")
    try:
        for attempt in range(MAX_RETRIES):
            try:
                # eviction 의 빈 디렉토리 정리와 경합하면 부모가 사라질 수 있으므로
                # 매 시도마다 다시 만든다(루프 안에 두어야 자체 복구가 된다).
                ensure_dirs(dest)
                resp = client().get_object(NAMESPACE, BUCKET, key)
                written = 0
                with open(tmp, "wb") as fh:
                    for chunk in resp.data.iter_content(chunk_size=1 << 20):
                        fh.write(chunk)
                        written += len(chunk)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.chmod(tmp, 0o640)
                os.replace(tmp, dest)
                log(f"HIT  {written:>10} B  {key}")
                return "ok"
            except oci.exceptions.ServiceError as e:
                if e.status == 404:
                    log(f"MISS 404 {key}")
                    return "404"
                log(f"ERR  svc {e.status} {key} ({e.code}) try={attempt + 1}")
            except Exception:
                log(f"ERR  exc {key} try={attempt + 1} {traceback.format_exc(limit=1)}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)])
        return "error"
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


# ------------------------------------------------------------------ unit prefetch
unit_locks: dict[str, threading.Lock] = {}
unit_locks_guard = threading.Lock()

inflight_units: set[str] = set()
inflight_guard = threading.Lock()

# miss(파일 단위) fetch 중인 unit. prefetch 와 분리해 보호한다.
miss_busy: set[str] = set()
miss_busy_guard = threading.Lock()

touch: dict[str, float] = {}
touch_guard = threading.Lock()


def touch_unit(unit: str) -> None:
    with touch_guard:
        touch[unit] = time.time()


def load_state() -> None:
    try:
        data = json.loads(STATE_FILE.read_text())
        with touch_guard:
            touch.update({k: float(v) for k, v in data.get("touch", {}).items()})
    except Exception:
        pass


def save_state() -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with touch_guard:
            snapshot = dict(touch)
        STATE_FILE.write_text(json.dumps(snapshot))
    except Exception:
        pass


def list_prefix(prefix: str) -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    start = None
    while True:
        kw = dict(prefix=prefix, fields="name,size", limit=1000)
        if start:
            # next_start_with 는 다음 페이지의 "첫" 객체다. start_after 에 넣으면
            # 그 객체가 건너뛰어 페이지마다 1건씩 유실된다(1000건 초과 프리픽스).
            kw["start"] = start
        page = client().list_objects(NAMESPACE, BUCKET, **kw)
        for o in page.data.objects:
            out.append((o.name, o.size))
        nxt = getattr(page.data, "next_start_with", None)
        if not nxt or len(page.data.objects) < 1000:
            break
        start = nxt
    return out


def prefetch_unit(unit: str) -> dict:
    prefixes = prefixes_of(unit)
    if not prefixes:
        return {"unit": unit, "status": "unknown-unit"}

    with unit_locks_guard:
        lk = unit_locks.setdefault(unit, threading.Lock())
    if not lk.acquire(blocking=False):
        return {"unit": unit, "status": "already-running"}

    skipped = failed = fetched = 0
    started = time.time()
    try:
        # 1) 목록 수집 + 이미 캐시된 것 스킵
        todo: list[tuple[str, Path]] = []
        for prefix in prefixes:
            try:
                objects = list_prefix(prefix)
            except Exception:
                log(f"ERR  list {prefix} {traceback.format_exc(limit=1)}")
                failed += 1
                continue
            for name, size in objects:
                dest = uri_to_cache(key_to_uri(name))
                if dest is None:
                    continue
                try:
                    if dest.is_file() and dest.stat().st_size == size:
                        skipped += 1
                        continue
                except OSError:
                    pass
                todo.append((name, dest))

        if not todo:
            touch_unit(unit)
            log(f"UNIT done={unit} new=0 skip={skipped} fail=0 "
                f"elapsed={time.time() - started:.1f}s (전부 캐시됨)")
            return {"unit": unit, "status": "done", "fetched": 0,
                    "skipped": skipped, "failed": 0,
                    "elapsed": round(time.time() - started, 1)}

        evict_if_needed()  # 단위 시작 시 1회

        # 2) 병렬 fetch — 작은 객체는 요청 레이턴시(중앙값 119ms)가 지배적이므로
        #    병렬화가 효과 크다. 큰 객체는 스트리밍이라 동시에도 안전하다.
        with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as ex:
            futs = {ex.submit(fetch_object, n, d): n for n, d in todo}
            for fut in as_completed(futs):
                res = fut.result()
                if res == "ok":
                    fetched += 1
                else:
                    failed += 1

        evict_if_needed()  # 단위 종료 시 1회
        touch_unit(unit)
        log(
            f"UNIT done={unit} new={fetched} skip={skipped} fail={failed} "
            f"elapsed={time.time() - started:.1f}s"
        )
        return {"unit": unit, "status": "done", "fetched": fetched,
                "skipped": skipped, "failed": failed,
                "elapsed": round(time.time() - started, 1)}
    finally:
        lk.release()
        with inflight_guard:
            inflight_units.discard(unit)


# ------------------------------------------------------------------ queue
low_q: "Queue[tuple[str, str]]" = Queue()


def enqueue(unit: str, reason: str = "manual") -> bool:
    if unit in PROTECTED_UNITS and reason == "auto":
        pass  # share/base 도 자동 prefetch 허용 (이미 웜이면 전부 skip)
    with inflight_guard:
        if unit in inflight_units:
            return False
        inflight_units.add(unit)
    low_q.put((unit, reason))
    log(f"ENQ {unit} ({reason})")
    return True


def low_worker(idx: int) -> None:
    while True:
        unit, reason = low_q.get()
        try:
            prefetch_unit(unit)
        except Exception:
            log(f"ERR  worker{idx} {unit} {traceback.format_exc(limit=1)}")
            with inflight_guard:
                inflight_units.discard(unit)
        finally:
            low_q.task_done()


# ------------------------------------------------------------------ eviction
def iter_cache_files():
    for root, _dirs, files in os.walk(CACHE_ROOT):
        for fn in files:
            if fn.endswith(".part"):
                continue
            yield Path(root) / fn


def unit_of_path(p: Path) -> str | None:
    rel = str(p.relative_to(CACHE_ROOT))
    if rel.startswith("resource/"):
        return unit_of(rel[len("resource/"):])
    return unit_of(rel)


def unit_of_dir(p: Path) -> str | None:
    """디렉토리 경로의 소유 unit. 빈 디렉토리에도 적용되도록 끝에 '/' 를 붙인다."""
    try:
        rel = str(p.relative_to(CACHE_ROOT))
    except ValueError:
        return None
    if rel.startswith("resource/"):
        rel = rel[len("resource/"):]
    if not rel.endswith("/"):
        rel += "/"
    return unit_of(rel)


def evict_if_needed(protect: set[str] | None = None) -> None:
    try:
        total = 0
        per_unit: dict[str, int] = {}
        for f in iter_cache_files():
            try:
                sz = f.stat().st_size
            except OSError:
                continue
            total += sz
            u = unit_of_path(f)
            if u:
                per_unit[u] = per_unit.get(u, 0) + sz
        if total <= CACHE_CAP:
            return
        log(f"EVICT 시작 total={total / 1024**3:.2f}G cap={CACHE_CAP / 1024**3:.2f}G")
        with touch_guard:
            ts = dict(touch)
        with inflight_guard:
            busy = set(inflight_units)
        with miss_busy_guard:
            busy |= miss_busy
        # 진행 중인 unit 은 삭제하지 않는다(아직 미완성인데 통째로 날아간다).
        # protect 는 방금 fetch 로 채운 단위를 넘겨 바로 재삭제되는 낭비를 막는다.
        busy |= set(protect or ())
        victims = sorted(
            (u for u in per_unit if u not in PROTECTED_UNITS and u not in busy),
            key=lambda u: ts.get(u, 0),
        )
        for u in victims:
            if total <= CACHE_CAP:
                break
            removed = 0
            for f in list(iter_cache_files()):
                if unit_of_path(f) != u:
                    continue
                try:
                    sz = f.stat().st_size
                    f.unlink()
                    removed += sz
                except OSError:
                    pass
            # 빈 디렉토리 정리 (CACHE_ROOT 자체는 보호).
            # 반드시 victim unit 한정: 전체를 순회해 rmdir 하면 다른 unit 이 방금
            # 만든 디렉토리까지 지워, 동시에 진행 중 fetch 를 ENOENT 로 죽인다.
            for root, _dirs, _files in os.walk(CACHE_ROOT, topdown=False):
                p = Path(root)
                if p == CACHE_ROOT:
                    continue
                if unit_of_dir(p) != u:
                    continue
                try:
                    p.rmdir()  # 비어있으면 성공, 아니면 OSError → 무시
                except OSError:
                    pass
            total -= removed
            log(f"EVICT {u} -{removed / 1024**2:.1f}MiB -> {total / 1024**3:.2f}G")
    except Exception:
        log(f"ERR  evict {traceback.format_exc(limit=1)}")


# ------------------------------------------------------------------ status
def status() -> dict:
    total = 0
    per_unit: dict[str, int] = {}
    files = 0
    for f in iter_cache_files():
        try:
            sz = f.stat().st_size
        except OSError:
            continue
        files += 1
        total += sz
        u = unit_of_path(f) or "-"
        per_unit[u] = per_unit.get(u, 0) + sz
    with inflight_guard:
        running = sorted(inflight_units)
    with touch_guard:
        ts = dict(touch)
    return {
        "cache_bytes": total,
        "cache_gib": round(total / 1024**3, 3),
        "cache_cap_gib": round(CACHE_CAP / 1024**3, 3),
        "cache_files": files,
        "units_bytes": {k: v for k, v in sorted(per_unit.items())},
        "units_running": running,
        "queue_depth": low_q.qsize(),
        "unit_last_prefetch": ts,
    }


# ------------------------------------------------------------------ http
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "etxfetch"

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _accel(self, uri: str):
        self.send_response(200)
        self.send_header("X-Accel-Redirect", uri)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        # nginx 는 proxy_pass 에 URI 를 붙이지 않고 $uri 를 헤더로 보낸다.
        # 헤더가 있으면 항상 미스 처리(상태 엔드포인트와 절대 충돌하지 않는다).
        hdr = self.headers.get("X-Original-URI")
        path = self.path.split("?", 1)[0]
        if hdr:
            return self._miss(hdr, high=True)
        if path in ("/", "/status"):
            return self._json(status())
        if path == "/_ping":
            return self._json({"ok": True})
        if path.startswith(URI_PREFIX):
            return self._miss(path, high=True)
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/prefetch/"):
            unit = decode_uri(path[len("/prefetch/"):])
            ok = enqueue(unit, reason="manual")
            return self._json({"unit": unit, "queued": ok})
        return self._json({"error": "not found"}, 404)

    def _miss(self, uri: str, high: bool):
        # raw 는 mojibake 원본 그대로 두고 X-Accel-Redirect 에 되돌려 보낸다.
        # HTTP 헤더 인코딩(latin-1)이 그대로 원래 UTF-8 바이트로 되돌아오므로
        # 라운드트립이 성립하고, 캐시 적중 시 nginx 는 올바른 경로를 본다.
        # 키 계산/캐시 경로는 복원한 decode_uri 결과를 쓴다.
        raw = uri
        uri = decode_uri(raw)
        key = uri_to_key(uri)
        dest = uri_to_cache(uri)
        if key is None or dest is None:
            return self._json({"error": "bad uri", "uri": raw}, 400)

        if dest.is_file():
            return self._accel(raw)

        u = unit_of(key)
        # miss 로 fetch 하는 동안은 그 unit 을 eviction 에서 제외한다.
        # (inflight_units 와는 별개 — prefetch 진행 여부와 무관하게 파일 단위로 보호)
        if u:
            with miss_busy_guard:
                miss_busy.add(u)
        try:
            with key_lock(key):
                if dest.is_file():
                    return self._accel(raw)
                res = fetch_object(key, dest)
        finally:
            if u:
                with miss_busy_guard:
                    miss_busy.discard(u)

        if res != "ok":
            code = 404 if res == "404" else 502
            return self._json({"error": res, "key": key}, code)

        if u:
            enqueue(u, reason="auto")
        evict_if_needed(protect={u} if u else None)
        return self._accel(raw)


def sanitize_cache() -> None:
    """기동 시 정리. worker 를 띄우기 전에 호출한다.

    1) 재기동/강제종료로 남은 .part 잔재 제거(daemon thread 는 finally 를 못 돌 수 있다).
    2) 그룹 보정. 그룹이 www-data 가 아니면 nginx(www-data) 가 못 읽어 500 이 난다.
       특히 setgid 디렉토리는 자기 그룹을 파일에 상속하므로, 그룹이 엉망이면
       한 번에 수십 개가 오염된다. 서비스는 www-data 멤버이므로 owner 로서
       chgrp 가 가능하다(실패는 무시 — 소유권이 없는 항목).
    """
    gid = os.getgid()
    part = fixed = 0
    for root, dirs, files in os.walk(CACHE_ROOT):
        for fn in files:
            p = Path(root) / fn
            if fn.startswith(".") and fn.endswith(".part"):
                try:
                    p.unlink()
                    part += 1
                except OSError:
                    pass
                continue
            try:
                if os.stat(p).st_gid != gid:
                    os.chown(p, -1, gid)
                    fixed += 1
            except OSError:
                pass
        for dn in dirs:
            d = Path(root) / dn
            try:
                if os.stat(d).st_gid != gid:
                    os.chown(d, -1, gid)
                    fixed += 1
            except OSError:
                pass
    if part or fixed:
        log(f"SANITIZE .part={part} regrp={fixed} gid={gid}")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    load_state()
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    sanitize_cache()  # .part 잔재 제거 + 그룹 보정 (worker 시작 전)

    for i in range(LOW_WORKERS):
        t = threading.Thread(target=low_worker, args=(i,), daemon=True)
        t.start()

    srv = Server((HOST, PORT), Handler)

    def shutdown(signum, _frame):
        log(f"TERM {signal.Signals(signum).name}")
        save_state()
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    log(f"READY {HOST}:{PORT} cap={CACHE_CAP / 1024**3:.2f}G "
        f"root={CACHE_ROOT} workers={LOW_WORKERS}")
    # 부팅 시에도 상한을 강제한다(이전 실행에서 상한을 낮췄거나 캐시가 남아있는 경우)
    evict_if_needed()
    try:
        srv.serve_forever()
    finally:
        save_state()


if __name__ == "__main__":
    main()
