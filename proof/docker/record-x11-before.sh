#!/usr/bin/env bash
# Record an X11 scene against the code that is on `main`, without moving the branch.
#
#   proof/docker/record-x11-before.sh proof/scenes/<name>.sh
#
# The before arm holds the branch's changes back: every source file the branch
# changed is held at its content in the base ref for the length of the run, then
# restored from an in-memory copy, and the restore proved by comparing sha256
# before and after. A file the branch added is absent for the run and a file the
# branch deleted is present, since the base tree — not the diff status — defines
# the arm. No git mutation command is used: `git show` only reads, and the
# working tree ends byte-identical.
#
# The hold cannot synthesize an install layout. `node_modules` and the workspace
# links in it belong to the branch, so a branch that moves a workspace member or
# changes a dependency has no faithful hold: the base source it restores imports
# a member at a path this checkout no longer declares. This refuses that case
# instead of recording a frame that is half one tree and half the other; record
# that arm from a checkout of the base ref, with OUT_DIR pointing here.
# PROOF_ALLOW_MANIFEST_DRIFT=1 records anyway.
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

# Source lives under every first-party root, not `packages/` alone: a member under
# kernel/, hosts/, contracts/, plugins/ or natives/ reaches the running product the
# same way, and a pathspec naming one root holds a fraction of the branch and
# records the rest of it as "before".
SOURCE_ROOTS = ("contracts/", "hosts/", "kernel/", "natives/", "packages/", "plugins/")
# A prompt is a `.md` file the product imports as text, and a theme or catalog is
# `.json`, so both are source here. `.snap` and fixture data are not: a scene reads
# neither.
CODE_SUFFIXES = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".md", ".json", ".css")
MANIFESTS = ("package.json", "tsconfig.json", "Cargo.toml", "bun.lock", "package-lock.json")

# `--no-renames`: with rename detection on, a renamed file is listed under its new
# name only, so the old path was never restored and the base tree imported a module
# that did not exist.
changed = subprocess.run(
    ["git", "diff", "--no-renames", "--name-only", f"{base}..HEAD"],
    capture_output=True, text=True, check=True,
).stdout.split("\n")

touched, manifest_drift = [], []
for line in changed:
    path = line.strip()
    if not path or not path.startswith(SOURCE_ROOTS) or not path.endswith(CODE_SUFFIXES):
        continue
    name = os.path.basename(path)
    if name in MANIFESTS or (name.startswith("tsconfig.") and name.endswith(".json")):
        manifest_drift.append(path)
        continue
    touched.append(path)

if manifest_drift and os.environ.get("PROOF_ALLOW_MANIFEST_DRIFT") != "1":
    raise SystemExit(
        f"{len(manifest_drift)} workspace manifest(s) differ from {base}, so no hold is faithful: "
        + ", ".join(sorted(manifest_drift)[:5])
        + "\nrecord this arm from a checkout of "
        + base
        + " with OUT_DIR pointing at proof/captures/x11/before, or set PROOF_ALLOW_MANIFEST_DRIFT=1"
    )

def sha(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()

def read_or_none(path):
    if not os.path.exists(path):
        return None
    with open(path, "rb") as fh:
        return fh.read()

# The base tree decides what the arm holds: content when the base has the file,
# absence when it does not. That covers a modification, a file the branch added, a
# file it deleted and both halves of a rename under one rule.
want = {}
for path in touched:
    old = subprocess.run(["git", "show", f"{base}:{path}"], capture_output=True)
    want[path] = old.stdout if old.returncode == 0 else None

have = {path: read_or_none(path) for path in touched}
held = [p for p in touched if have[p] is not None]
created = [p for p in touched if have[p] is None and want[p] is not None]
hidden = [p for p in touched if have[p] is not None and want[p] is None]

print(
    f"holding {len(held)} files at {base}: {len(created)} the branch deleted are restored, "
    f"{len(hidden)} it added are hidden"
)

out = os.environ.get("OUT_DIR") or os.path.join("proof", "captures", "x11", "before")
os.makedirs(out, exist_ok=True)
# SCENE_ARM lets a scene guard each arm in the direction that arm is true in. A frame that
# photographs NEW behavior has no assertion that holds on both sides: the after arm must
# see the new state, and the before arm must see the old one. Without this a scene can only
# guard the half it was written against, and the other arm records whatever it lands on.
env = dict(os.environ, OUT_DIR=os.path.abspath(out), SCENE_ARM="before")

# A file the branch deleted along with its directory needs the directory back, and the
# restore takes back every directory it made rather than leaving an empty tree behind.
made_dirs = []
try:
    for path, content in want.items():
        if content is None:
            if os.path.exists(path):
                os.remove(path)
            continue
        parent = os.path.dirname(path)
        if parent and not os.path.isdir(parent):
            missing, walk = [], parent
            while walk and not os.path.isdir(walk):
                missing.append(walk)
                walk = os.path.dirname(walk)
            os.makedirs(parent, exist_ok=True)
            made_dirs.extend(missing)
        with open(path, "wb") as fh:
            fh.write(content)
    for scene in scenes:
        print("recording", scene, flush=True)
        subprocess.run(["proof/docker/record-x11.sh", scene], check=True, env=env)
finally:
    for path, content in have.items():
        if content is None:
            if os.path.exists(path):
                os.remove(path)
            continue
        with open(path, "wb") as fh:
            fh.write(content)
    for directory in sorted(made_dirs, key=len, reverse=True):
        if os.path.isdir(directory) and not os.listdir(directory):
            os.rmdir(directory)
    restored = [
        path
        for path, content in have.items()
        if (sha(path) != hashlib.sha256(content).hexdigest() if content is not None else os.path.exists(path))
    ]
    print("restored:", not restored)
    if restored:
        print("unrestored:", ", ".join(sorted(restored)[:10]))
        sys.exit(1)
PY
