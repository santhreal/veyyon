"""Regression coverage for dynamic model discovery in clean benchmark containers."""

from __future__ import annotations

import shlex
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from model_catalog_bootstrap import (
    build_model_catalog_refresh_command,
    build_status_preserving_tee_command,
)


class ModelCatalogBootstrapTest(unittest.TestCase):
    """Lock out zero-token trials caused by selecting before discovery."""

    def _binary(self, directory: Path, body: str) -> Path:
        binary = directory / "assets with spaces" / "vey"
        binary.parent.mkdir()
        binary.write_text(f"#!/bin/sh\n{body}\n")
        binary.chmod(0o755)
        return binary

    def _run(self, command: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["/bin/sh", "-c", command],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )

    def test_refresh_proves_the_exact_selector_with_shell_safe_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            selector = "google-antigravity/gemini-3.6-flash"
            payload = f'{{"models":[{{"selector":"{selector}"}}]}}'
            binary = self._binary(
                root,
                f"printf '%s\\n' {shlex.quote(payload)}",
            )
            log_path = root / "logs with spaces" / "catalog.json"
            log_path.parent.mkdir()

            command = build_model_catalog_refresh_command(
                str(binary),
                selector,
                str(log_path),
            )
            completed = self._run(command)

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("timeout -k 5s 120s", command)
            self.assertIn(f'"selector":"{selector}"', log_path.read_text())

    def test_missing_exact_selector_fails_and_surfaces_the_refresh_log(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = self._binary(
                root,
                "printf '%s\\n' '{\"models\":[]}'",
            )
            log_path = root / "catalog.json"
            selector = "google-antigravity/gemini-3.6-flash"

            completed = self._run(
                build_model_catalog_refresh_command(
                    str(binary),
                    selector,
                    str(log_path),
                )
            )

            self.assertEqual(completed.returncode, 1)
            self.assertIn(f"did not return {selector}", completed.stderr)
            self.assertIn('{"models":[]}', completed.stderr)

    def test_refresh_process_failure_preserves_status_and_surfaces_log(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = self._binary(root, "echo 'upstream unavailable'; exit 23")
            log_path = root / "catalog.json"

            completed = self._run(
                build_model_catalog_refresh_command(
                    str(binary),
                    "google-antigravity/gemini-3.6-flash",
                    str(log_path),
                )
            )

            self.assertEqual(completed.returncode, 23)
            self.assertIn("model catalog refresh failed", completed.stderr)
            self.assertIn("upstream unavailable", completed.stderr)

    def test_refresh_has_a_finite_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = self._binary(root, "sleep 3")
            log_path = root / "catalog.json"
            started = time.monotonic()

            completed = self._run(
                build_model_catalog_refresh_command(
                    str(binary),
                    "google-antigravity/gemini-3.6-flash",
                    str(log_path),
                    timeout_seconds=1,
                )
            )

            self.assertEqual(completed.returncode, 124)
            self.assertLess(time.monotonic() - started, 2.5)
            self.assertIn("model catalog refresh failed", completed.stderr)

    def test_rejects_malformed_or_option_like_selectors(self) -> None:
        malformed = (
            "gemini-3.6-flash",
            "/gemini-3.6-flash",
            "google-antigravity/",
            "google-antigravity//gemini-3.6-flash",
            "--json/gemini-3.6-flash",
            "provider;touch/model",
            "provider/model with spaces",
        )
        for selector in malformed:
            with self.subTest(selector=selector):
                with self.assertRaisesRegex(ValueError, "provider/model-id"):
                    build_model_catalog_refresh_command(
                        "/opt/veyyon-assets/vey",
                        selector,
                        "/logs/agent/model-catalog-refresh.txt",
                    )

    def test_status_preserving_tee_returns_wrapped_process_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log_path = root / "agent output.log"
            wrapped_body = "printf 'visible output\\n'; exit 17"
            wrapped = f"/bin/sh -c {shlex.quote(wrapped_body)}"
            command = build_status_preserving_tee_command(
                wrapped,
                str(log_path),
                str(root / "status file"),
            )

            completed = self._run(command)

            self.assertEqual(completed.returncode, 17)
            self.assertEqual(completed.stdout, "visible output\n")
            self.assertEqual(log_path.read_text(), "visible output\n")


if __name__ == "__main__":
    unittest.main()
