#!/usr/bin/env python3
"""Verify a demo binary's HMAC-SHA256 release signature."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import os
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("signature", type=Path)
    parser.add_argument(
        "--key",
        default=os.environ.get("RELEASE_SIGNATURE"),
        help="signing key; defaults to $RELEASE_SIGNATURE",
    )
    args = parser.parse_args()

    if not args.key:
        parser.error("pass --key or set RELEASE_SIGNATURE")
    if not args.binary.is_file():
        parser.error(f"binary does not exist: {args.binary}")
    if not args.signature.is_file():
        parser.error(f"signature does not exist: {args.signature}")

    fields = args.signature.read_text(encoding="utf-8").strip().split()
    if not fields:
        parser.error(f"signature file is empty: {args.signature}")
    actual = fields[0].lower()
    expected = hmac.new(
        args.key.encode("utf-8"),
        args.binary.read_bytes(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(actual, expected):
        print(f"signature mismatch: expected {expected}, found {actual}")
        return 1

    print(f"signature verified: HMAC-SHA256 {actual}")
    print(f"binary: {args.binary.name} ({args.binary.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
