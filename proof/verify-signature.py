#!/usr/bin/env python3
"""Check a recorded signature against the number the session never displayed.

The take stores a number in the vault straight out of the environment, and the model
signs a file with the placeholder that stands in for it. What lands on disk is a
digest, so a reader can confirm the recording rather than trust it: hash the number
yourself and compare.

WHY THIS IS A SCRIPT AND NOT ONE `sha256sum` CALL. The digest depends on a byte the
model chooses, not on the credential: `printf '%s'` hashes the number, `echo` hashes
the number plus a newline, and both are reasonable readings of "pipe it into
sha256sum". A crosscheck that publishes one form calls the other a mismatch, which
would read as a failed signature when the signature is fine. So this hashes every
form a shell pipeline can produce and reports which one the file carries. A digest
that matches none of them is a real failure, and that is the case worth reporting.

It never prints the number. The number reaches it as an argument or an environment
variable and leaves in no output, because a verifier that echoes the credential
defeats the thing it is verifying.
"""

import argparse
import hashlib
import os
import re
import sys

# Every byte sequence a shell pipeline plausibly hands to sha256sum for one value:
# the value, the value with the newline `echo` adds, and the value with the CRLF a
# recording made on a Windows shell would carry.
FORMS = (
    ("no trailing newline (printf '%s')", ""),
    ("trailing newline (echo)", "\n"),
    ("trailing CRLF", "\r\n"),
)

# A hex digest on a line of its own or after a label, which is what the model was
# asked to append and what `sha256sum` prints.
DIGEST_RE = re.compile(r"\b([0-9a-f]{64})\b")

# WHERE THE DIGEST MAY BE READ FROM, which is not "anywhere in the file".
#
# The crosscheck the take writes prints the digests of the number itself, as the thing
# the reader is meant to compare against, and then the signed file below a marker. A
# verifier that scanned the whole file therefore matched its own reference line and
# reported success for a SIGNED.md whose digest was the other form entirely -- green
# for a reason other than the one it claimed, which is worth less than no check. Only
# the section below the marker counts, and within it only a `signature:` line.
MARKER = "--- SIGNED.md ---"
SIGNATURE_RE = re.compile(r"^\s*signature:\s*([0-9a-f]{64})\b", re.MULTILINE)


def signed_digests(text: str) -> list[str]:
    body = text.split(MARKER, 1)[1] if MARKER in text else text
    labelled = SIGNATURE_RE.findall(body)
    if labelled:
        return labelled
    # A bare SIGNED.md passed directly: no marker, no label, just what the model wrote.
    return [] if MARKER in text else DIGEST_RE.findall(body)


def digests(number: str) -> dict[str, str]:
    return {
        label: hashlib.sha256((number + suffix).encode("utf-8")).hexdigest()
        for label, suffix in FORMS
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "signed",
        help="file the session signed, or the crosscheck file the take wrote beside it",
    )
    parser.add_argument(
        "--number",
        default=os.environ.get("RELEASE_SIGNATURE"),
        help="the signing number; defaults to $RELEASE_SIGNATURE so it need not be typed",
    )
    args = parser.parse_args()

    if not args.number:
        print(
            "verify-signature: no number. Pass --number or set RELEASE_SIGNATURE.",
            file=sys.stderr,
        )
        return 2

    try:
        with open(args.signed, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError as error:
        print(f"verify-signature: cannot read {args.signed}: {error}", file=sys.stderr)
        return 2

    found = signed_digests(text)
    if not found:
        print(
            f"verify-signature: {args.signed} carries no signature digest. A crosscheck"
            " file must hold a 'signature:' line under its '--- SIGNED.md ---' marker.",
            file=sys.stderr,
        )
        return 1

    expected = digests(args.number)
    for label, digest in expected.items():
        if digest in found:
            print(f"signature matches: {label}")
            print(f"digest: {digest}")
            return 0

    # No match is the answer a reader needs in full: the digests that were looked for
    # and the ones the file carries, so the disagreement is visible without the number.
    print("signature does NOT match the number given.")
    for label, digest in expected.items():
        print(f"  expected, {label}: {digest}")
    for digest in dict.fromkeys(found):
        print(f"  found in file: {digest}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
