#!/usr/bin/env python3
"""Smoke test against a running faceswap sidecar (stdlib only).

  python scripts/smoke.py --url http://127.0.0.1:8791 --key "$FACESWAP_API_KEY" \
      --source sheet.png [--source portrait.png] --target a.jpg [--target b.jpg] --out ./out

For every target it writes: swap_<restorer>.jpg for codeformer/gfpgan/off, crop.png (face-crop) and
roundtrip.jpg (face-paste of the unmodified crop, which should look identical to the target), and prints timings.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def call(url: str, key: str, path: str, body: dict | None = None, timeout: float = 600) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url.rstrip("/") + path, data=data, method="POST" if data else "GET")
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("X-API-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def b64(p: Path) -> str:
    return base64.b64encode(p.read_bytes()).decode()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8791")
    ap.add_argument("--key", default="")
    ap.add_argument("--source", action="append", required=True, type=Path)
    ap.add_argument("--target", action="append", required=True, type=Path)
    ap.add_argument("--out", type=Path, default=Path("smoke-out"))
    ap.add_argument("--restorers", default="codeformer,gfpgan,off")
    ap.add_argument("--identity-mode", default="average")
    ap.add_argument("--target-faces", default="largest")
    ap.add_argument("--wait", type=float, default=900, help="seconds to wait for /health/ready")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)

    deadline = time.time() + a.wait
    while True:
        try:
            st, body = call(a.url, a.key, "/health/ready", timeout=10)
        except OSError as e:
            st, body = 0, {"error": str(e)}
        if st == 200:
            print("ready:", json.dumps(body))
            break
        if time.time() > deadline:
            print("not ready:", st, body)
            return 1
        time.sleep(3)

    sources = [b64(p) for p in a.source]
    ok = True
    for t in a.target:
        name = t.stem
        tb = b64(t)
        for restorer in a.restorers.split(","):
            t0 = time.time()
            st, r = call(a.url, a.key, "/v1/swap", {
                "target": tb, "sources": sources,
                "options": {"restorer": restorer, "identity_mode": a.identity_mode, "target_faces": a.target_faces},
            })
            wall = int((time.time() - t0) * 1000)
            if st != 200:
                print(f"[{name}] swap {restorer}: HTTP {st} {r}")
                ok = False
                continue
            ext = "png" if r["mime_type"] == "image/png" else "jpg"
            out = a.out / f"{name}_swap_{restorer}.{ext}"
            out.write_bytes(base64.b64decode(r["image"]))
            print(f"[{name}] swap {restorer}: {r['width']}x{r['height']} target_faces={r['target_faces']} "
                  f"source_faces={r['source_faces']} wall={wall}ms timings={r['timings_ms']} -> {out}")

        t0 = time.time()
        st, c = call(a.url, a.key, "/v1/face-crop", {"image": tb})
        if st != 200:
            print(f"[{name}] face-crop: HTTP {st} {c}")
            ok = False
            continue
        (a.out / f"{name}_crop.png").write_bytes(base64.b64decode(c["crop"]))
        print(f"[{name}] face-crop: box={c['box']} faces={c['faces']} wall={int((time.time() - t0) * 1000)}ms")

        t0 = time.time()
        st, p = call(a.url, a.key, "/v1/face-paste", {"base": tb, "patch": c["crop"], "box": c["box"]})
        if st != 200:
            print(f"[{name}] face-paste: HTTP {st} {p}")
            ok = False
            continue
        (a.out / f"{name}_roundtrip.jpg").write_bytes(base64.b64decode(p["image"]))
        print(f"[{name}] face-paste: {p['width']}x{p['height']} wall={int((time.time() - t0) * 1000)}ms")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
