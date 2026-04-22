"""Convert a Zen3 PNG-frame ZIP export into an MP4 using FFmpeg.

Usage:
    python export_video.py path/to/sim_<seed>_frames.zip
    python export_video.py path/to/sim_<seed>_frames.zip -o out.mp4 --crf 18

The ZIP produced by the "Export PNG frames" button contains:
    frame_000000.png, frame_000001.png, ...
    scenario.json     (full scenario, seed + all objects + params)
    manifest.json     ({"fps", "frames", "width", "height", "ffmpeg_hint"})

Determinism: because the frames are rendered from a fixed seed with a fixed
dt, the resulting MP4 is pixel-identical to what the user saw on screen.

Requires: FFmpeg available on PATH. Python 3.8+.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def extract_zip(zip_path: Path, target: Path) -> dict:
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(target)
    manifest_path = target / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit("manifest.json missing from archive; is this a Zen3 export?")
    return json.loads(manifest_path.read_text())


def run_ffmpeg(frames_dir: Path, out_path: Path, fps: int, crf: int, audio: Path | None) -> None:
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(fps),
        "-i", str(frames_dir / "frame_%06d.png"),
    ]
    if audio is not None:
        cmd += ["-i", str(audio), "-c:a", "aac", "-b:a", "192k", "-shortest"]
    cmd += [
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-crf", str(crf),
        "-preset", "medium",
        "-movflags", "+faststart",
        str(out_path),
    ]
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a Zen3 PNG-frame ZIP into MP4")
    parser.add_argument("zip", type=Path, help="Path to frames ZIP")
    parser.add_argument("-o", "--output", type=Path, default=None, help="Output MP4 path")
    parser.add_argument("--crf", type=int, default=18, help="x264 CRF quality (lower = better, 18 = visually lossless)")
    parser.add_argument("--fps", type=int, default=None, help="Override FPS (defaults to manifest value)")
    parser.add_argument("--audio", type=Path, default=None, help="Optional audio file to mux in")
    args = parser.parse_args()

    if not args.zip.exists():
        raise SystemExit(f"ZIP not found: {args.zip}")
    if not ffmpeg_available():
        raise SystemExit("FFmpeg not found on PATH. Install from https://ffmpeg.org/download.html")

    out_path = args.output or args.zip.with_suffix(".mp4")
    with tempfile.TemporaryDirectory(prefix="zen3_") as tmp:
        tmp_path = Path(tmp)
        print(f"Extracting {args.zip.name} ...")
        manifest = extract_zip(args.zip, tmp_path)
        fps = args.fps or int(manifest.get("fps", 60))
        frames = manifest.get("frames", "?")
        print(f"Encoding {frames} frames @ {fps} fps -> {out_path.name}")
        run_ffmpeg(tmp_path, out_path, fps=fps, crf=args.crf, audio=args.audio)

    print(f"\n✔ Done: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
