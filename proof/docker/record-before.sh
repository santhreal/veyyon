#!/usr/bin/env bash
# Record tapes against the code that is on `main`, without moving the branch.
#
#   proof/docker/record-before.sh <tape> [<tape>...]
#
# Every source file the branch changed is held at its `main` content for the
# length of the run, restored from an in-memory copy afterwards, and the restore
# proved by comparing sha256 before and after. Files the branch DELETED are
# written back for the run and removed again. No git mutation command is used:
# `git show` only reads, and the working tree ends byte-identical.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

python3 - "$@" <<'PY'
import hashlib, os, subprocess, sys

tapes = sys.argv[1:]
if not tapes:
    raise SystemExit("usage: record-before.sh <tape> [<tape>...]")

changed = subprocess.run(
    ["git", "diff", "--name-status", "main..HEAD", "--", "packages/*/src/*"],
    capture_output=True, text=True, check=True,
).stdout.split("\n")

held, deleted_by_branch = [], []
for line in changed:
    if not line.strip():
        continue
    status, path = line.split("\t")[0], line.split("\t")[-1]
    if status.startswith("D"):
        deleted_by_branch.append(path)
    elif status.startswith("M") or status.startswith("R"):
        held.append(path)
    # "A" is a file main never had; leaving it in place is harmless because
    # nothing in main's own source imports it.

def sha(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()

kept = {p: open(p, "rb").read() for p in held}
shas = {p: sha(p) for p in held}
for p in deleted_by_branch:
    if os.path.exists(p):
        raise SystemExit("file the branch deleted is present again: " + p)

print(f"holding {len(held)} modified files at main, restoring {len(deleted_by_branch)} deleted ones")

try:
    for p in held + deleted_by_branch:
        old = subprocess.run(["git", "show", "main:" + p], capture_output=True)
        if old.returncode != 0:
            raise SystemExit("no main copy of " + p)
        with open(p, "wb") as fh:
            fh.write(old.stdout)
    for tape in tapes:
        print("recording", tape, flush=True)
        subprocess.run(["proof/docker/record.sh", tape], check=True)
finally:
    for p, content in kept.items():
        with open(p, "wb") as fh:
            fh.write(content)
    for p in deleted_by_branch:
        if os.path.exists(p):
            os.remove(p)
    ok = all(sha(p) == shas[p] for p in held) and not any(os.path.exists(p) for p in deleted_by_branch)
    print("restored:", ok)
    if not ok:
        sys.exit(1)
PY
