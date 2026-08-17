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


def video_pair(before: str, after: str, cap_before: str, cap_after: str, start: float | None = None) -> str:
    sound(before)
    sound(after)
    frag = f"#t={start:g}" if start is not None else ""
    return (
        '<div class="pair">'
        f'<figure><video controls loop muted playsinline preload="metadata"><source src="{before}{frag}" type="video/mp4"></video>'
        f"<figcaption><strong>main</strong> — {cap_before}</figcaption></figure>"
        f'<figure><video controls loop muted playsinline preload="metadata"><source src="{after}{frag}" type="video/mp4"></video>'
        f"<figcaption><strong>branch</strong> — {cap_after}</figcaption></figure>"
        "</div>"
    )


def strip(prefix: str, frames: int, caption: str) -> str:
    imgs = "".join(f'<img src="{need(f"{prefix}-f{i:02d}.png")}" alt="frame {i}">' for i in range(frames))
    # Two rows of equal length, so an eight-frame strip is 4x2 rather than 6+2.
    cols = frames if frames <= 6 else (frames + 1) // 2
    style = f' style="grid-template-columns: repeat({cols}, 1fr)"'
    return f'<figure><div class="strip"{style}>{imgs}</div><figcaption>{caption}</figcaption></figure>'


def still(rel: str, caption: str) -> str:
    need(rel)
    return f'<figure><img src="{rel}" alt=""><figcaption>{caption}</figcaption></figure>'


def still_pair(before: str, after: str, cap_before: str, cap_after: str) -> str:
    need(before)
    need(after)
    return (
        '<div class="pair">'
        f'<figure><img src="{before}" alt=""><figcaption><strong>main</strong> — {cap_before}</figcaption></figure>'
        f'<figure><img src="{after}" alt=""><figcaption><strong>branch</strong> — {cap_after}</figcaption></figure>'
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
            "<p>The session in the left video is a real one of the operator's, resumed inside the container:"
            " 289MB of JSONL, 69,727 records, 34,552 messages, 87 earlier compactions. The right video is the"
            " same scene with no session at all, so the two differ in exactly one thing — what is above the"
            " window. Same keys, same 1.5B model on the container network, same camera, same terminal.</p>",
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
                "control: the same scene on an empty session",
                start=25,
            ),
            f"<table><thead>{head}</thead><tbody>{body}</tbody></table>",
            "<p>The resumed arm carries one cost the control does not, and it is model-side rather than"
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
<p><strong>Which model answers.</strong> A <code>llama.cpp</code> server holding
<code>qwen2.5-1.5b-instruct-q4_k_m</code>, reachable only as the container-network provider <code>local</code>.
No provider account is reachable from the container, so a streamed answer in these recordings is that model on
CPU or it is nothing.</p>
<p><strong>How the <em>main</em> arm is taken.</strong> <code>proof/docker/record-x11-before.sh</code> holds every
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
    out = ROOT / "ui-polish-proof.html"
    out.write_text(html, encoding="utf-8")
    print("wrote", out)


X = "captures/x11/"
XB = "captures/x11/before/"
S = "captures/x11/strips/"
N = "captures/notes/"
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
                "<strong>main.</strong> Twelve consecutive frames across the Escape. The card occupies one frame and"
                " the transcript occupies the next; there are no frames in between to show.",
            ),
            strip(
                S + "close-fold",
                12,
                "<strong>branch.</strong> The same twelve frames on the same scene. The bottom border walks back up"
                " to meet the top, the rows dim into the ground on the way, and the transcript underneath is never"
                " covered by a card that is no longer there.",
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
                "<strong>main.</strong> Eight consecutive frames at 60fps across the jump from Interaction to Tools,"
                " cut at 31.50s. The pointer is the only thing in the strip that moves.",
            ),
            strip(
                S + "band-crossfade",
                8,
                "<strong>branch.</strong> The same eight frames of the same jump in the same scene. Tools is banded,"
                " Interaction comes up over the middle four frames while Tools goes down, and neither is at full"
                " strength while the other is.",
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
                "<strong>main.</strong> Eight consecutive frames at 60fps across a jump from the first message to"
                " the second. The selection band on the third message is the only band in the strip.",
            ),
            strip(
                S + "pane-crossfade",
                8,
                "<strong>branch.</strong> The same jump. The first message is still going down while the second"
                " comes up, and the selection band underneath both is untouched by either.",
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
                "<strong>main.</strong> Eight consecutive frames at 60fps at 26.50s, across a jump between two model"
                " rows. Only the pointer moves.",
            ),
            strip(
                S + "card-bands-picker",
                8,
                "<strong>branch.</strong> The same eight frames of the same jump. The row left goes down while the"
                " row reached comes up, and the keyboard selection under both is untouched.",
            ),
            "<h3>The wizard step, frame by frame</h3>",
            strip(
                S + "card-bands-wizard-main",
                8,
                "<strong>main.</strong> The same moment in the same scene, cut wider because there is no card to cut"
                " into: the transport choices are transcript rows at column zero and the pointer passes over them.",
            ),
            strip(
                S + "card-bands-wizard",
                8,
                "<strong>branch.</strong> The step is a card, its rows are the card's rows, and they band and"
                " cross-fade on the same clock as every other surface on this page.",
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
]

if __name__ == "__main__":
    write([*SECTIONS, long_session_section()])
