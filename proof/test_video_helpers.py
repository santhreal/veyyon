#!/usr/bin/env python3
"""Synthetic video unit and smoke tests for shared video helpers and hero-cut CLI."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tighten import PTS_TIME, duration, run


class TestVideoHelpersAndHeroCut(unittest.TestCase):
    def test_run_captures_output(self) -> None:
        out = run([sys.executable, "-c", "import sys; sys.stdout.write('hello\\n'); sys.stderr.write('err\\n')"])
        self.assertIn("hello", out)
        self.assertIn("err", out)

    def test_duration_handles_nonexistent_or_invalid_file(self) -> None:
        dur = duration(Path("/nonexistent/path/clip.mp4"))
        self.assertEqual(dur, 0.0)

    def test_pts_time_regex(self) -> None:
        matches = PTS_TIME.findall("frame:0 pts_time:1.234 extra pts_time:5.678")
        self.assertEqual(matches, ["1.234", "5.678"])

    def test_synthetic_video_duration_and_hero_cut_dry_run(self) -> None:
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            self.skipTest("ffmpeg or ffprobe not installed in environment")

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            take_path = tmp / "test_take.mp4"
            out_mp4 = tmp / "hero.mp4"

            # Generate a 3-second synthetic color-bar test video with distinct timestamps
            gen_cmd = [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=3:size=320x240:rate=10",
                "-pix_fmt",
                "yuv420p",
                str(take_path),
            ]
            gen_res = subprocess.run(gen_cmd, capture_output=True, text=True, check=False)
            self.assertEqual(gen_res.returncode, 0, f"ffmpeg failed: {gen_res.stderr}")

            # Verify shared duration() correctly measures the synthetic video
            dur = duration(take_path)
            self.assertGreaterEqual(dur, 2.8)
            self.assertLessEqual(dur, 3.2)

            # Test hero-cut.py CLI with --single and --dry-run
            hero_cut_script = Path(__file__).resolve().parent / "hero-cut.py"
            cli_cmd = [
                sys.executable,
                str(hero_cut_script),
                str(take_path),
                "--mp4",
                str(out_mp4),
                "--single",
                "--dry-run",
            ]
            cli_res = subprocess.run(cli_cmd, capture_output=True, text=True, check=False)
            self.assertEqual(cli_res.returncode, 0, f"hero-cut --dry-run failed: {cli_res.stderr}")
            self.assertIn("->", cli_res.stdout)


if __name__ == "__main__":
    unittest.main()
