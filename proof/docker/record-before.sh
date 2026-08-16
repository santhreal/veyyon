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
    fields = line.split("\t")
    status = fields[0]
    if status.startswith("D"):
        # The branch deleted it, so main's copy has to come back for the run.
        deleted_by_branch.append(fields[-1])
    elif status.startswith("R"):
        # A rename is main's old path missing plus a new path main never had.
        # Bringing the old path back is what main's own imports resolve against.
        deleted_by_branch.append(fields[1])
    elif status.startswith("M"):
        held.append(fields[-1])
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
    os.makedirs("proof/captures/real/before", exist_ok=True)
    for tape in tapes:
        # The tape names its own output paths, so a before run writes into a
        # sibling directory rather than over the after capture of the same name.
        text = open(tape, encoding="utf-8").read().replace('"/out/', '"/out/before/')
        scratch = os.path.join(os.path.dirname(tape), ".before-" + os.path.basename(tape))
        with open(scratch, "w", encoding="utf-8") as fh:
            fh.write(text)
        print("recording", tape, flush=True)
        try:
            subprocess.run(["proof/docker/record.sh", scratch], check=True)
        finally:
            os.remove(scratch)
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
