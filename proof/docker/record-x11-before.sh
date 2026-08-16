#!/usr/bin/env bash
# Record an X11 scene against the code that is on `main`, without moving the branch.
#
#   proof/docker/record-x11-before.sh proof/scenes/<name>.sh
#
# Same hold-and-restore as record-before.sh, driving the video recorder instead
# of the vhs one: every source file the branch changed is held at its `main`
# content for the length of the run, restored from an in-memory copy afterwards,
# and the restore proved by comparing sha256 before and after. No git mutation
# command is used — `git show` only reads — and the working tree ends
# byte-identical.
#
# Output goes to proof/captures/x11/before, beside the after arm of the same
# name, so the two are directly comparable.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

python3 - "$@" <<'PY'
import hashlib, os, subprocess, sys

scenes = sys.argv[1:]
if not scenes:
    raise SystemExit("usage: record-x11-before.sh <scene.sh> [<scene.sh>...]")

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
        deleted_by_branch.append(fields[-1])
    elif status.startswith("R"):
        deleted_by_branch.append(fields[1])
    elif status.startswith("M"):
        held.append(fields[-1])

def sha(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()

kept = {p: open(p, "rb").read() for p in held}
shas = {p: sha(p) for p in held}
for p in deleted_by_branch:
    if os.path.exists(p):
        raise SystemExit("file the branch deleted is present again: " + p)

print(f"holding {len(held)} modified files at main, restoring {len(deleted_by_branch)} deleted ones")

out = os.path.join("proof", "captures", "x11", "before")
os.makedirs(out, exist_ok=True)
env = dict(os.environ, OUT_DIR=os.path.abspath(out))

try:
    for p in held + deleted_by_branch:
        old = subprocess.run(["git", "show", "main:" + p], capture_output=True)
        if old.returncode != 0:
            raise SystemExit("no main copy of " + p)
        with open(p, "wb") as fh:
            fh.write(old.stdout)
    for scene in scenes:
        print("recording", scene, flush=True)
        subprocess.run(["proof/docker/record-x11.sh", scene], check=True, env=env)
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
