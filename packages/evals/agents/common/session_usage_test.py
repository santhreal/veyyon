"""Behavioral unit tests for session usage aggregation."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from common.session_usage import Usage, aggregate_usage


class SessionUsageTest(unittest.TestCase):
    def test_two_session_directory_sums_tokens_costs_and_counts_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            sess_dir = Path(tmpdir)
            file1 = sess_dir / "sess1.jsonl"
            file2 = sess_dir / "sess2.jsonl"

            lines1 = [
                json.dumps({
                    "message": {
                        "role": "assistant",
                        "usage": {
                            "input": 100,
                            "output": 50,
                            "cacheRead": 20,
                            "cacheWrite": 10,
                            "cost": {"total": 0.05},
                        },
                        "content": [
                            {"type": "toolCall", "name": "read"},
                            {"type": "text", "text": "reading"},
                            {"type": "toolCall", "name": "edit"},
                        ],
                    }
                }),
                json.dumps({
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": "user message"}],
                    }
                }),
            ]
            file1.write_text("\n".join(lines1) + "\n", encoding="utf-8")

            lines2 = [
                json.dumps({
                    "message": {
                        "role": "assistant",
                        "usage": {
                            "input": 200,
                            "output": 80,
                            "cacheRead": 40,
                            "cacheWrite": 0,
                            "cost": {"total": 0.10},
                        },
                        "content": [
                            {"type": "toolCall", "name": "read"},
                            {"type": "toolCall", "name": "bash"},
                        ],
                    }
                }),
            ]
            file2.write_text("\n".join(lines2) + "\n", encoding="utf-8")

            usage = aggregate_usage(sess_dir, "omp")
            self.assertEqual(usage.input_tokens, 300)
            self.assertEqual(usage.output_tokens, 130)
            self.assertEqual(usage.cache_tokens, 70)
            self.assertAlmostEqual(usage.cost_usd, 0.15)
            self.assertEqual(usage.tool_calls, {"read": 2, "edit": 1, "bash": 1})

    def test_malformed_lines_and_non_assistant_messages_are_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            sess_dir = Path(tmpdir)
            file1 = sess_dir / "mixed.jsonl"
            lines = [
                "not json at all",
                json.dumps({"role": "system", "message": None}),
                json.dumps({"message": {"role": "system", "usage": {"input": 999}}}),
                json.dumps({"message": {"role": "user", "usage": {"input": 500}}}),
                "",
                json.dumps({
                    "message": {
                        "role": "assistant",
                        "usage": {"input": 42, "output": 8, "cacheRead": 2, "cacheWrite": 3, "cost": {"total": 0.01}},
                        "content": [{"type": "toolCall", "name": "read"}, {"type": "unknown"}],
                    }
                }),
                "   ",
            ]
            file1.write_text("\n".join(lines) + "\n", encoding="utf-8")

            usage = aggregate_usage(sess_dir, "omp")
            self.assertEqual(usage.input_tokens, 42)
            self.assertEqual(usage.output_tokens, 8)
            self.assertEqual(usage.cache_tokens, 5)
            self.assertAlmostEqual(usage.cost_usd, 0.01)
            self.assertEqual(usage.tool_calls, {"read": 1})

    def test_missing_directory_returns_zero_usage(self) -> None:
        missing = Path("/nonexistent/sessions/dir")
        usage = aggregate_usage(missing, "omp")
        self.assertEqual(
            usage,
            Usage(
                input_tokens=0,
                output_tokens=0,
                cache_tokens=0,
                cost_usd=0.0,
                tool_calls={},
            ),
        )

    def test_unknown_dialect_is_refused_and_names_dialect_and_supported_set(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            aggregate_usage(Path("/some/path"), "unsupported_dialect")
        msg = str(ctx.exception)
        self.assertIn("unsupported_dialect", msg)
        self.assertIn("omp", msg)


if __name__ == "__main__":
    unittest.main()
