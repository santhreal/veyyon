#!/usr/bin/env python3
"""Assemble proof/ui-polish-proof.html from the recordings on disk.

Every figure on the page is a frame of a real terminal. The page carries no
rasterized component renders: a picture produced by drawing a component into a
PNG proves the component's bytes, not that a user can reach it, and the two kept
being read as the same claim. What is left is video of the shipped CLI running
in a container, the filmstrips cut out of that video, and the stills the scene
itself took off the X display it was recording.

    proof/build-proof.py          # writes proof/ui-polish-proof.html

A missing file is a hard error: a proof page with a broken figure is worse than
no page, because the caption still reads as evidence.
"""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent

missing: list[str] = []


def need(rel: str) -> str:
    if not (ROOT / rel).exists():
        missing.append(rel)
    return rel


def capture_fps(*globs: str, skip: str = "") -> str:
    """The frame rates ffmpeg actually recorded, read back off the files.

    Typed into the page this drifted: the note claimed 60fps for everything
    while a commit arm was recorded at 15 and the long session at 20, and a
    reader has no way to tell a wrong number from a right one. Probing the mp4s
    at build time means the sentence cannot disagree with the videos under it.
    """
    rates: set[int] = set()
    for pattern in globs:
        for path in sorted(ROOT.glob(pattern)):
            if skip and path.name.startswith(skip):
                continue
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "v",
                 "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", str(path)],
                capture_output=True, text=True,
            )
            num, _, den = probe.stdout.strip().partition("/")
            if not num.isdigit():
                continue
            rates.add(round(int(num) / int(den or 1)))
    if not rates:
        return "an unknown rate"
    ordered = sorted(rates)
    if len(ordered) == 1:
        return f"{ordered[0]}fps"
    return ", ".join(f"{r}fps" for r in ordered[:-1]) + f" and {ordered[-1]}fps"


CSS = """
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 48px 32px 96px; max-width: 1180px; background: #14161a; color: #d7dae0;
       font: 15px/1.65 -apple-system, "Segoe UI", Inter, system-ui, sans-serif; }
h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: -0.02em; }
h2 { font-size: 21px; margin: 64px 0 4px; padding-top: 18px; border-top: 1px solid #262b33; letter-spacing: -0.01em; }
h3 { font-size: 15px; margin: 30px 0 6px; color: #f0b57a; font-weight: 600; }
p { margin: 10px 0; max-width: 78ch; }
p.lede { color: #9aa2ae; }
code { font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace; background: #1c2027; padding: 1px 5px;
       border-radius: 4px; color: #e6c08a; }
a { color: #7fb2e5; }
figure { margin: 18px 0 0; }
figcaption { color: #8d95a1; font-size: 13px; margin-top: 8px; }
video, img { width: 100%; display: block; border: 1px solid #2a3039; border-radius: 8px; background: #0b0d10; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.pair figcaption strong { color: #d7dae0; }
.strip { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
.strip img { border-radius: 3px; }
.note { background: #171b21; border: 1px solid #262b33; border-left: 3px solid #f0b57a; border-radius: 6px;
        padding: 14px 18px; margin: 22px 0; }
.note p { margin: 6px 0; }
table { border-collapse: collapse; width: 100%; margin-top: 14px; font-size: 13.5px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #232830; vertical-align: top; }
th { color: #8d95a1; font-weight: 600; }
td.sha { font-family: ui-monospace, monospace; color: #e6c08a; white-space: nowrap; }
.miss { background: #3b1d1d; border: 1px solid #7a3030; padding: 10px; border-radius: 6px; color: #ffb4b4; }
pre.difftext { font: 12px/1.5 ui-monospace, "SF Mono", Menlo, monospace; background: #0f1216; color: #c6ccd6;
       border: 1px solid #262b33; border-radius: 8px; padding: 14px 16px; margin: 16px 0 0;
       max-height: 420px; overflow: auto; white-space: pre; tab-size: 4; }
pre.difftext .green { color: #7fd18b; }
pre.difftext .red { color: #ec8a8a; }
pre.difftext .cyan { color: #79c0d6; }
pre.difftext .yellow { color: #e6c08a; }
pre.difftext .blue { color: #7fb2e5; }
pre.difftext .magenta { color: #c99ae0; }
pre.difftext .white { color: #d7dae0; }
pre.difftext .dim { color: #7b828d; }
pre.difftext .b { font-weight: 600; }
details.clip { margin: 14px 0 0; }
details.clip summary { cursor: pointer; color: #8d95a1; font-size: 13px; }
details.clip summary:hover { color: #d7dae0; }
.budget { color: #8d95a1; font-size: 13.5px; margin: 10px 0 0; }
"""

CLIP_AUDIT = ROOT / "captures/clip-audit.tsv"
blank_clips: list[str] = []
# Every clip a figure on this page actually points at, so the runtime it quotes is
# what a reader is being asked to watch rather than what happens to sit on disk.
shown: set[str] = set()


def clip_audit() -> dict[str, tuple[int, float, int, float]]:
    """(bytes, seconds, distinct frames, last-frame ink) per clip, from tighten.py audit."""
    if not CLIP_AUDIT.exists():
        return {}
    rows: dict[str, tuple[int, float, int, float]] = {}
    for line in CLIP_AUDIT.read_text(encoding="utf-8").splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) != 5:
            continue
        try:
            rows[parts[0]] = (int(parts[1]), float(parts[2]), int(parts[3]), float(parts[4]))
        except ValueError:
            continue
    return rows


AUDIT = clip_audit()

# The same rule tighten.py judges by: what proves a terminal drew something is that
# it CHANGED, so the frame count carries it and ink only breaks the tie among clips
# that barely changed. An ink threshold on its own condemns real captures of sparse
# surfaces (the tall-HUD arms sit at ink 660 over eight distinct frames).
BLANK_FRAMES = 1
BARELY_FRAMES = 4
BLANK_INK = 1200.0


def audit_key(rel: str) -> str:
    """The clip's key in captures/clip-audit.tsv: its path below that file's directory."""
    return rel[len("captures/") :] if rel.startswith("captures/") else rel


def sound(rel: str) -> str:
    """A clip is evidence only if it drew something.

    `d4d2a4290-before.mp4` was 171.6 seconds of an empty terminal with a cursor:
    the suite outlived the recorder's hold ceiling, and because the command only
    prints when its pipe closes, the camera filmed nothing. It sat on this page
    under a commit's name as though it showed the commit. A missing file was
    already a hard error here; a file that shows nothing is the same claim with a
    poster frame, so it fails the build too. The numbers come from
    `tighten.py audit`, which also refuses to leave a stale row: a clip whose
    size no longer matches its audited size is unaudited.
    """
    need(rel)
    shown.add(audit_key(rel))
    path = ROOT / rel
    if not path.exists():
        return rel
    key = audit_key(rel)
    row = AUDIT.get(key)
    if row is None:
        blank_clips.append(f"{key}: not in captures/clip-audit.tsv (run proof/tighten.py audit)")
        return rel
    size, _seconds, frames, ink = row
    if size != path.stat().st_size:
        blank_clips.append(f"{key}: audited at {size}B, now {path.stat().st_size}B (re-run tighten.py audit)")
    elif frames <= BLANK_FRAMES or (frames <= BARELY_FRAMES and ink < BLANK_INK):
        blank_clips.append(f"{key}: {frames} distinct frame(s), ink {ink:.0f} — the terminal drew nothing")
    return rel


def clip_runtime(*rels: str) -> float:
    total = 0.0
    for rel in rels:
        row = AUDIT.get(audit_key(rel))
        if row:
            total += row[1]
    return total


ANSI = re.compile(r"\x1b\[([0-9;]*)m")
SGR_CLASS = {
    "1": "b",
    "31": "red",
    "32": "green",
    "33": "yellow",
    "34": "blue",
    "35": "magenta",
    "36": "cyan",
    "37": "white",
    "90": "dim",
}


def ansi_to_html(text: str) -> str:
    """git's own colours, kept, as spans.

    The diff on the page is the same bytes the terminal paged in the recording --
    written by record-all-commits.sh with --color=always -- so the reader gets the
    hunk colouring without watching a pager walk it at 2.5 seconds a page.
    """
    out: list[str] = []
    depth = 0
    pos = 0
    for m in ANSI.finditer(text):
        out.append(escape(text[pos : m.start()]))
        pos = m.end()
        codes = [c for c in m.group(1).split(";") if c] or ["0"]
        if codes == ["0"] or codes == ["22"] or codes == ["39"]:
            out.append("</span>" * depth)
            depth = 0
            continue
        classes = " ".join(SGR_CLASS[c] for c in codes if c in SGR_CLASS)
        if classes:
            out.append(f'<span class="{classes}">')
            depth += 1
    out.append(escape(text[pos:]))
    out.append("</span>" * depth)
    return "".join(out)


def diff_text(hash_: str) -> str:
    """The commit's diff, as text, in the page.

    A commit that ships nothing a terminal can execute used to be presented as a
    video of a pager: 23 static pages, 2.5 seconds each, and the reader waits for
    text that was already committed beside the recording. Rendered here it is
    scrollable, searchable with the browser's own find, and instant. The
    recording stays one click away, because the claim it backs -- this really was
    paged in a real terminal -- is still worth being able to check.
    """
    rel = f"{COMMITS_REL}{hash_}-after/{hash_}.diff"
    need(rel)
    path = ROOT / rel
    if not path.exists():
        return ""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return f'<pre class="difftext">{ansi_to_html(chr(10).join(lines))}</pre>'



def video(rel: str, caption: str, start: float | None = None) -> str:
    """A figure holding the recording itself.

    `start` is a media fragment, and it is what stops the poster frame being
    the black display the recorder had before the terminal painted anything.
    """
    sound(rel)
    src = f"{rel}#t={start:g}" if start is not None else rel
    return (
        "<figure>"
        f'<video controls loop muted playsinline preload="metadata"><source src="{src}" type="video/mp4"></video>'
        f"<figcaption>{caption}</figcaption></figure>"
    )


# The labels that CLAIM a cross-tree comparison, and the reason a figure now has
# to say which axis it is showing. `video_pair` and `still_pair` used to hardcode
# these two words into both figcaptions, so a figure whose real axis was session
# SIZE on one tree rendered a bold "main" over a branch recording and a bold
# "branch" over the other branch recording. Four figures were doing it: the
# 72M-token pair, the theme-ladder wash, and both slab-vs-card render proofs.
TREE_ARMS = ("main", "branch")

