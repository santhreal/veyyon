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
"""


def video(rel: str, caption: str, start: float | None = None) -> str:
    """A figure holding the recording itself.

    `start` is a media fragment, and it is what stops the poster frame being
    the black display the recorder had before the terminal painted anything.
    """
    need(rel)
    src = f"{rel}#t={start:g}" if start is not None else rel
    return (
        "<figure>"
        f'<video controls loop muted playsinline preload="metadata"><source src="{src}" type="video/mp4"></video>'
        f"<figcaption>{caption}</figcaption></figure>"
    )


def video_pair(before: str, after: str, cap_before: str, cap_after: str, start: float | None = None) -> str:
    need(before)
    need(after)
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


def commit_table() -> str:
    log = subprocess.run(
        ["git", "log", "--oneline", "--no-decorate", "main..HEAD"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout.strip().split("\n")
    rows = []
    for line in log:
        sha, _, subject = line.partition(" ")
        rows.append(f'<tr><td class="sha">{sha}</td><td>{subject}</td></tr>')
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
<code>:99</code>, <code>xterm</code> is the terminal, <code>xdotool</code> moves a real pointer and presses real
keys, and <code>ffmpeg</code> records the display continuously at 60fps. The machine's own
<code>~/.veyyon</code> is not in the container's mount table — <code>HOME</code> is a tmpfs seeded from
<code>proof/docker/home-seed</code> — so nothing here touches a live session, and the operator's own display is
never opened.</p>
<p><strong>Which model answers.</strong> A <code>llama.cpp</code> server holding
<code>qwen2.5-1.5b-instruct-q4_k_m</code>, reachable only as the container-network provider <code>local</code>.
No provider account is reachable from the container, so a streamed answer in these recordings is that model on
CPU or it is nothing.</p>
<p><strong>How the <em>main</em> arm is taken.</strong> <code>proof/docker/record-x11-before.sh</code> holds every
source file the branch changed at its <code>main</code> content (<code>git show main:&lt;file&gt;</code>), records
the same scene into <code>proof/captures/x11/before/</code>, then restores from an in-memory copy and proves the
restore by sha256. No git mutation command runs and the working tree ends byte-identical.</p>
<p><strong>Where the filmstrips come from.</strong> <code>proof/filmstrip.py</code> decodes consecutive frames out
of the recording. An animation of 220ms is thirteen frames at 60fps and a still taken from inside the scene
always lands after it, so the frames have to be cut from the video afterwards.</p>
</div>

{body}

<h2>Every commit on the branch</h2>
<table><thead><tr><th>commit</th><th>subject</th></tr></thead>
<tbody>
{commit_table()}
</tbody></table>
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
    out = ROOT / "ui-polish-proof.html"
    out.write_text(html, encoding="utf-8")
    print("wrote", out)


X = "captures/x11/"
XB = "captures/x11/before/"
S = "captures/x11/strips/"
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
        "The context gauge walks to its new reading, and now has one to walk to",
        [
            "<p>The footline gauge is eight cells and a percentage, both reporting room LEFT. It used to be written"
            " straight into the next frame: a turn that spent nine points of the window put the new number on screen"
            " with no travel, which says <em>it is 52 now</em> where the same number walking says <em>you just spent"
            " nine</em>. That is the whole reason a spend meter is on screen. It now settles on the shared clock, one"
            " value read three ways — the percentage, the eight-cell bar, and the heat the bar is coloured with — so"
            " the three can never disagree about where the value is.</p>",
            "<p>Recording it found the defect underneath. The scene mentions a 20KB file, which the session reads and"
            " sends; the gauge did not move at all, and the reason was not the animation. Nothing counted the"
            " message: a <code>@file</code> mention reaches the provider as a developer message wrapping every body"
            " it read, and a <code>$</code> cell as a user message wrapping its code and its output, and both roles"
            " fell through the token estimator's default arm at zero. The first attempt at this scene used a 50KB"
            " mention and the endpoint answered <code>400 request (40459 tokens) exceeds the available context size"
            " (32768 tokens)</code> while the footline still read <code>61% left</code>. So the <em>main</em> arm"
            " below is a measurement of two defects at once, and it is the honest one: main's reading is"
            " <code>61% left</code> in every frame of a 37-second take that sends a 5.8k-token file.</p>",
            video_pair(
                XB + "context-gauge.mp4",
                X + "context-gauge.mp4",
                "the file is read and sent, and the gauge never moves",
                "the reading walks from 61% to 50% and the bar drops a cell",
                start=17,
            ),
            strip(
                S + "context-gauge-main",
                8,
                "<strong>main.</strong> Eight frames at 60fps, one in four across the half second where the branch"
                " travels. The reading is <code>61% left</code> in all eight, and in all 2221 frames of the take:"
                " grouping every frame of the gauge region by its own pixels leaves 23 distinct states, 22 of them"
                " reading 61 and the twenty-third a stretch of 25 frames right after the submit where the footline is"
                " not on that row at all.",
            ),
            strip(
                S + "context-gauge",
                8,
                "<strong>branch.</strong> The same eight offsets of the same scene: 61, 60, 57, 56, 53, 51, 51, 50,"
                " and the bar giving up a cell in the middle of it. The travel runs 19.65s to 20.13s of the take —"
                " the spring's own settling time, not a duration the gauge picked.",
            ),
            "<p>What the interrupt does is a measurement too, not a claim. Escape at 25.72s retires the in-flight"
            " estimate and the reading stays at <code>50% left</code>: the file body is in the conversation now and"
            " keeps costing what it costs. The only thing that changes is the bar's tip, which stops pulsing because"
            " the turn is no longer live. Neither arm can cross a heat threshold on this endpoint — the hue steps at"
            " 50% USED, and 50% of the model card's declared 65536 is 32768, which is exactly the prompt"
            " <code>llama.cpp</code> refuses to serve for a model trained at 32768.</p>",
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
]

if __name__ == "__main__":
    write(SECTIONS)
