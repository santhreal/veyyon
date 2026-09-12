#!/usr/bin/env python3
"""Unit tests for `parse_path_range` in `common.py`, the selector parser every
session-stats script shares: a bare path, a closed range, a relative offset,
a single anchor line, a `:raw` and a `:conflicts` suffix each map to one
(path, start, end, mode) tuple, and an unmatched trailing hyphen is kept as
part of the path rather than read as an open range.

Run: python3 -m unittest scripts/session-stats/test_selector_parsing.py
     (or `cd scripts/session-stats && python3 test_selector_parsing.py`)
"""

from __future__ import annotations

import unittest

from common import DEFAULT_PAGE, parse_path_range


class TestSelectorParsing(unittest.TestCase):
    def test_bare_path(self) -> None:
        self.assertEqual(parse_path_range("src/foo.ts"), ("src/foo.ts", None, None, "none"))

    def test_closed_range(self) -> None:
        self.assertEqual(parse_path_range("src/foo.ts:50-200"), ("src/foo.ts", 50, 200, "range"))

    def test_relative_offset(self) -> None:
        self.assertEqual(parse_path_range("src/foo.ts:50+150"), ("src/foo.ts", 50, 199, "range"))

    def test_single_line_offset(self) -> None:
        self.assertEqual(parse_path_range("src/foo.ts:20+1"), ("src/foo.ts", 20, 20, "range"))

    def test_single_anchor_open_ended_default_page(self) -> None:
        self.assertEqual(
            parse_path_range("src/foo.ts:50"),
            ("src/foo.ts", 50, 50 + DEFAULT_PAGE - 1, "range"),
        )

    def test_unmatched_trailing_hyphen(self) -> None:
        self.assertEqual(
            parse_path_range("src/foo.ts:50-"),
            ("src/foo.ts:50-", None, None, "none"),
        )

    def test_raw_selector(self) -> None:
        self.assertEqual(parse_path_range("src/foo.ts:raw"), ("src/foo.ts", None, None, "raw"))

    def test_conflicts_selector(self) -> None:
        self.assertEqual(
            parse_path_range("src/foo.ts:conflicts"),
            ("src/foo.ts", None, None, "conflicts"),
        )


if __name__ == "__main__":
    unittest.main()
