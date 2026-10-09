#!/usr/bin/env python3
"""
打包 Gesture Pilot 扩展。

产出 dist/edge-gesture-pilot-<version>.zip
zip 根目录是 edge-gesture-pilot/，解压后直接选该文件夹「加载解压缩的扩展」。
"""
from __future__ import annotations

import json
import struct
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXT = ROOT / "edge-gesture-pilot"
DIST = ROOT / "dist"

ICON_DIR = EXT / "icons"
SIZES = (16, 32, 48, 128)

BG_BLUE = (24, 95, 165)   # #185FA5
BG_RED = (179, 38, 30)    # #B3261E  —— 录制中的状态色
FG = (255, 255, 255)

# 经典鼠标指针多边形，归一化到 0..1
ARROW = [
    (0.00, 0.00),
    (0.00, 0.62),
    (0.165, 0.47),
    (0.28, 0.72),
    (0.40, 0.66),
    (0.29, 0.42),
    (0.50, 0.42),
]
ARROW_SCALE = 0.95
ARROW_OFFSET = (0.27, 0.16)
CORNER_RADIUS = 0.22

POLY = [(ARROW_OFFSET[0] + x * ARROW_SCALE, ARROW_OFFSET[1] + y * ARROW_SCALE) for x, y in ARROW]


# --------------------------------------------------------------------------- #
# 纯标准库 PNG 编码（无第三方依赖）
# --------------------------------------------------------------------------- #

def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def _in_round_rect(u: float, v: float, r: float) -> bool:
    cx = min(max(u, r), 1.0 - r)
    cy = min(max(v, r), 1.0 - r)
    dx, dy = u - cx, v - cy
    return dx * dx + dy * dy <= r * r


def _in_poly(u: float, v: float) -> bool:
    inside = False
    n = len(POLY)
    j = n - 1
    for i in range(n):
        xi, yi = POLY[i]
        xj, yj = POLY[j]
        if (yi > v) != (yj > v):
            x_at = (xj - xi) * (v - yi) / (yj - yi) + xi
            if u < x_at:
                inside = not inside
        j = i
    return inside


def render_png(size: int, bg: tuple[int, int, int], ss: int = 4) -> bytes:
    """4x4 超采样，边缘自带抗锯齿。"""
    inv = 1.0 / ss
    total = ss * ss
    raw = bytearray()

    for py in range(size):
        raw.append(0)  # 每行的 filter 类型
        for px in range(size):
            ar = ag = ab = aa = 0.0
            for sy in range(ss):
                v = (py + (sy + 0.5) * inv) / size
                for sx in range(ss):
                    u = (px + (sx + 0.5) * inv) / size
                    if not _in_round_rect(u, v, CORNER_RADIUS):
                        continue
                    r, g, b = FG if _in_poly(u, v) else bg
                    ar += r
                    ag += g
                    ab += b
                    aa += 1.0
            if aa > 0:
                raw += bytes(
                    (
                        round(ar / aa),
                        round(ag / aa),
                        round(ab / aa),
                        round(255.0 * aa / total),
                    )
                )
            else:
                raw += b"\x00\x00\x00\x00"

    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )


def build_icons() -> list[Path]:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    written = []
    for size in SIZES:
        for name, bg in (("icon", BG_BLUE), ("rec", BG_RED)):
            path = ICON_DIR / f"{name}{size}.png"
            path.write_bytes(render_png(size, bg))
            written.append(path)
    return written


# --------------------------------------------------------------------------- #
# 打包
# --------------------------------------------------------------------------- #

IGNORE_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}

# 仓库根目录的 README 会被同步进扩展目录，这样解压 zip 的人也有文档，
# 而且始终以仓库根目录为唯一来源，不会两边走散。
DOCS = [
    ("README.zh-CN.md", "README.md"),      # 随包主文档（中文）
    ("README.md", "README.en.md"),         # 英文版一并带上
]


def sync_docs() -> list[tuple[str, int]]:
    synced = []
    for src_name, dst_name in DOCS:
        src = ROOT / src_name
        if not src.exists():
            print(f"  ! 跳过 {src_name}（不存在）")
            continue
        dst = EXT / dst_name
        text = src.read_text(encoding="utf-8")
        dst.write_text(text, encoding="utf-8")
        synced.append((dst_name, len(text)))
    return synced


def load_version() -> str:
    manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
    return manifest["version"]


def collect_files() -> list[Path]:
    out = []
    for p in sorted(EXT.rglob("*")):
        if not p.is_file():
            continue
        if p.name in IGNORE_NAMES or p.suffix == ".pyc":
            continue
        if "__pycache__" in p.parts:
            continue
        out.append(p)
    return out


def verify_manifest() -> None:
    manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
    refs: list[str] = [manifest["background"]["service_worker"], manifest["action"]["default_popup"]]
    for cs in manifest.get("content_scripts", []):
        refs += cs.get("js", [])
    refs += list(manifest.get("icons", {}).values())
    refs += list(manifest["action"].get("default_icon", {}).values())

    missing = [r for r in refs if not (EXT / r).exists()]
    if missing:
        raise SystemExit("manifest 引用了不存在的文件：\n  " + "\n  ".join(missing))
    print(f"  manifest 引用完整（{len(refs)} 项）")


def build_zip(version: str) -> Path:
    DIST.mkdir(exist_ok=True)
    out = DIST / f"edge-gesture-pilot-{version}.zip"
    files = collect_files()

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            arc = (Path("edge-gesture-pilot") / p.relative_to(EXT)).as_posix()
            z.write(p, arc)

    # 自检：确认 manifest.json 在顶层文件夹根下
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert "edge-gesture-pilot/manifest.json" in names, "manifest.json 不在 zip 根目录"
        bad = z.testzip()
        assert bad is None, f"zip 损坏：{bad}"

    return out


def main() -> None:
    print("Gesture Pilot 打包")
    print("-" * 52)

    print("[1/4] 同步文档")
    for name, size in sync_docs():
        print(f"  {name:<28} {size:>7,} B")

    print("[2/4] 生成图标")
    icons = build_icons()
    for p in icons:
        print(f"  {p.relative_to(EXT).as_posix():<28} {p.stat().st_size:>7,} B")

    print("[3/4] 校验 manifest")
    verify_manifest()

    print("[4/4] 打包 zip")
    version = load_version()
    out = build_zip(version)

    files = collect_files()
    total = sum(p.stat().st_size for p in files)
    print("-" * 52)
    print(f"  版本      {version}")
    print(f"  文件数    {len(files)} 个，解压后 {total:,} B")
    print(f"  产物      {out}")
    print(f"  大小      {out.stat().st_size:,} B")
    print()
    print("安装：解压 → edge://extensions → 开发者模式 → 加载解压缩的扩展 → 选 edge-gesture-pilot 文件夹")


if __name__ == "__main__":
    main()
