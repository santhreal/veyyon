#!/usr/bin/env python3
"""Assemble proof/ui-polish-proof.html from the captures on disk.

Every figure names a file under proof/. A missing file is an error, not a
skipped row, so the page can never ship a broken reference.
"""
from __future__ import annotations

import html
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent

CSS = """
:root { color-scheme: dark; }
body { margin: 0 auto; padding: 40px 32px 96px; max-width: 1520px; background: #14161b; color: #d8dce4;
  font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 56px 0 4px; border-top: 1px solid #2a2f39; padding-top: 24px; }
h3 { font-size: 14px; margin: 24px 0 8px; color: #9aa3b2; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
p { margin: 8px 0; max-width: 105ch; }
.lede { color: #9aa3b2; }
code { font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace; background: #1d2129; padding: 1px 5px; border-radius: 4px; }
figure { margin: 0 0 20px; }
figcaption { margin: 6px 0 0; color: #8b93a3; font-size: 13px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
.pair img, .single img { width: 100%; display: block; border: 1px solid #2a2f39; border-radius: 6px; }
.tag { display: inline-block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; margin-bottom: 6px; }
.before { background: #3a2224; color: #ffb4ae; }
.after { background: #1d3326; color: #9fe0b0; }
.hover { background: #2a2740; color: #c7bcff; }
.motion { background: #23303a; color: #8fd0e8; }
table { border-collapse: collapse; margin-top: 12px; font-size: 13px; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #262b34; vertical-align: top; }
th { color: #9aa3b2; font-weight: 600; }
td.sha { font-family: ui-monospace, Menlo, monospace; color: #e0a05a; white-space: nowrap; }
td.ev { font-family: ui-monospace, Menlo, monospace; color: #8b93a3; font-size: 12px; }
.note { background: #1a1e26; border-left: 3px solid #e0a05a; padding: 12px 16px; margin: 20px 0; }
"""

missing: list[str] = []


def img(rel: str, tag: str, caption: str) -> str:
    if not (ROOT / rel).exists():
        missing.append(rel)
    label = {"before": "on main", "after": "on this branch", "hover": "pointer", "motion": "motion"}[tag]
    return (
        f'<figure><span class="tag {tag}">{label}</span>'
        f'<img src="{html.escape(rel)}" alt="{html.escape(caption)}" />'
        f"<figcaption>{caption}</figcaption></figure>"
    )


def pair(before: str, after: str, cap_before: str, cap_after: str) -> str:
    return (
        '<div class="pair">'
        + img(before, "before", cap_before)
        + img(after, "after", cap_after)
        + "</div>"
    )


def single(rel: str, tag: str, caption: str) -> str:
    return '<div class="single">' + img(rel, tag, caption) + "</div>"


