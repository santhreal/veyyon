#!/usr/bin/env python3
"""Build a contact sheet of every committed still in assets/.

The page enumerates the filesystem at run time rather than carrying a list of
names. A hand-written list is how a gallery ends up pointing at a picture that
was deleted months ago, and the whole point of this page is that every figure on
it is a file that exists right now.

Frames are shown at their natural size. A composited terminal frame downscaled
into a thumbnail grid answers nothing about the thing it is evidence for: the
glyph edges, the card fills and the chrome are the content, and they are the
first thing a thumbnail destroys.

Grey and black render proofs are paired onto one row on purpose. An explicit
dark fill is invisible on a black ground and reads as a slab on a grey one, so
the pair side by side is the comparison the proof exists to make; separated,
each half is half an answer.

Run:
    python3 proof/build-pics.py
"""

import html
import os
import struct
import sys

from PIL import Image, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
OUT = os.path.join(ROOT, "proof", "pics.html")

# Ordered: the first pattern that matches a name owns the frame, so the take-7
# sequence claims its frames before the generic settings rule can.
SECTIONS = [
    (
        "The take",
        "Eighteen frames from one unbroken 19-minute session, in the order the "
        "session produced them. Each is a full-resolution composite off the "
        "recorder, not a crop of a video frame.",
        lambda n: n.startswith("demo-hd-"),
        "demo-hd.sh",
    ),
    (
        "A fourteen-task plan, closed out",
        "A second session, recorded after the todo board was rebuilt: fourteen "
        "tasks across five phases written in one call, then closed one call at a "
        "time. Thirteen frames, in the order the walk reached them.",
        lambda n: n.startswith("todo-marathon-"),
        "todo-marathon.sh",
    ),
    (
        "Surfaces the take does not reach",
        "Panes that need a state the single session never enters, captured from "
        "the same scene machinery.",
        lambda n: n.startswith("stills-extra-") or n.startswith("prompt-architecture-"),
        None,
    ),
    (
        "Rebuilt surfaces, before and after",
        "One surface recorded twice, on the tree without the rebuild and on the "
        "tree with it. The same scene at the same width and the same second of "
        "the same script, so the only difference on the row is the change.",
        lambda n: n.endswith(("-before", "-after")),
        None,
    ),
    (
        "Settings differentials",
        "One knob, off and on. A single screenshot of a default proves the "
        "setting was declared, not that it reaches behaviour.",
        lambda n: n.endswith(("-off", "-on")) or "settings" in n or n.startswith("accounts-"),
        None,
    ),
    (
        "Render proofs",
        "The real component rendered off-screen onto both grounds.",
        lambda n: n.endswith(("-grey", "-black")),
        None,
    ),
]


def scene_shots(scene):
    """Shot names in the order a scene fires them, read from the scene itself.

    This was a hardcoded list of eighteen surfaces that happened to agree with
    proof/scenes/demo-hd.sh exactly. A second recorded band would have meant a
    second copy, and a shot added to either scene sorts alphabetically into the
    middle of the session until someone reads the page closely enough to notice.
    """
    order = []
    with open(os.path.join(ROOT, "proof", "scenes", scene), encoding="utf8") as fh:
        for line in fh:
            fields = line.split()
            if len(fields) == 2 and fields[0] == "shot":
                order.append(fields[1])
    if not order:
        raise SystemExit(f"error: proof/scenes/{scene} fires no shots")
    return order


def png_size(path):
    """Width and height from the IHDR chunk, without an image library."""
    with open(path, "rb") as fh:
        head = fh.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", head[16:24])


# A frame with no glyphs on it is not evidence of anything, and the scenes leave
# a few behind: prompt-architecture-shell is a bare terminal holding one cursor.
# Contrast cannot separate it, because a dark settings pane is legitimately flat
# and scores lower. Glyph strokes are a LOCAL signal, so what is measured is the
# density of one-pixel steps, and it separates cleanly in both directions: the
# empty shell sits at 0.089%, the sparsest real frame (the splash, which carries
# a logo, a version line and a tip) at 0.749%, and everything else above 1.0%.
# The floor is 8.4x below the sparsest thing worth showing and 3.4x above the
# thing being excluded.
EDGE_FLOOR = 0.003


def edge_density(path):
    """Fraction of adjacent-pixel steps large enough to be a glyph edge."""
    grey = Image.open(path).convert("L")
    width, height = grey.size
    total = 0.0
    for a, b in (
        (grey.crop((1, 0, width, height)), grey.crop((0, 0, width - 1, height))),
        (grey.crop((0, 1, width, height)), grey.crop((0, 0, width, height - 1))),
    ):
        hist = ImageChops.difference(a, b).histogram()
        total += sum(hist[25:]) / max(sum(hist), 1)
    return total / 2


def collect():
    tracked = set(
        os.popen("git -C %s ls-files assets" % ROOT).read().split()
    )
    found = []
    for dirpath, _dirs, files in os.walk(ASSETS):
        for name in sorted(files):
            if not name.endswith(".png"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, ROOT)
            found.append((rel, name[:-4], os.path.getsize(full), png_size(full),
                          rel in tracked, edge_density(full)))
    return found


def scene_key(scene):
    """Order a band's frames the way its scene shot them, unknown names last.

    A scene's frames are named after the scene, so the filename carries both the
    prefix to strip and the shot list to sort by: demo-hd.sh -> demo-hd-idle.
    """
    prefix = scene[: -len(".sh")] + "-"
    order = scene_shots(scene)

    def key(entry):
        surface = entry[1][len(prefix):]
        return (order.index(surface) if surface in order else len(order), surface)

    return key