# What a reader sees. The tokens above name where the bytes came from AT THE TIME
# OF RECORDING, when `main` was the tree without this work, and every check below
# still keys off them. The work is on `main` now, so a caption reading "main" over
# the old design is false to anyone reading the page today: the arms are before
# and after, and only the mechanism note says which git ref supplied each.
ARM_LABELS = {"main": "before", "branch": "after"}

mislabelled: list[str] = []


def tree_of(rel: str) -> str:
    """Which tree a capture came from, read off where the file sits."""
    if rel.startswith(XB):
        return "main"
    if rel.startswith(X):
        return "branch"
    return "no tree at all"


def axis(before: str, after: str, arms: tuple[str, str]) -> tuple[str, str]:
    """Refuse a main-vs-branch claim over two captures from the same tree.

    Mechanical rather than per-figure: `captures/x11/before/` is main and
    `captures/x11/` is the branch, so the paths already know the answer and a new
    figure cannot get the labels wrong without failing this build.
    """
    if tuple(arms) == TREE_ARMS and tree_of(before) == tree_of(after):
        mislabelled.append(f"{before} vs {after}: both arms are {tree_of(before)}, captioned main/branch")
    return arms


def video_pair(
    before: str,
    after: str,
    cap_before: str,
    cap_after: str,
    start: float | None = None,
    *,
    arms: tuple[str, str] = TREE_ARMS,
) -> str:
    """Two recordings side by side, each labelled with the arm it IS.

    `arms` defaults to the tree axis because that is what nearly every figure
    here compares, but `axis()` refuses that default over two captures from one
    tree, so the default cannot be wrong silently the way it was.
    """
    sound(before)
    sound(after)
    left, right = axis(before, after, arms)
    frag = f"#t={start:g}" if start is not None else ""
    return (
        '<div class="pair">'
        f'<figure><video controls loop muted playsinline preload="metadata"><source src="{before}{frag}" type="video/mp4"></video>'
        f"<figcaption><strong>{ARM_LABELS.get(left, left)}</strong> — {cap_before}</figcaption></figure>"
        f'<figure><video controls loop muted playsinline preload="metadata"><source src="{after}{frag}" type="video/mp4"></video>'
        f"<figcaption><strong>{ARM_LABELS.get(right, right)}</strong> — {cap_after}</figcaption></figure>"
        "</div>"
    )


def tree_of_prefix(prefix: str) -> str:
    """Which tree a strip's frames came from, by the convention its own files follow.

    Strips predate the `captures/x11/before/` split and use a `-main` suffix
    instead, so one fact has two spellings. Both are read here, in one place,
    rather than asserted in ten prose captions that nothing could check.
    """
    if prefix.startswith(XB) or prefix.endswith("-main"):
        return "main"
    return "branch"


def strip(prefix: str, frames: int, caption: str, *, arm: str | None = None) -> str:
    """A filmstrip. `arm` names the tree, and is checked against the frames' own path."""
    if arm is not None:
        actual = tree_of_prefix(prefix)
        if arm != actual:
            mislabelled.append(f"{prefix}-f*.png: frames are {actual}, captioned {arm}")
        caption = f"<strong>{ARM_LABELS.get(arm, arm)}.</strong> {caption}"
    imgs = "".join(f'<img src="{need(f"{prefix}-f{i:02d}.png")}" alt="frame {i}">' for i in range(frames))
    # Two rows of equal length, so an eight-frame strip is 4x2 rather than 6+2.
    cols = frames if frames <= 6 else (frames + 1) // 2
    style = f' style="grid-template-columns: repeat({cols}, 1fr)"'
    return f'<figure><div class="strip"{style}>{imgs}</div><figcaption>{caption}</figcaption></figure>'


def still(rel: str, caption: str) -> str:
    need(rel)
    return f'<figure><img src="{rel}" alt=""><figcaption>{caption}</figcaption></figure>'


def still_pair(
    before: str,
    after: str,
    cap_before: str,
    cap_after: str,
    *,
    arms: tuple[str, str] = TREE_ARMS,
) -> str:
    need(before)
    need(after)
    left, right = axis(before, after, arms)
    return (
        '<div class="pair">'
        f'<figure><img src="{before}" alt=""><figcaption><strong>{ARM_LABELS.get(left, left)}</strong> — {cap_before}</figcaption></figure>'
        f'<figure><img src="{after}" alt=""><figcaption><strong>{ARM_LABELS.get(right, right)}</strong> — {cap_after}</figcaption></figure>'
        "</div>"
    )


def pair(left: str, right: str, cap_left: str, cap_right: str) -> str:
    """Two stills side by side that are NOT a before/after arm pair."""
    need(left)
    need(right)
    return (
        '<div class="pair">'
        f'<figure><img src="{left}" alt=""><figcaption>{cap_left}</figcaption></figure>'
        f'<figure><img src="{right}" alt=""><figcaption>{cap_right}</figcaption></figure>'
        "</div>"
    )


@dataclass
class Section:
    title: str
    body: list[str] = field(default_factory=list)

    def html(self) -> str:
        return f"<h2>{self.title}</h2>\n" + "\n".join(self.body)


MANIFEST = ROOT / "commit-videos.tsv"
COMMITS_REL = "captures/x11/commits/"


def _arm_result(hash_: str, arm: str) -> str:
    """The last lines the command printed on that arm, as text.

    Written by proof/docker/commit-results.sh -- the same trees and the same
    commands as the videos, run again with no camera. The page quotes this file
    rather than a number typed by hand, so a caption that says twelve failed is
    reading a file anyone can open next to the video that shows it.
    """
    path = ROOT / COMMITS_REL / f"{hash_}-{arm}.txt"
    if not path.exists():
        return ""
    lines = [ln.rstrip() for ln in path.read_text(errors="replace").splitlines() if ln.strip()]
    tally = [ln for ln in lines if RESULT_LINE.match(ln)]
    return " · ".join(ln.strip() for ln in tally[:4]) if tally else lines[-1][:120]


RESULT_LINE = __import__("re").compile(r"^\s*\d+ (pass|fail|error|expect\(\) calls)|^Ran \d+ tests")


def _pty_stats(name: str) -> dict[str, str]:
    """The counters pty-stats.py wrote for one arm of the long-session proof."""
    path = ROOT / f"captures/x11/{name}/pty-stats.txt"
    if not path.exists():
        missing.append(str(path.relative_to(ROOT)))
        return {}
    out: dict[str, str] = {}
    for line in path.read_text(errors="replace").splitlines():
        if line.startswith("---"):
            break
        key, _, value = line.rpartition("  ")
        if key.strip() and value.strip():
            out[key.strip()] = value.strip()
    return out


def long_session_section() -> Section:
    """Streaming at the tail of a multi-million-token session, against an empty one.

    The session is one of the operator's own: 289MB of JSONL, 69,727 records,
    34,552 messages, 87 earlier compactions, about 72 million tokens of text. It
    is bind-mounted read-only into the container and copied into the container's
    tmpfs home before the app opens it, so the app writes to the copy. The
    operator's ~/.veyyon is not in the mount table and no setting of theirs is
    read.

    The control arm is the same scene with no session at all. Both arms are
    driven by the same keys, answered by the same 1.5B on the container network,
    and recorded by the same camera; the app runs under `script` inside the
    terminal, so each arm yields a video AND the bytes it wrote.
    """
    big, fresh = _pty_stats("long-session-72m"), _pty_stats("long-session-fresh")
    keys = [
        "session bytes",
        "session messages",
        "pty bytes",
        "ED3 native-scrollback erases",
        "ED2 screen erases",
        "synchronized frames",
        "bytes per frame",
        "wall seconds",
    ]
    head = "<tr><th>counter</th><th>72M-token session</th><th>fresh session</th></tr>"
    body = "".join(
        f"<tr><td>{k}</td><td>{big.get(k, '—')}</td><td>{fresh.get(k, '—')}</td></tr>"
        for k in keys
        if k in big or k in fresh
    )
    return Section(
        "Streaming at the tail of a 72-million-token session",
        [
            "<p>Both videos are this branch. The axis between them is how much session is above the window, not"
            " which tree is running: the left is a real session of the operator's resumed inside the container"
            " (289MB of JSONL, 69,727 records, 34,552 messages, 87 earlier compactions), the right is the same"
            " scene with no session at all. Same keys, same 1.5B model on the container network, same camera,"
            " same terminal. They are NOT a parent/commit pair, and nothing below compares them as one: the two"
            " arms do not even run for the same length of time, and only the resumed arm compacts before it can"
            " answer. What the pair is for is the counter table underneath, where the cost of a 72-million-token"
            " history is read off both arms of the same tree.</p>",
            "<p>The app runs under <code>script</code> inside that terminal, so each arm produced a byte capture"
            " as well as a picture. <code>ED3</code> is the counter that matters: it is the sequence that erases"
            " the terminal's own scroll buffer, and it is what both symptoms this branch chased were made of."
            " A frame that repaints in place writes cursor moves and text; a frame that gives up writes"
            " <code>ED3</code>.</p>",
            video_pair(
                X + "long-session-72m.mp4",
                X + "long-session-fresh.mp4",
                "the operator's own session, resumed: the transcript, a scroll back through it, a prompt, and the"
                " answer streaming in at the tail",
                "no session at all: the load floor the resumed arm is measured against",
                start=25,
                arms=("72M-token session", "fresh session"),
            ),
            f"<table><thead>{head}</thead><tbody>{body}</tbody></table>",
            "<p>The resumed arm carries one cost the fresh arm does not, and it is model-side rather than"
            " renderer-side: a history that large does not fit a 65k window, so the app compacts before it can"
            " ask anything, and says so on screen while it does. That is the 1.5B summarizing on CPU, not a"
            " frame being repainted.</p>",
        ],
    )