def commit_rows(evidence: dict[str, str]) -> str:
    log = subprocess.run(
        ["git", "log", "--reverse", "--format=%h\t%s", "main..HEAD"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout.strip().split("\n")
    rows = []
    for line in log:
        sha, subject = line.split("\t", 1)
        ev = evidence.get(sha, "")
        rows.append(
            f'<tr><td class="sha">{sha}</td><td>{html.escape(subject)}</td>'
            f'<td class="ev">{html.escape(ev)}</td></tr>'
        )
    return "\n".join(rows)


def build(sections: list[str], evidence: dict[str, str], head: str, base: str, ahead: int) -> str:
    body = "\n".join(sections)
    table = commit_rows(evidence)
    return f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>feat/ui-polish — visual proof</title><style>{CSS}</style></head>
<body>
<h1>feat/ui-polish — visual proof</h1>
<p class="lede">Branch <code>feat/ui-polish</code> at <code>{head}</code>, {ahead} commits ahead of
<code>main</code> (<code>{base}</code>). The captures below are real terminal frames: the shipped CLI running
under <a href="https://github.com/charmbracelet/vhs">vhs</a> in a container, driven by a local
<code>llama.cpp</code> server. Nothing is a mock-up and nothing is a tmux dump.</p>

<div class="note">
<p><strong>How a capture is taken.</strong> <code>proof/docker/record.sh &lt;tape&gt;</code> runs
<code>veyyon-proof-recorder</code> on a private docker network: the repo is bound read-write at <code>/repo</code>,
<code>HOME</code> is a tmpfs seeded from <code>proof/docker/home-seed</code>, and vhs types into a real ttyd
terminal at 1500x900. The machine's own <code>~/.veyyon</code> is not in the container's mount table and no
provider account is reachable from it.</p>
<p><strong>Which model answers.</strong> A <code>llama.cpp</code> server holding
<code>qwen2.5-1.5b-instruct-q4_k_m</code>, reachable only on the container network as the custom provider
<code>local</code>. Every model turn in these frames is that model, on CPU, which is why the recordings wait
minutes for one answer.</p>
<p><strong>How "before" is taken.</strong> <code>proof/docker/record-before.sh</code> holds every source file the
branch changed at its <code>main</code> content (<code>git show main:&lt;file&gt;</code>), writes back the three
files the branch deleted, records the same tapes into <code>proof/captures/real/before/</code>, then restores from
an in-memory copy and proves the restore by sha256. No git mutation command runs and the working tree ends
byte-identical.</p>
<p><strong>Pointer proofs are not terminal frames.</strong> vhs cannot move a mouse, so hover evidence comes from
injecting a real SGR motion report into the component's own input path and rasterizing the frame it paints.
Those figures are marked as such.</p>
</div>

{body}

<h2>Every commit on the branch, and what shows it</h2>
<table><thead><tr><th>commit</th><th>subject</th><th>evidence</th></tr></thead>
<tbody>
{table}
</tbody></table>
</body></html>
"""


def write(sections: list[str], evidence: dict[str, str]) -> None:
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO,
                          capture_output=True, text=True, check=True).stdout.strip()
    base = subprocess.run(["git", "rev-parse", "--short", "main"], cwd=REPO,
                          capture_output=True, text=True, check=True).stdout.strip()
    ahead = int(subprocess.run(["git", "rev-list", "--count", "main..HEAD"], cwd=REPO,
                               capture_output=True, text=True, check=True).stdout.strip())
    out = ROOT / "ui-polish-proof.html"
    out.write_text(build(sections, evidence, head, base, ahead), encoding="utf-8")
    if missing:
        print("MISSING IMAGES:", *sorted(set(missing)), sep="\n  ", file=sys.stderr)
        raise SystemExit(1)
    print("wrote", out)


R = "captures/real/"
B = "captures/real/before/"
C = "captures/"

SECTIONS = [
    """<h2>1. First run: the wizard footer is a row of chips</h2>
<p>A fresh HOME lands in the setup wizard. The footer used to be a dim sentence of key names; it is now the
house chip row a pointer can hit, laid out by <code>layoutShortcutRows</code>, the same function the modal
footers use.</p>"""
    + pair(B + "wizard-providers.png", R + "wizard-providers.png",
           "main: every footer key dim, in one sentence of a line",
           "branch: each key a chip, bold on the accent, dot-separated")
    + pair(B + "wizard-approvals.png", R + "wizard-approvals.png",
           "main: step 2, approvals", "branch: step 2, approvals")
    + """<h3>Pointer, rasterized</h3>
<p>vhs cannot move a mouse. The hover state comes from injecting a real SGR motion report into the wizard's own
input path and rasterizing the frame it paints.</p>"""
    + pair(C + "wizard-footer-before-grey.png", C + "wizard-footer-after-grey.png",
           "main: dim sentence", "branch: chips")
    + single(C + "wizard-footer-hover-grey.png", "hover", "a chip under the pointer takes the selection wash"),

    """<h2>2. The transcript sits on one rail</h2>
<p>Every block that owns a turn now opens at the composer's rail inset and nothing draws a rule across the
viewport. The frames below are one real turn from the local model.</p>"""
    + pair(B + "transcript-answer.png", R + "transcript-answer.png",
           "main: answer prose in the terminal default, blocks at column zero",
           "branch: themed prose, every row on the rail")
    + """<h3>The /btw block</h3>"""
    + pair(B + "transcript-btw.png", R + "transcript-btw.png",
           "main: a full-width dim rule above and below the block",
           "branch: the block sits on the rail with no rules at all")
    + """<h3>Every block type at once, rasterized</h3>
<p>One renderer stacks the prompt gutter, prose, <code>/btw</code>, <code>/omfg</code>, a command answer, the
tiny-model download, the batch ledger and the error banner through the real
<code>UiHelpers.addMessageToChat</code>. Eight full-width rules and 54 rows become none and 33.</p>"""
    + pair(C + "transcript-blocks-before-grey.png", C + "transcript-blocks-after-grey.png",
           "main: 8 rules, 54 rows", "branch: 0 rules, 33 rows")
    + pair(C + "transcript-dividers-before-grey.png", C + "transcript-dividers-after-grey.png",
           "main: a divider spans the viewport", "branch: a divider is a short mark on the rail"),

    """<h2>3. The MCP add-server wizard is a card</h2>
<p><code>/mcp add</code> used to be a pair of dim rules with the step text between them. It is a ModalShell card:
title on the top rule, <code>[x]</code> close glyph, chips in the footer, and it answers the pointer.</p>"""
    + pair(B + "overlay-mcp.png", R + "overlay-mcp.png",
           "main: DynamicBorder sandwich", "branch: ModalShell card"),

    """<h2>4. The session tree is a card</h2>
<p><code>/tree</code> was keyboard-only inside the same dim-rule chrome.</p>"""
    + pair(B + "overlay-tree.png", R + "overlay-tree.png",
           "main: DynamicBorder sandwich", "branch: ModalShell card"),

    """<h2>5. Settings: the Subagents tab is about subagents</h2>
<p>The tab used to open on unrelated rows with the spawn ceiling parked in another group. It opens on the
subagent roster, and the ceiling sits directly under it.</p>"""
    + pair(B + "settings-subagents.png", R + "settings-subagents.png",
           "main: the old tab contents", "branch: Subagent Roster, then Max Nested Spawn Depth")
    + pair(C + "settings-subagents-before-grey.png", C + "settings-subagents-after-grey.png",
           "main, rasterized", "branch, rasterized"),

    """<h2>6. The plugins tab names its keys as chips</h2>
<p>The container has no plugin installed, so the row list is empty in both frames and the footer is the whole
visible difference: the tab named its keys in the settings screen's generic footer, and now names its own. The
pointer half of that commit is covered by its suite, not by this frame.</p>"""
    + pair(B + "settings-plugins.png", R + "settings-plugins.png",
           "main: enter change · / search · esc close",
           "branch: enter configure · esc close"),

    """<h2>7. The login screen is a card</h2>"""
    + pair(B + "overlay-login-list.png", R + "overlay-login-list.png",
           "main: DynamicBorder sandwich around the provider list",
           "branch: ModalShell card"),

    """<h2>8. A click resumes the pause screen</h2>
<p>The resume hint used to list keys only. It names the click, and a click resumes.</p>"""
    + pair(B + "overlay-pause.png", R + "overlay-pause.png",
           "main: esc · enter · space", "branch: esc · enter · space · click"),

    """<h2>9. The hook selector, rasterized</h2>
<p>An extension hook cannot be provoked from a recorded terminal without an extension, so this surface is proved
by constructing the shipped component and rasterizing what it paints.</p>"""
    + pair(C + "hook-selector-before-grey.png", C + "hook-selector-after-grey.png",
           "main: dim rules, no chips", "branch: card, chips, countdown")
    + single(C + "hook-selector-hover-grey.png", "hover", "a row under the pointer takes the hover band"),

    """<h2>10. The recordings</h2>
<p>Each GIF is the whole tape the screenshots above were cut from.</p>
<div class="pair">
<figure><span class="tag motion">recording</span><img src="captures/real/transcript.gif" alt="a real turn" />
<figcaption>a real turn from the local model, then <code>/btw</code></figcaption></figure>
<figure><span class="tag motion">recording</span><img src="captures/real/settings-subagents.gif" alt="settings" />
<figcaption>opening settings and walking to the Subagents tab</figcaption></figure>
<figure><span class="tag motion">recording</span><img src="captures/real/mcp.gif" alt="mcp wizard" />
<figcaption><code>/mcp add</code></figcaption></figure>
<figure><span class="tag motion">recording</span><img src="captures/real/pause.gif" alt="pause screen" />
<figcaption><code>/pause</code></figcaption></figure>
<figure><span class="tag motion">recording</span><img src="captures/real/wizard.gif" alt="setup wizard" />
<figcaption>the setup wizard, first run</figcaption></figure>
<figure><span class="tag motion">recording</span><img src="captures/real/tree.gif" alt="session tree" />
<figcaption>one turn, then <code>/tree</code></figcaption></figure>
</div>""",

    """<h2>What these captures do not cover</h2>
<ul>
<li>Hover and click are keyboard-invisible: vhs types, it does not point. Every pointer claim on the branch is
proved by a test that injects a real SGR report, and three of them are rasterized above.</li>
<li>The agent transcript viewer and the drill-in card need a subagent run. A 1.5B model does not drive one
reliably, so those two are covered by their suites only.</li>
<li><code>c511ae76b</code> (a virtualized root compacting used to blank the transcript) reproduces from a
resize, not from a keystroke, and is covered by its regression suite.</li>
<li><code>4d566d927</code> is a provider fix with no surface.</li>
<li>The model answering in these frames is a 1.5B running on CPU. It is there to make the transcript real, not
to be right.</li>
</ul>""",
]

EVIDENCE = {
    "766ee5a26": "duplicate of main, no surface",
    "8981629d1": "merge",
    "b6a6bd07b": "every-settings-submenu-answers-the-pointer.test.ts",
    "d0226c921": "selector-overlays-answer-the-pointer.test.ts",
    "aa2d62dc7": "§2 answer prose colour",
    "b852f2543": "§2 ledger marker, rasterized stack",
    "08ade60cb": "selector-overlays-answer-the-pointer.test.ts",
    "c18816b62": "selector-overlays-answer-the-pointer.test.ts",
    "0c36cf201": "selector-overlays-answer-the-pointer.test.ts",
    "b373c7c55": "a-clicked-composer-chip-runs-its-action.test.ts",
    "d4d2a4290": "§7 login card",
    "ab7f1b8be": "the-transcript-card-answers-the-pointer.test.ts",
    "4d566d927": "a-chatgpt-oauth-session-compacts-on-the-codex-backend.test.ts",
    "5afa7ff34": "the-transcript-card-answers-the-pointer.test.ts",
    "4ed3a44b4": "§4 session tree",
    "1f2ea74b3": "§3 MCP wizard",
    "c511ae76b": "a-virtualized-transcript-never-loses-history-to-a-rebuild.test.ts",
    "3f583d196": "§9 hook selector",
    "929469b5f": "§9 hook trio, same chrome",
    "36df196c3": "§6 plugins tab",
    "489fd453f": "a-click-on-a-suggestion-accepts-the-completion.test.ts",
    "7e1aa54cb": "§2 /btw block",
    "b02f7dc2d": "§2 command blocks on the rail",
    "f9160c99c": "§2 no full-width rule",
    "9be29f814": "every-settings-submenu-answers-the-pointer.test.ts",
    "07372af28": "§8 pause screen",
    "e86818539": "§5 subagents tab",
    "db946f360": "a-click-in-the-composer-places-the-caret.test.ts",
    "253111668": "§1 wizard chips",
    "08ec85de5": "§1 pointer render",
    "bc9e33085": "§2 dividers",
    "23504cc4d": "§2 dividers",
    "bfc3ed7b5": "§2 tiny-model download",
    "73b3a350f": "§2 cut-short marker",
    "d12a2639f": "the renderers behind §1, §2, §9",
    "7ef968fa2": "the cache-miss glyph in §2",
    "907edbc2b": "the recorder behind every real frame",
}

if __name__ == "__main__":
    write(SECTIONS, EVIDENCE)
