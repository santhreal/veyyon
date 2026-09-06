#!/usr/bin/env bash
# Record an X11 scene against the code that is on `main`, without moving the branch.
#
#   proof/docker/record-x11-before.sh proof/scenes/<name>.sh
#
# The before arm holds the branch's changes back: every source file the branch
# MODIFIED is held at its base content, every file the branch ADDED is taken away,
# and every file the branch DELETED is put back, all for the length of the run.
# Each is restored from an in-memory copy afterwards and the restore proved by
# comparing sha256 before and after. No git mutation command is used -- `git show`
# only reads -- and the working tree ends byte-identical.
#
# An added file left in place is the failure this arm exists to prevent: the branch
# module stays on disk and the arm records a tree that is neither side of the change.
#
# The base is `origin/main`, the tip the branch is measured against, and not the
# local `main` ref, which drifts behind its remote the moment anyone else lands a
# commit -- a before arm held at a stale tip records content no revision ever had.
# PROOF_BASE_REF names another one; a tree with no `origin/main` falls back to
# `main`.
#
# Output goes to proof/captures/x11/before, beside the after arm of the same
# name, so the two are directly comparable. A caller that records a matrix --
# one arm per terminal width -- sets OUT_DIR per run, since a single directory
# cannot hold two arms whose frames share the scene's mark names.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

python3 - "$@" <<'PY'
import hashlib, os, subprocess, sys

scenes = sys.argv[1:]
if not scenes:
    raise SystemExit("usage: record-x11-before.sh <scene.sh> [<scene.sh>...]")

def resolve_base():
    """The revision the before arm holds at. `origin/main` first: a local `main` is a
    cached copy of it that goes stale silently, and holding nine files at a tip the
    remote moved past records a tree no revision ever had."""
    named = os.environ.get("PROOF_BASE_REF")
    if named:
        return named
    for ref in ("origin/main", "main"):
        if subprocess.run(["git", "rev-parse", "--verify", "--quiet", ref + "^{commit}"], capture_output=True).returncode == 0:
            return ref
    raise SystemExit("no origin/main and no main: name the hold point in PROOF_BASE_REF")

base = resolve_base()

changed = subprocess.run(
    ["git", "diff", "--name-status", f"{base}..HEAD", "--", "packages/*/src/*"],
    capture_output=True, text=True, check=True,
).stdout.split("\n")

# Three ways a path differs, and the arm owes each one a different move. A rename is
# both of the outer two at once, which is why it is read as its old and new path
# rather than as one entry.
held, added_by_branch, deleted_by_branch = [], [], []
for line in changed:
    if not line.strip():
        continue
    fields = line.split("\t")
    status = fields[0]
    if status.startswith("A"):
        added_by_branch.append(fields[-1])
    elif status.startswith("D"):
        deleted_by_branch.append(fields[-1])
    elif status.startswith(("R", "C")):
        deleted_by_branch.append(fields[1])
        added_by_branch.append(fields[2])
    else:
        held.append(fields[-1])

def sha(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()

# An added file is kept in memory for the same reason a modified one is: it comes off
# disk for the run and its restore is proved by sha, so a crash mid-run cannot lose it.
kept = {p: open(p, "rb").read() for p in held + added_by_branch}
shas = {p: sha(p) for p in held + added_by_branch}
for p in deleted_by_branch:
    if os.path.exists(p):
        raise SystemExit("file the branch deleted is present again: " + p)

print(
    f"holding {len(held)} modified files at {base}, "
    f"taking away {len(added_by_branch)} the branch added, "
    f"restoring {len(deleted_by_branch)} it deleted"
)

out = os.environ.get("OUT_DIR") or os.path.join("proof", "captures", "x11", "before")
os.makedirs(out, exist_ok=True)
# SCENE_ARM lets a scene guard each arm in the direction that arm is true in. A frame that
# photographs NEW behavior has no assertion that holds on both sides: the after arm must
# see the new state, and the before arm must see the old one. Without this a scene can only
# guard the half it was written against, and the other arm records whatever it lands on.
env = dict(os.environ, OUT_DIR=os.path.abspath(out), SCENE_ARM="before")

try:
    for p in held + deleted_by_branch:
        old = subprocess.run(["git", "show", f"{base}:{p}"], capture_output=True)
        if old.returncode != 0:
            raise SystemExit(f"no {base} copy of " + p)
        with open(p, "wb") as fh:
            fh.write(old.stdout)
    for p in added_by_branch:
        os.remove(p)
    for scene in scenes:
        print("recording", scene, flush=True)
        subprocess.run(["proof/docker/record-x11.sh", scene], check=True, env=env)
finally:
    for p, content in kept.items():
        os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
        with open(p, "wb") as fh:
            fh.write(content)
    for p in deleted_by_branch:
        if os.path.exists(p):
            os.remove(p)
    ok = all(sha(p) == shas[p] for p in kept) and not any(os.path.exists(p) for p in deleted_by_branch)
    print("restored:", ok)
    if not ok:
        sys.exit(1)
PY