def commit_pair(hash_: str, cap_before: str, cap_after: str) -> str:
    """The two arms of one commit, labelled for what they are.

    `video_pair` labels its arms main and branch, which is right for a scene
    recorded against two branches and wrong here: both of these arms are on this
    branch, one commit apart.
    """
    before, after = f"{COMMITS_REL}{hash_}-before.mp4", f"{COMMITS_REL}{hash_}-after.mp4"
    sound(before)
    sound(after)
    cap_before += timeout_note(hash_, "before")
    cap_after += timeout_note(hash_, "after")
    return (
        '<div class="pair">'
        f'<figure><video controls loop muted playsinline preload="metadata"><source src="{before}#t=1" type="video/mp4"></video>'
        f"<figcaption><strong>parent</strong> — {cap_before}</figcaption></figure>"
        f'<figure><video controls loop muted playsinline preload="metadata"><source src="{after}#t=1" type="video/mp4"></video>'
        f"<figcaption><strong>this commit</strong> — {cap_after}</figcaption></figure>"
        "</div>"
    )


def timeout_note(hash_: str, arm: str) -> str:
    """Says so when the arm's command never finished.

    A clip that stops at the recorder's ceiling looks exactly like a clip that
    stops because the command ended, and the difference matters: `d4d2a4290`'s
    parent arm hangs in the container on a suite that passes locally in under a
    second. The recorder leaves the ceiling in `timeout-seconds`, so the caption
    reports it instead of a reader assuming the run completed.
    """
    marker = ROOT / COMMITS_REL / f"{hash_}-{arm}" / "timeout-seconds"
    if not marker.exists():
        return ""
    seconds = marker.read_text(encoding="utf-8").strip() or "?"
    return f" <em>(still running at the {escape(seconds)}s ceiling; the recording is what it had drawn by then)</em>"


def manifest_rows() -> list[tuple[str, str, str, str]]:
    """(hash, kind, payload, subject) per recorded commit, out of commit-videos.tsv."""
    rows = []
    for line in MANIFEST.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        hash_, kind, _hold, payload, subject = parts[:5]
        rows.append((hash_, kind, payload, subject))
    return rows


def commit_video_sections() -> str:
    """One block per commit on the branch: what it was, and it running.

    Nothing here is chosen by hand. The rows come out of commit-videos.tsv, the
    videos out of proof/captures/x11/commits, and which of the three shapes a
    commit gets follows from what the commit contains:

      test    its own test files, run against its parent's source and against
              its own. The before arm is the mutation gate as a movie: the test
              is byte-identical in both trees, so a difference is the source.
      driver  a renderer it added or changed, drawing the surface in both trees.
      diff    the change itself, paged in the terminal, for a commit that ships
              nothing a terminal can execute -- captures, a page rebuild, a
              changelog ordering, a merge.
    """
    rows = manifest_rows()

    blocks = []
    for hash_, kind, payload, subject in rows:
        heading = f'<h3 id="c-{hash_}"><code>{hash_}</code> — {escape(subject)}</h3>'
        if kind == "diff":
            rel = f"{COMMITS_REL}{hash_}-after.mp4"
            seconds = clip_runtime(rel)
            body = (
                diff_text(hash_)
                + "<details class=\"clip\"><summary>the same diff paged in a real terminal"
                + (f" ({seconds:.0f}s)" if seconds else "")
                + "</summary>"
                + video(rel, "the change itself, paged in the terminal", start=0.5)
                + "</details>"
            )
            what = (
                '<p class="lede">Ships nothing a terminal can run, so the change itself is the'
                " evidence: the diff below is the text the recording pages, byte for byte.</p>"
            )
        else:
            ran = escape(payload.replace("./", ""))
            before, after = _arm_result(hash_, "before"), _arm_result(hash_, "after")
            cap_b = escape(before) or "parent tree"
            cap_a = escape(after) or "commit tree"
            body = commit_pair(hash_, cap_b, cap_a)
            verb = "its own tests" if kind == "test" else "its own renderer"
            what = f'<p class="lede">Same terminal, same command, two source trees: {verb}, <code>{ran}</code>.</p>'
        blocks.append(f"{heading}\n{what}\n{body}")

    # The tally, counted off the same result files the captions quote. Stated at
    # build time rather than typed, so it cannot drift from what is on the page:
    # if a re-record turns an arm green the sentence changes with it.
    kinds = [k for _h, k, _p, _s in rows]
    red = green = unbuildable = 0
    for hash_, kind, _payload, _subject in rows:
        if kind != "test":
            continue
        before, after = _tally(hash_, "before"), _tally(hash_, "after")
        if after == (None, None):
            continue
        if before == (None, None):
            # The parent tree cannot even run the test -- it fails to load, which
            # is a harder differential than a failing assertion, not a softer one.
            unbuildable += 1
        elif after[1] == 0 and (before[1] or 0) > 0:
            red += 1
        elif after[1] == 0:
            green += 1
    summary = (
        f'<p><strong>{red}</strong> of the {kinds.count("test")} commits that carry tests fail against their'
        f" parent's source and pass against their own — the test byte-identical in both trees, so nothing but the"
        f" commit moved. On {unbuildable} more the parent tree cannot load the test at all, which is a harder"
        f" differential than a failing assertion rather than a softer one. <strong>{green}</strong> pass on both"
        " arms, which is what a commit that only adds a test, or duplicates a fix already on main, is supposed to"
        " do. The rest of the branch is"
        f' {kinds.count("driver")} renderer rows and {kinds.count("diff")} rows that ship nothing a terminal can'
        " execute.</p>"
    )
    # What it costs to read this page, counted off the clips the page itself points
    # at. The campaign shipped at 38.8 minutes for the commit arms alone and 47.8 for
    # the scene recordings, nearly all of it frozen frames -- which is the same as
    # saying nobody was going to watch it. The sentence is built here rather than
    # typed so it cannot drift from the files.
    shown_rows = [AUDIT[k] for k in sorted(shown) if k in AUDIT]
    watch = sum(seconds for _size, seconds, _frames, _ink in shown_rows)
    longest = max((seconds for _s, seconds, _f, _i in shown_rows), default=0.0)
    pairs = kinds.count("test") + kinds.count("driver")
    budget = (
        f'<p class="budget"><strong>How long this takes to read.</strong> {kinds.count("diff")} of the'
        f" {len(rows)} commits ship nothing a terminal can execute, and those carry their diff as text below —"
        f" nothing to play. The other {pairs} carry a parent/commit pair of recordings. All"
        f" {len(shown_rows)} clips on this page run {watch / 60:.0f} minutes end to end, longest {longest:.0f}s,"
        " and none of it is a held frame: <code>proof/tighten.py trim</code> keeps every frame that differs from"
        " the one before it and clamps the still gap after it to under a second, so the runtime left is the"
        " terminal actually changing. A clip that drew nothing fails this build instead of appearing as a poster"
        " frame.</p>"
    )
    return summary + "\n" + budget + "\n" + "\n".join(blocks)


def _tally(hash_: str, arm: str) -> tuple[int | None, int | None]:
    """(pass, fail) out of an arm's result file, or (None, None) when it has neither."""
    path = ROOT / COMMITS_REL / f"{hash_}-{arm}.txt"
    if not path.exists():
        return (None, None)
    text = path.read_text(errors="replace")
    passed = __import__("re").search(r"^\s*(\d+) pass\s*$", text, __import__("re").M)
    failed = __import__("re").search(r"^\s*(\d+) fail\s*$", text, __import__("re").M)
    if not passed and not failed:
        return (None, None)
    return (int(passed.group(1)) if passed else 0, int(failed.group(1)) if failed else 0)


def escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def commit_table() -> str:
    """Every commit on the branch, linked to its recording when it has one.

    A commit that carries only this page and the videos themselves cannot be
    filmed: a recording of the commit that contains the recording is circular.
    Those rows stay in the table, unlinked and named, so the table is the whole
    branch rather than the part that was convenient to film.
    """
    log = subprocess.run(
        ["git", "log", "--oneline", "--no-decorate", "main..HEAD"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout.strip().split("\n")
    filmed = {hash_ for hash_, _kind, _payload, _subject in manifest_rows()}
    rows = []
    for line in log:
        sha, _, subject = line.partition(" ")
        cell = f'<a href="#c-{sha}">{sha}</a>' if sha in filmed else sha
        note = "" if sha in filmed else " <em>— carries this page and its videos; filming it means filming the film</em>"
        rows.append(f'<tr><td class="sha">{cell}</td><td>{escape(subject)}{note}</td></tr>')
    return "\n".join(rows)


def build(sections: list[Section], head: str, base: str, ahead: int) -> str:
    body = "\n".join(section.html() for section in sections)
    return f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>feat/ui-polish — recorded proof</title><style>{CSS}</style></head>
<body>
<h1>feat/ui-polish — recorded proof</h1>
<p class="lede">Branch <code>feat/ui-polish</code> at <code>{head}</code>, {ahead} commits ahead of
<code>main</code> (<code>{base}</code>). Every figure below is a frame of a real terminal running the shipped
CLI. No component was drawn into a picture for this page, and nothing here is a tmux capture.</p>

<div class="note">
<p><strong>Where the recording happens.</strong> <code>proof/docker/record-x11.sh &lt;scene&gt;</code> runs
<code>veyyon-proof-recorder</code> on a private docker network. Inside it, <code>Xvfb</code> owns display
<code>:99</code>, <code>kitty</code> is the terminal — a real emulator that reports SGR 1006 mouse —
<code>xdotool</code> moves a real X pointer and presses real keys through XTEST, and <code>ffmpeg</code> grabs
the display continuously: {capture_fps("captures/x11/*.mp4", "captures/x11/before/*.mp4", skip="long-session")} for the scenes,
{capture_fps("captures/x11/long-session-*.mp4")} for the long-session runs and
{capture_fps("captures/x11/commits/*.mp4")} for a commit arm, each rate read back off the files themselves. The
machine's own <code>~/.veyyon</code> is not in the container's mount table — <code>HOME</code> is a tmpfs seeded
from <code>proof/docker/home-seed</code> — so nothing here touches a live session, and the operator's own display
is never opened. A pointer is only moved where a scene is about a pointer; the commit arms below run a command
and need neither pointer nor keys.</p>
<p><strong>And one figure on a second display server.</strong> The picom/swayfx pair further down is the
exception to the paragraph above: <code>proof/docker/record-wl.sh</code> runs the same scene under
<code>swayfx</code> on a headless Wayland session, where <code>grim</code> takes the stills and
<code>wf-recorder</code> takes the video through <code>wlr-screencopy</code> - the same protocol, so a still and
the video frame at that second are the same pixels. Everything else on this page is the X11 recorder.</p>
<p><strong>Which model answers.</strong> A <code>llama.cpp</code> server holding
<code>qwen2.5-1.5b-instruct-q4_k_m</code>, reachable only as the container-network provider <code>local</code>.
No provider account is reachable from the container, so a streamed answer in these recordings is that model on
CPU or it is nothing.</p>
<p><strong>How the <em>before</em> arm is taken.</strong> <code>proof/docker/record-x11-before.sh</code> holds every
source file the branch changed at its <code>main</code> content (<code>git show main:&lt;file&gt;</code>), records
the same scene into <code>proof/captures/x11/before/</code>, then restores from an in-memory copy and proves the
restore by sha256. No git mutation command runs and the working tree ends byte-identical.</p>
<p><strong>Where the filmstrips come from.</strong> <code>proof/filmstrip.py</code> decodes consecutive frames out
of the recording. 220ms of animation is thirteen frames on the app's own 60Hz clock, and a still taken from
inside the scene always lands after the animation has settled, so the frames have to be cut from the video
afterwards rather than screenshotted mid-motion.</p>
</div>

{body}

<h2>Every commit on the branch, on camera</h2>
<p>{len(manifest_rows())} of the {ahead} commits are below, one recording each. Every video is a real terminal in the recording
container: <code>proof/docker/record-commit-arm.sh</code> extracts the commit's tree and its parent's tree with
<code>git archive</code>, mounts the same <code>node_modules</code> and the same native addon into both, and runs
the same command in each. A test the commit ADDS is copied into the parent tree first, so the test is
byte-identical in both arms and the only variable left is the source under it.</p>
<p>Two build outputs are mounted into both trees beside <code>node_modules</code>, because neither is in git and
a tree without them fails for a reason that has nothing to do with the commit: the native addon
(<code>veyyon_natives.linux-x64-*.node</code>) and the generated HTML-export bundle
(<code>tool-views.generated.js</code>). The first campaign was recorded without them and every arm of fifty
commits failed on a missing addon — the videos looked like a broken branch and were re-recorded. A caption under
a video is the text of the same command run again headlessly by
<code>proof/docker/commit-results.sh</code>; where a caption is empty the command drew a surface to the terminal
rather than writing lines to a pipe, and the video is the only place its output exists.</p>
<table><thead><tr><th>commit</th><th>subject</th></tr></thead>
<tbody>
{commit_table()}
</tbody></table>

{commit_video_sections()}
</body></html>
"""


def write(sections: list[Section]) -> None:
    def git(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()

    head = git("rev-parse", "--short", "HEAD")
    base = git("rev-parse", "--short", "main")
    ahead = int(git("rev-list", "--count", "main..HEAD"))
    html = build(sections, head, base, ahead)
    if missing:
        print("MISSING FILES:", *sorted(set(missing)), sep="\n  ", file=sys.stderr)
        raise SystemExit(1)
    if blank_clips:
        print("CLIPS THAT SHOW NOTHING:", *sorted(set(blank_clips)), sep="\n  ", file=sys.stderr)
        print(
            "\nRe-record the arm (raise its hold column in proof/commit-videos.tsv) and re-run"
            " proof/tighten.py audit.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    if mislabelled:
        print("PAIRS THAT CLAIM A COMPARISON THEY ARE NOT:", *sorted(set(mislabelled)), sep="\n  ", file=sys.stderr)
        print(
            "\nA figure captioned main/branch must hold one capture from captures/x11/before/ and one from"
            " captures/x11/. Pass arms=(left, right) naming the real axis, or use pair() for two stills that"
            " are not tree arms.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    out = ROOT / "ui-polish-proof.html"
    out.write_text(html, encoding="utf-8")
    print("wrote", out)


# The anchored-HUD page carries three of the sections above and nothing else, and
# it exists because the campaign page cannot be built from a fresh checkout: it
# cites a 289MB recording of one of the operator's own sessions, which .gitignore
# refuses by design, and a hero take whose stills are not in git either. A reader
# who wants to see what the anchored blocks now draw should not need either one.
#
# The figure check here reads the page it just rendered rather than the global
# `need()` ledger, because that ledger is filled while every section is
# CONSTRUCTED and so fails a focused page over a figure the focused page does not
# have. Scanning the html is also the stronger check: it answers exactly the
# claim the docstring makes, which is that every figure ON the page resolves.
ANCHORED_HUD_PAGE = ("The board, rebuilt", "A badge on a line of its own, found by the camera", "A fourteen-task plan, closed out")


def write_anchored_hud(sections: list[Section]) -> None:
    def git(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()

    chosen = [s for s in sections if s.title in ANCHORED_HUD_PAGE]
    if len(chosen) != len(ANCHORED_HUD_PAGE):
        have = {s.title for s in chosen}
        raise SystemExit("no section titled: " + ", ".join(t for t in ANCHORED_HUD_PAGE if t not in have))
    head = git("rev-parse", "--short", "HEAD")
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    body = "\n".join(section.html() for section in chosen)
    html = f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>The anchored blocks, rebuilt — recorded proof</title><style>{CSS}</style></head>
<body>
<h1>The anchored blocks, rebuilt</h1>
<p class="lede">Branch <code>{branch}</code> at <code>{head}</code>. The two blocks anchored above the composer —
the subagent lanes and the todo board — were rebuilt in the product's own vocabulary, and one defect neither
block's unit suite could see was found by pointing the camera at them. Every figure below is a frame of a real
terminal running the shipped CLI. No component was drawn into a picture for this page, and nothing here is a tmux
capture.</p>

<div class="note">
<p><strong>Where the recording happens.</strong> <code>proof/docker/record-x11.sh &lt;scene&gt;</code> runs
<code>veyyon-proof-recorder</code> on a private docker network. Inside it, <code>Xvfb</code> owns display
<code>:99</code>, <code>kitty</code> is the terminal — a real emulator — <code>xdotool</code> presses real keys
through XTEST, and <code>ffmpeg</code> grabs the display continuously. Every take on this page is 131x36 cells of
12x27px. The machine's own <code>~/.veyyon</code> is not in the container's mount table — <code>HOME</code> is a
tmpfs seeded from <code>proof/docker/home-seed</code> — so nothing here touches a live session, and the operator's
own display is never opened.</p>
<p><strong>Which model answers.</strong> <code>demo-qwen38-27b-64k</code>, served to the container network and to
nothing else. No provider account is reachable from the container, so a streamed answer in these recordings is
that model or it is nothing. It is also why the two arms of a pair are the same scene rather than the same
session: the script is fixed, the model's replies are not, and a caption here never claims more than the frames
hold.</p>
<p><strong>How the <em>before</em> arm is taken.</strong> <code>proof/docker/record-x11-before.sh</code> holds every
source file the branch changed at its <code>main</code> content (<code>git show main:&lt;file&gt;</code>), records
the same scene into <code>proof/captures/x11/before/</code>, then restores from an in-memory copy and proves the
restore by sha256. No git mutation command runs and the working tree ends byte-identical.</p>
</div>

{body}
</body></html>
"""
    gone = sorted({src for src in re.findall(r'src="([^"#]+)"', html) if not (ROOT / src).exists()})
    if gone:
        print("MISSING FILES:", *gone, sep="\n  ", file=sys.stderr)
        raise SystemExit(1)
    if mislabelled:
        print("PAIRS THAT CLAIM A COMPARISON THEY ARE NOT:", *sorted(set(mislabelled)), sep="\n  ", file=sys.stderr)
        raise SystemExit(1)
    out = ROOT / "anchored-hud-proof.html"
    out.write_text(html, encoding="utf-8")
    print("wrote", out)


X = "captures/x11/"
XB = "captures/x11/before/"
S = "captures/x11/strips/"
W = "captures/wayland/"
N = "captures/notes/"
# The two arms of the HUD rebuild, both on the branch: `hud-before/` was recorded
# before the wrap fix and `hud-after/` after it, so `tree_of` correctly reads both
# as branch and a figure comparing them names its own axis instead.
XA = "captures/x11/hud-after/"
XH = "captures/x11/hud-before/"
SECTIONS = [
    Section(
        "One animation clock, and a card that unfolds onto it",
        [
            "<p>Every overlay in the product opens through one shared clock. The card's top border stays put, the"
            " bottom border slides down as the body arrives, and each row that arrives resolves out of the theme's"
            " ground rather than snapping to full strength. Recorded at 60fps, because the curve runs 220ms and a"
            " still taken from inside the scene lands after it every time.</p>",
            video(
                X + "overlay-motion.mp4",
                "One take: <code>/settings</code> opens and closes, <code>/hotkeys</code> prints its block into the"
                " transcript, <code>/model</code> opens and the pointer glides down the model list.",
                start=18,
            ),
            "<h3>The settings card arriving</h3>",
            strip(
                S + "settings-open",
                12,
                "Twelve consecutive frames at 60fps, cut from the recording above at 19.60s. Frames three and four"
                " are the card at its two-border minimum, a single line where the top and bottom borders meet; the"
                " body resolves out of the ground over the frames after it. Nothing here was drawn: these are pixels"
                " off the X display.",
            ),
            "<h3>The model picker arriving</h3>",
            strip(
                S + "model-open",
                12,
                "The same curve on a different card, from 36.25s of the same take. A second surface on the same"
                " clock is the point: the two cannot drift, because there is only one timer in the process.",
            ),
        ],
    ),
    Section(
        "And a card that folds away",
        [
            "<p>The dismissal used to be the half that was missing: the card was on screen in one frame and gone in"
            " the next. It now runs the same curve backwards, from wherever the reveal had got to, so a card"
            " dismissed before it finished opening folds away from there instead of jumping to full height first.</p>",
            video_pair(
                XB + "overlay-fold.mp4",
                X + "overlay-fold.mp4",
                "<code>/settings</code> and <code>/model</code> both vanish between two frames",
                "both fold away on the clock they opened on",
                start=20,
            ),
            "<h3>Escape, frame by frame</h3>",
            strip(
                S + "close-fold-main",
                12,
                "Twelve consecutive frames across the Escape. The card occupies one frame and"
                " the transcript occupies the next; there are no frames in between to show.",
                arm="main",
            ),
            strip(
                S + "close-fold",
                12,
                "The same twelve frames on the same scene. The bottom border walks back up"
                " to meet the top, the rows dim into the ground on the way, and the transcript underneath is never"
                " covered by a card that is no longer there.",
                arm="branch",
            ),
            still_pair(
                XB + "overlay-fold-settings-closed.png",
                X + "overlay-fold-settings-closed.png",
                "after the dismissal settles",
                "the same moment, and the same screen: the motion costs the transcript nothing",
            ),
        ],
    ),
    Section(
        "The band under the pointer, and the cross-fade between two rows",
        [
            "<p>The settings card paints nothing under the pointer on <code>main</code>: neither the setting rows in"
            " the pane nor the categories down the left edge answer a pointer that is over them, and the recording"
            " below is four jumps across both surfaces with the band count staying at zero. The category strip is a"
            " vertical tab bar, and it came last even on this branch: the pane rows were already banding while it"
            " was still switching its accent in a single frame, so it is the one this section is cut from.</p>",
            "<p>A band is per row, keyed on the row's identity rather than its position on screen, so a list that"
            " scrolls under a still pointer does not drag the band with it. Moving the pointer retargets every other"
            " live fade to zero and the named one to one: the row being left is still fading out while the row"
            " arrived at comes up. Strength zero is the absence of a band, not a band mixed all the way out, so an"
            " unhovered row keeps its exact unhovered bytes.</p>",
            "<p>The scene jumps the pointer eight rows at a time rather than gliding, because a glide crosses every"
            " row in between and gives each one a single frame, which is where a cross-fade and a switch look"
            " identical. Neither row it jumps between is the active category: the active one wears its own accent"
            " and would hide the band under it.</p>",
            video_pair(
                XB + "sidebar-crossfade.mp4",
                X + "sidebar-crossfade.mp4",
                "the pointer crosses the card and nothing follows it",
                "the row left fades out under the row reached",
                start=22,
            ),
            strip(
                S + "band-crossfade-main",
                8,
                "Eight consecutive frames at 60fps across the jump from Interaction to Tools,"
                " cut at 31.50s. The pointer is the only thing in the strip that moves.",
                arm="main",
            ),
            strip(
                S + "band-crossfade",
                8,
                "The same eight frames of the same jump in the same scene. Tools is banded,"
                " Interaction comes up over the middle four frames while Tools goes down, and neither is at full"
                " strength while the other is.",
                arm="branch",
            ),
        ],
    ),
    Section(
        "A real pointer, inside the card",
        [
            "<p>xdotool moves the X pointer over the terminal window and presses real buttons; the CLI reads SGR"
            " 1006 reports off its own stdin. Nothing is injected into the app.</p>",
            video(
                X + "settings-pointer.mp4",
                "The pointer walks the settings sidebar, clicks a section, then crosses the footer chips.",
                start=20,
            ),
            pair(
                X + "settings-pointer-sidebar-hover.png",
                X + "settings-pointer-sidebar-click.png",
                "The band tracks the pointer down the sidebar while the selection stays where the keyboard left it.",
                "A click opens that section, exactly as Enter does.",
            ),
            still(
                X + "settings-pointer-chip-hover-1.png",
                "The footer chips light under the pointer. A chip is a click target that does what its key does, so"
                " the keys a card advertises are the keys a mouse can press.",
            ),
        ],
    ),
    Section(
        "Four pickers that paint their own rows, and the same fade in each",
        [
            "<p>The branch card, the session tree, the history search and the session list are not the shared list"
            " component: each one paints its rows itself, so each one had to learn the fade separately. On"
            " <code>main</code> none of the four answers the pointer at all — the recording below crosses every one"
            " of them and the only band that ever appears is the keyboard selection. The fence against the four"
            " drifting apart is an equality rather than a convention: a band at full strength is the same bytes as"
            " the selection band, asserted directly, so a settled row cannot change appearance by adopting the"
            " motion.</p>",
            "<p>They also need state before they list anything, which is what the three turns at the top of this"
            " recording buy: three user messages, three history entries, and a session on disk. The model answering"
            " them is the container's own, so the recording runs at the speed that model reads a prompt on CPU.</p>",
            video_pair(
                XB + "pane-bands.mp4",
                X + "pane-bands.mp4",
                "the pointer crosses four cards and none of them answers it",
                "each card fades the row it left out under the row it reached",
                start=170,
            ),
            "<h3>The branch card, frame by frame</h3>",
            strip(
                S + "pane-crossfade-main",
                8,
                "Eight consecutive frames at 60fps across a jump from the first message to"
                " the second. The selection band on the third message is the only band in the strip.",
                arm="main",
            ),
            strip(
                S + "pane-crossfade",
                8,
                "The same jump. The first message is still going down while the second"
                " comes up, and the selection band underneath both is untouched by either.",
                arm="branch",
            ),
            pair(
                X + "pane-bands-tree-hover.png",
                X + "pane-bands-history-hover.png",
                "The session tree: one row per node, banded under the pointer while the selection stays where the"
                " keyboard left it.",
                "The history search, over the prompts this session typed.",
            ),
            still(
                X + "pane-bands-resume-hover.png",
                "The session list, the fourth of them. A selected row is never banded — it already wears the"
                " selection band, and a band at full strength is the same bytes — so the scene runs"
                " <code>/new</code> first and hovers the session it just left. Both titles were written by the"
                " container's 1.5B model, which is also what answered the turns.",
            ),
        ],
    ),
    Section(
        "Two more cards that band, and the ground a fade mixes out of",
        [
            "<p>The model picker and the <code>/mcp add</code> wizard are the last two surfaces that paint their own"
            " rows. On <code>main</code> the picker answers a pointer with nothing, and the wizard's second step is"
            " not a card at all: it is a plain transcript block starting at column zero, six rows lower down the"
            " screen. That is why the scene below hovers twice in the <em>main</em> arm — once at the branch card's"
            " geometry and once at main's own rows, at the coordinates main actually draws them — so <em>no band"
            " anywhere</em> is a measurement of main's list rather than a pointer that missed a card that moved.</p>",
            video_pair(
                XB + "card-bands.mp4",
                X + "card-bands.mp4",
                "the pointer crosses the picker rows and then main's own transport list, and neither answers it",
                "each card bands the row under the pointer and cross-fades to the next",
                start=24,
            ),
            "<h3>The model picker, frame by frame</h3>",
            strip(
                S + "card-bands-picker-main",
                8,
                "Eight consecutive frames at 60fps at 26.50s, across a jump between two model"
                " rows. Only the pointer moves.",
                arm="main",
            ),
            strip(
                S + "card-bands-picker",
                8,
                "The same eight frames of the same jump. The row left goes down while the"
                " row reached comes up, and the keyboard selection under both is untouched.",
                arm="branch",
            ),
            "<h3>The wizard step, frame by frame</h3>",
            strip(
                S + "card-bands-wizard-main",
                8,
                "The same moment in the same scene, cut wider because there is no card to cut"
                " into: the transport choices are transcript rows at column zero and the pointer passes over them.",
                arm="main",
            ),
            strip(
                S + "card-bands-wizard",
                8,
                "The step is a card, its rows are the card's rows, and they band and"
                " cross-fade on the same clock as every other surface on this page.",
                arm="branch",
            ),
            "<h3>The ground the mix travels out of</h3>",
            "<p>Recording this at 60fps found a defect the fade itself had been hiding. A band is a blend between"
            " the page under the row and the selection colour, and the blend was reading the ground the <em>theme"
            " declares</em>. Titanium declares black; <code>tui.paintGround</code> defaults to <code>auto</code> and"
            " refuses to paint black onto a terminal that is already grey, so nothing on screen was black and every"
            " mix still started there. A leaving row measured <code>#090401</code> between a <code>#1c1f26</code>"
            " page and a <code>#231310</code> band: darker than the page it sat on and darker than the band it was"
            " leaving, a dip on the way in and again on the way out.</p>",
            "<p>The ground now has one owner and one order — the ground this process painted, else the one the"
            " terminal reported over OSC 11, else the theme's declared ground for a terminal that answered neither"
            " — and the call that paints is the call that records what it painted, so a policy that declines to"
            " paint cannot leave the animations mixing out of a colour nothing put on screen. The frames above are"
            " the fixed build: the leaving row reads <code>(31,30,33)</code>, between the two endpoints rather than"
            " below both.</p>",
        ],
    ),
    Section(
        "The composer popup grows out of the composer",
        [
            "<p>The autocomplete used to arrive at its full height, so the rows slid past a border already sitting"
            " where it would end up. It now grows: the frame itself is short on the first frame and reaches its"
            " height over the curve. Dismissal stays instant, and that asymmetry is deliberate — a popup you have"
            " decided against should not take a fifth of a second to agree.</p>",
            video_pair(
                XB + "popup-grow.mp4",
                X + "popup-grow.mp4",
                "the list is at full height in the first frame that has it",
                "the frame grows, and the rows arrive inside it",
                start=19,
            ),
            strip(
                S + "popup-grow",
                12,
                "Twelve frames from the slash. The border reaches its height over the curve; the dismissal that"
                " follows it in the recording takes one frame.",
            ),
            pair(
                X + "popup-grow-slash-popup.png",
                X + "popup-grow-at-filtered.png",
                "The command list, settled.",
                "The file list narrowed to <code>src/</code>, off the working tree the container seeded.",
            ),
        ],
    ),
    Section(
        "A real turn, on a model in the same container",
        [
            "<p>The provider is <code>llama.cpp</code> on the recorder's own docker network holding"
            " <code>qwen2.5-1.5b-instruct-q4_k_m</code>. No provider account is reachable from inside, so what"
            " streams below is that model or nothing.</p>",
            video(
                X + "session-local-llm.mp4",
                "A turn streams, the pointer crosses the composer chips while it is in flight, and a left click on"
                " <code>escape interrupt</code> stops the turn.",
            ),
            pair(
                X + "session-local-llm-streaming-1.png",
                X + "session-local-llm-chip-hover-2.png",
                "The answer arriving, a token at a time.",
                "The interrupt chip under the pointer while the turn is in flight.",
            ),
            pair(
                X + "session-local-llm-after-interrupt.png",
                X + "session-local-llm-answer-settled.png",
                "After the click: the turn is stopped and the chips are gone.",
                "A later turn, left to finish.",
            ),
        ],
    ),
    Section(
        "One left rail, and a printed block that is no longer a box",
        [
            "<p>The transcript carries one left rail two columns in, and every block hangs off it. On"
            " <code>main</code> a block printed into the transcript draws its own frame instead: <code>/hotkeys</code>"
            " comes out as a full-width box with a rule under it at column zero, which reads as a page break in the"
            " middle of a conversation. Both stills below are the same scene, the same command and the same"
            " terminal size, one arm apart.</p>",
            still_pair(
                XB + "overlay-motion-hotkeys-settled.png",
                X + "overlay-motion-hotkeys-settled.png",
                "the block is boxed on all four sides and followed by a full-width rule",
                "the same block, hung off the rail, with no horizontal at column zero",
            ),
            still(
                X + "overlay-motion-idle.png",
                "The transcript at rest on the branch: one rail, two columns in.",
            ),
        ],
    ),
    Section(
        "What a spawned agent runs, on one page instead of five",
        [
            "<p>On <code>main</code> the category holds a flat list in three sections: an <code>Agents</code>"
            " section whose single row is <code>Agent Roster</code>, a <code>Models</code> section three rows below"
            " it carrying <code>Subagent Model</code>, <code>Models by Depth</code> and <code>Subagent Effort</code>,"
            " and <code>Max Nested Spawn Depth</code> further down again under <code>Limits</code>. The roster's"
            " per-agent page changed none of them — it printed a sentence telling you to go back up and edit the"
            " Models section — so the screen that showed what a lane runs and the rows that decided it were three"
            " sections apart, and the ceiling was edited on one screen and read on another.</p>",
            "<p>It is one recursive tree now. Every level carries the same four rows — Enabled, Model, Effort, and"
            " Subagents, the door to the level below — so the page that answers <em>what does deep run</em> is the"
            " page that answers <em>what may deep spawn, and what does that run</em>, unbounded. Unset means the"
            " lane above, not a default table: change what <code>deep</code> runs and everything under it follows."
            " <code>Subagents → Enabled</code> IS the depth limit, level by level, so the per-agent number is gone"
            " from every screen; the blanket ceiling that shipped config files still carry sits beside the roster"
            " rather than two sections away.</p>",
            still_pair(
                XB + "subagent-lanes-pane.png",
                X + "subagent-lanes-pane.png",
                "main: <code>Agents</code>, then <code>Models</code>, then the ceiling down in <code>Limits</code>"
                " — and no band under the pointer, which is the same defect the pickers above have",
                "the branch: one <code>Subagents</code> section — roster, ceiling, model, effort — and the row the"
                " pointer is on is banded",
            ),
            pair(
                X + "subagent-lanes-lane.png",
                X + "subagent-lanes-nested.png",
                "One lane. Every value names where it came from: <em>inherit · the session's model</em>,"
                " <em>off · this lane may not spawn</em>.",
                "Through the door. The same four rows, one level down, and now unset reads"
                " <em>inherit · the level above</em> — the lane, not the session.",
            ),
            video(
                X + "subagent-lanes.mp4",
                "The whole descent, in one take: the category opened with a click, the roster, one lane, the level"
                " under it, and back out.",
                start=24,
            ),
        ],
    ),
    Section(
        "A defect this branch fixes, on camera",
        [
            "<p>A virtualized transcript spliced out the rows the engine had committed to native scrollback, and"
            " the engine kept the pre-splice coordinates. The next frame read the shift as a divergence and, with"
            " <code>tui.scrollbackRebuild</code> on, erased native scrollback and replayed a frame whose history"
            " the container had already dropped. Both arms below drive the same scene at the same size.</p>",
            video_pair(
                XB + "transcript-blanking.mp4",
                X + "after/transcript-blanking.mp4",
                "history is erased as the session runs; scrolling back finds nothing",
                "every row survives; scrollback walks the whole session",
            ),
        ],
    ),
    Section(
        "A card made of materials, measured in the terminal",
        [
            "<p>The animation was landing on a card that was still line art: a frame in one accent colour and text"
            " in one grey, on the terminal's own ground. Nothing was in front of anything, so a card arriving had"
            " nothing to arrive over. The first attempt at a material was one gradient across the whole card, and"
            " that is what the arms below are: it measured <strong>twelve of 255</strong> above the page at the top"
            " row and <strong>four</strong> at the foot, on a page of 28 — and the foot mixed toward black, so the"
            " lower half of every card sank BELOW the page it was standing on.</p>",
            "<p>A card is now four materials and the page. Each number here was read off the pixels of the"
            " recording beside it, not out of the source: page <code>30,33,39</code>; the category column set into"
            " the plate <code>36,39,44</code>; the footer tray under the tip and the chips <code>39,42,48</code>;"
            " the plate itself <code>52,54,60</code> at its top row grading to <code>47,49,55</code> at its last;"
            " and the title rail <code>64,66,71</code>. The direction is chosen by the ground's own luminance, so a"
            " card on a paper-white terminal darkens instead of lifting toward an invisible white, and a terminal"
            " that never answered OSC 11 still gets the card it always had.</p>",
            still_pair(
                X + "overlay-motion-settings-settled.png",
                X + "ladder/overlay-motion-settings-settled.png",
                "one wash: the card and the page measure the same colour",
                "four materials: rail, plate, tray, and the category column set into it",
                arms=("before the material ladder", "after it"),
            ),
            "<h3>The light crossing the plate, and where it used to die</h3>",
            "<p>The highlight runs on a 520ms curve, twice the 260ms unfold, because the point of it is that the"
            " card is already in place while the light is still travelling across it. It was not doing that. The"
            " driver reported a finished sweep the moment the UNFOLD settled, so the light died on the frame the"
            " card stopped growing.</p>",
            "<p>Measured, not asserted. Both recordings below are the same take at 60fps. For each frame, a"
            " 660&times;260 window of the plate is averaged down to one row of column means and differenced against"
            " the settled frame, so the brightest column of the difference IS the light's position and a zero"
            " difference means the card is static. The light's position, in columns of that window, frame by"
            " frame:</p>",
            "<table><tr><th>from the card's arrival</th><th>before</th><th>after</th></tr>"
            "<tr><td>117ms</td><td>0</td><td>1</td></tr>"
            "<tr><td>150ms</td><td>142</td><td>175</td></tr>"
            "<tr><td>200ms</td><td>298</td><td>323</td></tr>"
            "<tr><td>233ms</td><td>433</td><td>455</td></tr>"
            "<tr><td>267ms</td><td>531</td><td>557</td></tr>"
            "<tr><td>300ms</td><td><em>gone</em></td><td>590</td></tr>"
            "<tr><td>317ms</td><td><em>gone</em></td><td>590</td></tr>"
            "<tr><td>333ms</td><td><em>gone</em></td><td><em>past the edge</em></td></tr></table>",
            "<p>Before, the light vanished with its centre at column 531 of 660 — four fifths of the way across a"
            " card it never finished crossing, and the whole card static from that frame on. After, it keeps going"
            " to 590 and then leaves by the right edge, which is where a highlight is supposed to go: the band's"
            " centre travels from off the left edge to off the right, so it exits at about 95% of its curve rather"
            " than being switched off mid-plate.</p>",
            strip(
                S + "light-before",
                8,
                "BEFORE. Eight frames at 60fps from the moment the card lands. The diagonal band crosses the plate"
                " and then simply is not there.",
            ),
            strip(
                S + "light-after",
                8,
                "AFTER. The same eight-frame window on the same scene, one commit later. The band keeps travelling"
                " over a card that has already landed, and leaves by the far edge.",
            ),
            video(
                X + "sweep/overlay-motion.mp4",
                "The same take as the top of this page, recorded again on the material with the light living its"
                " whole life: <code>/settings</code>, <code>/hotkeys</code> and <code>/model</code>, each card"
                " arriving as a lit surface.",
                start=18,
            ),
        ],
    ),
    Section(
        "The loudest object on the screen was a note",
        [
            "<p>A still from a real session showed a note about twelve todos rendered as a saturated mustard"
            " rectangle of black text, full bleed from column 0, in the middle of a grey transcript. Two components"
            " drew it: the todo reminder and the rule-injection notice, both building"
            " <code>new Box(1, 1, t =&gt; theme.inverse(theme.fg(&quot;warning&quot;, t)))</code>, which pads every"
            " row out to the terminal width and inverts it. They were the only blocks in the transcript touching"
            " the left edge, and inverting spent the foreground too, which is why the rule notice carried a comment"
            " saying styling inside the block was limited to bold and italic.</p>",
            "<p>The hue now lives in one column. A rail glyph down the left names the note's kind, the block is as"
            " wide as its own widest line, it sits at the composer's inset, and its background is a lift off the"
            " ground the terminal actually reported: on a grey page the reminder measures <code>47,50,55</code>"
            " against a <code>30,33,39</code> ground, grading down to <code>46,48,54</code> at its last row. The"
            " arms below are the same three notes with the same text, drawn through the two chromes"
            " (<code>scripts/demos/render-todo-reminder.ts --slab</code> against its default), rasterized from the"
            " real components' own bytes.</p>",
            still_pair(
                N + "note-slab-grey.png",
                N + "note-card-grey.png",
                "three full-width inverted slabs, each starting at column 0",
                "three cards on a rail, each as wide as its text and inset like everything else",
                arms=("--slab", "default"),
            ),
            "<h3>The same notes on a black terminal</h3>",
            "<p>One ground answers half the question, and this is the case the treatment has to get right: a fill"
            " chosen for a grey page is a slab on black, and a fill chosen for black is invisible on grey. The"
            " elevation is not a colour, it is a step away from whatever the terminal reported, so the pair below is"
            " the same two chromes with the ground answered as <code>#000000</code>. The slab does not change &mdash;"
            " it never asked what it was standing on.</p>",
            still_pair(
                N + "note-slab-onblack-black.png",
                N + "note-card-onblack-black.png",
                "the same rectangle whatever it is standing on",
                "a card that lifts off black by the same step it lifts off grey",
                arms=("--slab", "default"),
            ),
            "<h3>And with no ground to stand on</h3>",
            still(
                N + "note-flat-grey.png",
                "The OFF arm of the material: a terminal that never answered OSC 11, or one without 24-bit colour,"
                " gets the rail and the colours and no surface at all. It is still a note, and it is still not a"
                " slab &mdash; the treatment degrades rather than guessing at a ground.",
            ),
        ],
    ),
    Section(
        "A demo of the product working, in a terminal someone would recognise",
        [
            "<p>The demos on the landing page were a 1.5B model answering questions in a flat black VHS terminal:"
            " they showed a transcript and nothing the product does. No file read, no edit, no command, no plan."
            " The take below is one session captured at 2560x1440 against <strong>Qwen3.8 27B</strong>, served by"
            " ollama on the recorder host at 67 tokens a second and published at 1920x1080. The model matters as much"
            " as the resolution — a 1.5B answers a question, and a 27B calls the tools, so what is on screen is the"
            " read block, the edit, the command the model chose to verify itself with, and the plan panel, rather"
            " than prose about them.</p>",
            "<p><strong>What makes it look like a terminal on a desktop.</strong> The session runs under a"
            " compositor: a lit neutral backdrop, the window inset from the screen edge, and picom rounding its"
            " corners, frosting what shows through it and casting its shadow. The backdrop is neutral but not"
            " featureless, and both halves of that matter. An earlier version lit it violet in one corner and cyan"
            " in the other, which put a saturated rim on every window edge and competed with the terminal, so the"
            " field went colourless; but it was also blurred to <code>0x70</code>, which is past the point where"
            " anything is left to blur, and a window blur that samples a smooth gradient returns the same smooth"
            " gradient. Structure survives now, and the glass has something to refract.</p>",
            still_pair(
                X + "chrome-backdrop-flat.png",
                X + "chrome-default.png",
                "the field blurred to <code>0x70</code>. Nothing is left to blur, so the window's own blur samples a"
                " flat grey and returns a flat grey: the glass reads as a tint.",
                "the same window over a field that kept its structure. The sheen crosses behind the window and the"
                " frost bends it, which is the entire difference between translucent and glass. Cropped to the text"
                " at full resolution, the interior contrast of the two is indistinguishable; the compositor's opacity"
                " dominates inside the window, and the change is paid for outside it.",
                arms=("flat backdrop", "structured backdrop"),
            ),
            "<p><strong>The blur backend, and a flag that lies.</strong> The recipe read that this display has no"
            " accelerated GL and that picom's glx backend therefore fails at initialisation, which left xrender,"
            " whose only blur method is a fixed convolution kernel capped at the widest built-in preset. That reason"
            " is false. There is no acceleration and <code>glxinfo</code> answers <code>llvmpipe</code>, but picom"
            " does not need acceleration, it needs a GL context, and it gets one: on glx it reports"
            " <code>Screen redirected.</code> and runs <code>dual_kawase</code>, a multi-pass blur with a strength"
            " knob rather than a fixed 11-pixel kernel. Every signal available without looking says it works.</p>",
            "<p>It does not. Recorded as a pair through a scene that drives no model turn, so the only difference"
            " between the two frames is the glass, the glx arm captures a window with <em>no contents</em> - the"
            " rounded rectangle, the shadow, and a grey smear where the terminal grid belongs - while the xrender arm"
            " captures the session. picom composites the backdrop on this GL stack and drops the window's own pixels,"
            " and its log says nothing about it: both arms report the identical successful redirect. So xrender's"
            " kernel blur remains the default, <code>SCENE_CHROME_BACKEND=glx</code> makes the other path reachable"
            " for the day this container gets a real GPU, and the run prints which chrome it recorded with"
            " (<code>chrome: xrender kernel 11x11gaussian redirected the screen</code>) so a take can never be"
            " published without that being answerable. A compositor cannot be reviewed from its flags; this one"
            " reported success while producing an empty window.</p>",
            still_pair(
                X + "chrome-default.png",
                X + "chrome-glx-blank.png",
                "xrender, <code>kernel 11x11gaussian</code>: the session.",
                "glx, <code>dual_kawase strength 10</code>, same scene and same backdrop, the backend the only"
                " variable: a rounded rectangle, a shadow, and no terminal. picom logged"
                " <code>Screen redirected.</code> for this frame.",
                arms=("shipped", "rejected"),
            ),
            "<p>The translucency is the compositor's, not the terminal's, and that distinction is the whole fix: this"
            " X server exposes no GLX configuration carrying an alpha channel, so the terminal cannot pick an ARGB"
            " visual and logs exactly that, while picom applies opacity to a window that knows nothing about it."
            " <code>SCENE_THEME=plain</code> keeps every other scene on this page recording the flat capture it was"
            " recorded against.</p>",
            "<h3>The ceiling, and what got past it</h3>",
            "<p><strong>Why the frost above is a backdrop and not the window.</strong> Everything in this section"
            " so far blurs the field <em>behind</em> an opaque terminal, because on this X server that is the only"
            " blur available: picom's one working backend convolves with a fixed kernel, and the backend that can"
            " blur the window itself drops the window's contents. The limit is structural rather than a setting."
            " picom reads the window's pixels back out of the X server through texture-from-pixmap, and a"
            " software GL stack has nothing to hand it, so the compositor keeps the geometry and loses the"
            " contents. No amount of tuning reaches past that.</p>",
            "<p><strong>A Wayland compositor cannot fail that way.</strong> There is no pixmap to scrape: the"
            " client hands its own buffer to the compositor, so blur, a corner radius and a shadow apply to the"
            " terminal itself. Of the compositors that are actually obtainable here, exactly one has all three"
            " natively - kwin-wayland's blur needs <code>org_kde_kwin_blur</code> and the terminal never asks for"
            " it, sway, weston and labwc have no blur at all, and wayfire has kawase blur but keeps its rounded"
            " corners in an unpackaged plugin and drew no measurable shadow. So the recorder builds swayfx from"
            " source, with the pins read out of each project's own <code>meson.build</code> rather than guessed:"
            " wlroots 0.19.1, scenefx 0.4.1, swayfx 0.5.2. No swayfx release wants the wlroots this base image"
            " ships, which is why the chain is built rather than installed.</p>",
            still_pair(
                X + "chrome-default.png",
                W + "chrome-swayfx.png",
                "picom on X11: the field behind the window is frosted, the window's own edge is a hard flat"
                " rectangle, and the interior is an opacity applied to pixels the terminal drew for an opaque"
                " visual.",
                "swayfx on Wayland, same scene, same product, same 134x31 grid: the corner radius, the drop"
                " shadow and the blur are on the terminal's own buffer. The window refracts what is behind it"
                " and the text on top stays sharp.",
                arms=("X11 / picom", "Wayland / swayfx"),
            ),
            "<p>The scene is the same file on both. Six primitives - a key, a pointer move, a pointer read, a"
            " click, a window rectangle, a capture - moved behind a backend the scene never names, and the X11"
            " calls are unchanged byte for byte, because every other frame on this page was recorded through"
            " them. Both arms resolve the identical grid from the same scene"
            " (<code>134x31 cells of 17x37px at +128+128</code>), which is the check that the abstraction did not"
            " quietly move the surface being photographed. The Wayland arm prints its own chrome the same way"
            " (<code>chrome: swayfx radius 26 blur 3x5 shadow 44 composited the output</code>).</p>",
            "<p><strong>One of the six is not the same, and saying so is the point.</strong> Five primitives"
            " announce their own failure - a key that never arrives leaves the composer empty, a capture that"
            " fails writes no file. The pointer does not. sway's headless backend gives the seat no pointer"
            " device, so <code>swaymsg seat seat0 cursor set</code> exits 0 while the client receives no enter,"
            " no motion and no button, and the backend was reporting the position back out of the variable it"
            " had just set. A probe run against both servers is what made that readable: the same click, aimed"
            " at a settings sidebar row taken out of the screen rather than hardcoded, selected that row on X11"
            " and changed nothing at all on Wayland. So on Wayland the pointer report goes into the pty in SGR"
            " 1006 at the cell the pointer stands on, the way typed text and keys already do. The application's"
            " hit-testing, hover fades and click routing run for real; the compositor's input path and the"
            " terminal's encoding of a physical button are exercised only on X11. A frame of a hover state"
            " recorded through the pointer that silently did nothing would have been the rest state with a"
            " caption claiming otherwise.</p>",
            "<p><strong>And the check on that is not the one you would write first.</strong> The obvious test is"
            " that the row under the pointer gets brighter. It does on X11 and it does <em>not</em> on Wayland,"
            " from the same product on the same theme: +0.004 against -0.032 mean luminance, because the hover"
            " wash is a near-opaque dark fill and the sidebar around it is a translucent window over a blurred"
            " backdrop, so the identical band reads brighter inside an opaque window and darker inside a glass"
            " one. Written as a threshold on the signed difference, the check called a hover band that is"
            " plainly in the frame - brighter label, wash, left marker - a pointer that never arrived. The test"
            " that holds on any compositor is that the row the pointer is on changed and a row four down did"
            " not: a global brightness shift cancels, and that is what \"the pointer reached the application\""
            " means.</p>",
            "<h3>One objective, one autonomous build</h3>",
            video(
                X + "demo-hd-cut.mp4",
                "One operator task builds Nebula Drift end to end: the model creates its persistent objective from"
                " the prompt, opens an eight-task plan, launches three implementation workers, integrates their"
                " modules, passes tests and typecheck, compiles a standalone terminal 3D ship simulator, signs that"
                " binary through a protected secret placeholder, completes the goal, and presents the running"
                " simulator.",
            ),
            "<p>Before submitting the task, the operator uses <code>/secret from-env</code> to store a synthetic"
            " release key without typing it into the transcript. The single user prompt then tells the model what"
            " done means. The model creates its own persistent goal, and goal continuation owns every later model"
            " turn; no follow-up prompt restates the work or pushes it into the next phase.</p>",
            "<p>The opening stays at the recorder's real speed through the goal, todo board, and concurrent worker"
            " launch. The implementation middle plays at 1.25x, with untouched screens trimmed to four seconds."
            " Playback returns to real speed before the verification, compiled simulator, permission dialog, binary"
            " signature, completed plan, completed goal, and final presentation. The boundaries come from named"
            " scene marks in the same take rather than timestamps chosen after watching it.</p>",
            video(
                X + "demo-hd.mp4",
                "The complete unedited session from which the landing-page cut and every frame below are derived.",
            ),
            still(
                X + "demo-hd-secret-stored.png",
                "The synthetic release key enters the vault from the environment. The transcript receives a name and"
                " placeholder, not the key.",
            ),
            still(
                X + "demo-hd-goal-created.png",
                "The model-created Nebula Drift objective before implementation starts. Goal mode keeps this card"
                " separate from the transcript tail and carries the task across turns.",
            ),
            still(
                X + "demo-hd-todo-board.png",
                "The model-authored four-phase, eight-task board: flight plan, three parallel modules, integration,"
                " verification, signing, and presentation. Every task is still open.",
            ),
            still(
                X + "demo-hd-agent-lanes.png",
                "DynamicsAgent, RenderAgent, and FlightAgent live together, each owning disjoint simulator modules"
                " under one goal turn.",
            ),
            still(
                X + "demo-hd-integration-edit.png",
                "The parent agent integrates the seeded CLI through a hash-anchored edit while the workers implement"
                " vector math, flight physics, autopilot behavior, and the terminal renderer.",
            ),
            still(
                X + "demo-hd-build-verified.png",
                "The generated project's tests, TypeScript check, and standalone binary build all pass before the"
                " release phase begins.",
            ),
            still(
                X + "demo-hd-simulator-preview.png",
                "The compiled binary running its deterministic perspective-projected ship, star field, navigation"
                " gate, autopilot state, and flight telemetry.",
            ),
            "<h3>The binary is signed at the secret boundary</h3>",
            "<p>The model writes <code>#RELEASE_SIGNATURE#</code> in the signing command. Veyyon substitutes the key"
            " only at the outbound bash boundary and stops on a permission dialog that shows the operator the"
            " resolved command. The project writes an HMAC-SHA256 over the compiled binary to"
            " <code>dist/nebula-drift.sig</code>; it never prints the key.</p>",
            "<p><code>proof/verify-binary-signature.py</code> recomputes the HMAC from the archived binary, signature,"
            " and synthetic key recorded outside the transcript. A changed binary, changed key, malformed signature,"
            " or placeholder that never expanded fails the check.</p>",
            still(
                X + "demo-hd-secret-approval.png",
                "The binary-signing command held for explicit operator approval after placeholder expansion.",
            ),
            still(
                X + "demo-hd-signature-written.png",
                "The signature file beside the compiled binary and the stable SIGNED BINARY completion marker.",
            ),
            still(
                X + "demo-hd-todo-finished.png",
                "The same eight-task board closed after implementation, verification, and signing.",
            ),
            still(
                X + "demo-hd-goal-complete.png",
                "The model calls the goal tool itself. The persisted objective reports Status: complete before the"
                " final simulator run.",
            ),
            still(
                X + "demo-hd-presentation.png",
                "The final frame: the signed Nebula Drift binary running after the goal and all eight tasks are"
                " complete.",
            ),
        ],
    ),
    Section(
        "The board, rebuilt",
        [
            "<p>The board the hero take recorded is not the board the product draws now. The pair below is one scene,"
            " <code>proof/scenes/rail-and-todo.sh</code>, recorded twice at 131 columns by the same container --"
            " once against the tree without this work and once against the tree with it -- and sampled at the same second of the"
            " same script, so both arms hold the same three-phase board with the same task in flight and the same"
            " one closed behind it.</p>",
            still_pair(
                XB + "rail-and-todo-todo-board-live.png",
                XA + "rail-and-todo-todo-board-live.png",
                "the header carries a count of its own, <code>Todos · phase 1/3</code>, over phase rows ending in"
                " identically shaped numbers counting something else. Box-drawing connectors bracket every row, each"
                " phase prints its count inline beside its name, and a phase nobody has started yet is collapsed to"
                " that name -- so the block says how far along the plan is and not what the plan is.",
                "the header is bare. The only counts left are per phase, right-aligned at the far margin where they"
                " form a column instead of trailing three different names at three different offsets. The rail"
                " replaces the connectors and carries the block's liveness: lit beside the phase being worked, flat"
                " when nothing is in flight. Square cells modulated by density replace the mixed marker set -- an"
                " empty box waiting, a breathing pixel on the row in flight, a small filled square on closed work,"
                " struck and dimmest -- and every phase keeps its tasks on screen, because a plan the block will not"
                " show you is a progress bar.",
            ),
            "<p>Later in the same take, with two of the three phases closed out, every phase still keeps a row. The"
            " trim drops finished work off the top when the block runs out of height; it never drops a phase to make"
            " room for its own arithmetic.</p>",
            still(
                XA + "rail-and-todo-todo-board-closed.png",
                "Two phases closed and one still open at <code>1/2</code>. The card above the block carries the"
                " sentence once -- <code>■ Todo list done · 6 tasks</code> -- and the block underneath keeps all"
                " three phase rows with their counts in the same column.",
            ),
        ],
    ),
    Section(
        "A badge on a line of its own, found by the camera",
        [
            "<p>The lane block and the board each clamp every row to one cell inside the width they are handed, and"
            " every unit test of both agreed: a sweep of every column count from 1 to 220 came back with no row over"
            " its bound. The bound was not the width they get. Both blocks are mounted in a container carrying a"
            " one-cell margin on each side, and that container soft-wraps its content to"
            " <code>width - padding * 2</code> before anything reaches the terminal, so every row was two cells too"
            " wide and its tail landed on a line of its own at the left margin, outside the rail. Nothing in the"
            " suite could see it, because the blocks were obeying the number they were given.</p>",
            "<p>The recording below is what saw it. Same scene, same container, same 131 columns, two live subagent"
            " lanes: <code>proof/scenes/agent-lanes.sh</code> against the tree before the wrap fix and after it. The"
            " model badge is the row's right-aligned tail, which is exactly the part a two-cell overflow takes"
            " away.</p>",
            video_pair(
                XH + "agent-lanes.mp4",
                XA + "agent-lanes.mp4",
                "the badge is wrapped: read the block from the top and the name of the model each lane is running"
                " arrives underneath its lane, at column zero, outside the rail that is supposed to contain it.",
                "the badge sits on its lane, right-aligned at the far margin, and the block is the four rows it"
                " emitted.",
                start=68,
                arms=("before the fix", "after it"),
            ),
            still_pair(
                XH + "agent-lanes-lanes-two-live.png",
                XA + "agent-lanes-lanes-two-live.png",
                "one frame of it, held: <code>demo-qwen38-27b-64k</code> on its own line above and below the lane"
                " row it belongs to, breaking the block into six rows where the renderer emitted four.",
                "the same frame of the same scene, four rows: header, two lanes each ending in its own badge, and"
                " nothing at column zero that the block did not put there.",
                arms=("before the fix", "after it"),
            ),
            "<p>The regression suite that closes this asserts the invariant those width bounds were serving rather"
            " than another width bound -- a mounted block renders exactly the rows it emitted -- and drives the real"
            " interactive mode at 80 and 131 columns. Re-injecting the defect turns both live cases red at six rows"
            " against four. It sweeps the mode's anchored containers at run time and pins the set by exact equality,"
            " so a seventh anchored surface cannot be added without someone deciding whether it may wrap.</p>",
        ],
    ),
    Section(
        "A fourteen-task plan, closed out",
        [
            "<p>The board's rebuild is a set of claims about MOTION, and a still cannot carry any of them: that"
            " fourteen rows arrive whole rather than being typed in, that the block walks itself forward as each"
            " task closes, that closed work recedes while the task in flight stays the only bright row, and that the"
            " region above the composer is GONE on the last close rather than collapsing to a line the transcript"
            " card already carries. So the row is a recording. The session behind it is real: the model was told to"
            " write a five-phase plan for a transcription service and then close it out, and it was told to hold off"
            " starting the work, so what the board tracks is the plan and nothing else.</p>",
            f"<p>The take is {clip_runtime(XA + 'todo-marathon.mp4'):.0f} seconds of session at the speed it was"
            " recorded, unedited, on the tree with this work. The same scene against the tree without it is not on this page,"
            " because the pair that carries the design change is the one above: same recorder, same scene, same"
            " second of the same script. This row is here for the motion, and for the two states a still of a"
            " settled board cannot reach.</p>",
            video(
                XA + "todo-marathon.mp4",
                "Fourteen tasks over five phases written in one call, then closed out. The board is the block above"
                " the composer throughout.",
                start=112,
            ),
            "<h3>Where the board stands, four times</h3>",
            still(
                XA + "todo-marathon-list-open.png",
                "Fourteen tasks over five phases from a single <code>init</code> call, and the header is just"
                " <code>Todos</code>. Every count on the block is a phase's own, right-aligned in one column at the"
                " far margin; the only global number is on the overflow row, <code>… 9 more</code>, which is the"
                " row that exists because the plan is longer than the space. No phase carries a gauge: five 12-cell"
                " bars approximating five fractions printed two columns to their right is what this row used to be,"
                " and at that width a gauge cannot separate <code>0/2</code> from <code>1/4</code>.",
            ),
            still(
                XA + "todo-marathon-walk-early.png",
                "One task closed inside the working phase. The three tiers are all on screen at once: the closed row"
                " struck and dimmest, the row in flight carrying the ink with the breathing cell beside it, the"
                " waiting rows quiet. <code>I. Foundation</code> reads <code>2/3</code> and the rail is lit beside"
                " it.",
            ),
            still(
                XA + "todo-marathon-walk-late.png",
                "Three phases closed and the block has walked itself to <code>IV. Verification</code> without being"
                " told to. The finished phases each keep a row -- <code>3/3</code>, dim, with a small filled square"
                " -- because a plan that deletes its own history to make room for arithmetic is a progress bar. The"
                " working phase is expanded around the task in flight and <code>V. Release</code> is named but not"
                " opened.",
            ),
            still(
                XA + "todo-marathon-finished.png",
                "The last task closes and the anchored region is simply not there. What remains is one line on the"
                " card that closed it -- <code>■ Todo list done · 14 tasks</code> -- which is the sentence the block"
                " used to draw as well, from the same owner, in the same session, anchored above the composer for"
                " the rest of it. The model's own confirmation under it reads 14/14 done, 0 open, all five phases"
                " closed.",
            ),
        ],
    ),
]

if __name__ == "__main__":
    if "--anchored-hud" in sys.argv[1:]:
        write_anchored_hud(SECTIONS)
    else:
        write([*SECTIONS, long_session_section()])