# Suffix pairs that belong on one row, in the order they should be read. A
# comparison split across two rows is half an answer: the dark fill that reads
# as a slab on grey and vanishes on black is the same class of finding as a
# header that lost its count, and both are only visible side by side.
PAIR_SUFFIXES = (("-grey", "-black"), ("-before", "-after"))


def pair_up(entries):
    """Fold paired siblings into one row, leaving everything else alone.

    Pairs on the base stem rather than on whichever suffix arrives first. A
    directory listing sorts -black ahead of -grey, so keying off the grey half
    emitted every black frame twice: once alone, once inside its pair.
    """
    by_stem = {entry[1]: entry for entry in entries}
    rows, emitted = [], set()
    for entry in entries:
        stem = entry[1]
        for left, right in PAIR_SUFFIXES:
            if stem.endswith(left):
                base = stem[: -len(left)]
                break
            if stem.endswith(right):
                base = stem[: -len(right)]
                break
        else:
            rows.append((stem, [entry]))
            continue
        if base in emitted:
            continue
        pair = [e for e in (by_stem.get(base + left), by_stem.get(base + right)) if e]
        emitted.add(base)
        rows.append((base, pair))
    return rows


def figure(entry):
    rel, stem, size, dims, tracked, _density = entry
    shape = f"{dims[0]}&times;{dims[1]}" if dims else "unreadable header"
    tag = "" if tracked else '<span class="u">regenerated, untracked</span>'
    return (
        f'<figure><img loading="lazy" src="../{html.escape(rel)}" alt="{html.escape(stem)}">'
        f'<figcaption><span class="n">{html.escape(stem)}</span>'
        f'<span class="m">{shape} &middot; {size:,} bytes</span>{tag}</figcaption></figure>'
    )


def main():
    every = collect()
    if not every:
        print("error: no PNGs under assets/", file=sys.stderr)
        return 1
    found = [e for e in every if e[5] >= EDGE_FLOOR]
    empty = [e for e in every if e[5] < EDGE_FLOOR]

    buckets = {title: [] for title, _blurb, _match, _scene in SECTIONS}
    other = []
    for entry in found:
        for title, _blurb, match, _scene in SECTIONS:
            if match(entry[1]):
                buckets[title].append(entry)
                break
        else:
            other.append(entry)
    for title, _blurb, _match, scene in SECTIONS:
        if scene:
            buckets[title].sort(key=scene_key(scene))

    parts = [
        "<!doctype html><meta charset=utf-8>",
        "<title>Veyyon &mdash; the actual pictures</title>",
        "<style>",
        "body{margin:0 auto;max-width:1960px;padding:48px 40px 96px;",
        "background:#15171c;color:#c6cbd4;",
        "font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}",
        "h1{font-size:22px;font-weight:600;color:#f0f2f6;margin:0 0 6px}",
        "h2{font-size:16px;font-weight:600;color:#f0862e;margin:56px 0 4px;",
        "padding-top:20px;border-top:1px solid #262a33}",
        "p{max-width:74ch;color:#8b93a1;margin:0 0 18px}",
        ".count{color:#5c6472}",
        "figure{margin:0 0 34px}",
        "img{display:block;max-width:100%;height:auto;border:1px solid #262a33;border-radius:6px}",
        "figcaption{display:flex;gap:14px;align-items:baseline;padding:8px 2px 0}",
        ".n{color:#c6cbd4}.m{color:#5c6472;font-size:13px}",
        ".u{color:#f0862e;font-size:13px}",
        ".pair{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 34px}",
        ".pair figure{margin:0;flex:1 1 460px}",
        "</style>",
        "<h1>The actual pictures</h1>",
        f'<p>Every PNG under <code>assets/</code>: '
        f'<span class="count">{len(found)} files, '
        f'{sum(e[2] for e in found):,} bytes</span>, of which '
        f'{sum(1 for e in found if e[4])} are committed and '
        f'{sum(1 for e in found if not e[4])} are rewritten by every take and left '
        f'untracked on purpose. Enumerated from disk when this page was built, so '
        f"nothing here points at a file that is gone.</p>",
    ]

    for title, blurb, _match, _scene in SECTIONS:
        entries = buckets[title]
        if not entries:
            continue
        parts.append(f"<h2>{html.escape(title)} "
                     f'<span class="count">&mdash; {len(entries)}</span></h2>')
        parts.append(f"<p>{html.escape(blurb)}</p>")
        for _stem, row in pair_up(entries):
            if len(row) == 2:
                parts.append('<div class="pair">' + "".join(figure(e) for e in row) + "</div>")
            else:
                parts.append(figure(row[0]))

    if other:
        parts.append(f'<h2>Everything else <span class="count">&mdash; {len(other)}</span></h2>')
        parts.append("<p>Frames no section claimed.</p>")
        for entry in other:
            parts.append(figure(entry))

    # Every file found must appear exactly once. Sorting puts -black ahead of
    # -grey, which once emitted seventeen frames twice while the per-section
    # counts below still summed to the right total, so the page is counted by
    # what it actually contains rather than by what was enumerated.
    body = "\n".join(parts)
    shown = body.count("<img ")
    if shown != len(found):
        print(f"error: {len(found)} files found but {shown} figures emitted",
              file=sys.stderr)
        return 1

    with open(OUT, "w", encoding="utf8") as fh:
        fh.write(body + "\n")

    print(f"wrote {os.path.relpath(OUT, ROOT)}: {os.path.getsize(OUT):,} bytes, {shown} figures")
    for title, _blurb, _match, _scene in SECTIONS:
        print(f"  {len(buckets[title]):>3}  {title}")
    print(f"  {len(other):>3}  unclaimed")
    for entry in empty:
        print(f"  held back, no glyphs on it ({entry[5]*100:.3f}%): {entry[0]}")
    return 0


raise SystemExit(main())
