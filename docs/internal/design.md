# Veyyon — Design & Brand

The identity contract for everything that ships under the Veyyon name: naming,
voice, wordmark, type, color, and the sun motif — across the CLI, TUI, website,
packages, and docs. This is the source of truth. If a surface disagrees with
this doc, the surface is wrong. For color tokens specifically,
`website/site.css` `:root` is the canonical machine-readable source; the
titanium theme mirrors it, and `test/brand-conformance.test.ts` fails any drift
between the two.

## Product identity

| Item | Value |
| --- | --- |
| Product name | **Veyyon** (only name — not "Veyyon Code") |
| Primary command | `veyyon` |
| Short alias | `vey` |
| npm scope | `@veyyon/*` (e.g. `@veyyon/pi-coding-agent`) |
| Config home | `~/.veyyon` (`VEYYON_CONFIG_DIR` / legacy `OMP_CONFIG_DIR` / `PI_CONFIG_DIR`) |
| Profile env | `VEYYON_PROFILE` (also accepts legacy `OMP_PROFILE` / `PI_PROFILE`) |

Veyyon forks [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT):
TypeScript/Bun agent loop and TUI, Rust natives for hot paths (grep, PTY,
hashline). Upstream provenance is license and history — not a tagline to paste
into Veyyon UI or docs. Legal provenance: `LICENSE`, `NOTICE`, `UPSTREAM.md`,
[Acknowledgements](../handbook/src/acknowledgements.md). OpenAI-compatible wire
formats are protocol facts, not product branding.

## The name

**veyyon** comes from the Tamil வெய்யோன் (*veyyōn*), "the sun." The identity
leans into that meaning literally: a rising sun, rendered in the terminal's own
material. Everything below serves that idea — an austere instrument with one
warm signature.

## Voice

Exact, restrained, technical. Name the product **Veyyon**. Prefer short factual
sentences. No inherited slogans ("IDE wired in"), no second product name for
the CLI, no mascot language, no unbacked capability claims. Features marked
`> **Spec — not shipped:**` are target design, not current behavior.

## Wordmark

- Always lowercase: **`veyyon`**. Never `VEYYON`, never `Veyyon` — except at
  the start of a prose sentence, where normal capitalization applies.
- Set in JetBrains Mono. No separate display face — the wordmark is the primary
  typeface at a larger size.
- No mark, monogram, or symbol beside it. It stands alone.

## Type

- **JetBrains Mono is the primary typeface, always.** It carries the wordmark,
  headings, UI chrome, code, and terminal output. This is a terminal-native
  product; the type should read that way everywhere.
- **Inter** is a secondary reading face, used only for long body paragraphs on
  the marketing site where sustained reading in monospace would tire the eye.
  It never appears in the wordmark, headings, or product UI.

## Color

Silver on black. Sharp edges. No gradients, no glow, no rounded corners.

| Role | Token | Hex | Notes |
|------|-------|-----|-------|
| Ground | `--bg` | `#000000` | Pitch black. The only background. |
| Silver (primary) | `--silver` / `--silver-hi` | `#c6cbd4` / `#e6e9ee` | Structure. Carries ~everything on screen. |
| Text | `--fg` / `--fg-2` | `#f6f7f9` / `#b4bac4` | Body and emphasis. |
| Muted / dim | `--muted` / `--dim` | `#7c828d` / `#4a505a` | Secondary labels, captions, tree lines. |
| **Sun (accent)** | `--sun` / `--sun-hi` | `#f0862e` / `#fb9e44` | The one brand accent. Ember. Used sparingly. |
| Success | `--green` | `#7fb98a` | Semantic only. |
| Warning | `--amber` | `#c9a24b` | Semantic only. |
| Error | `--red` | `#c96f6e` | Semantic only. |

**Every background is pure black `#000000`.** Hierarchy comes from silver
hairlines, text weight, and the ember accent — not raised panels or tinted
fills. The only permitted non-black surface is the ember selection glow
(`#241510`).

### Shipped themes

| Theme | Role | Ground | Structure | Accent |
| --- | --- | --- | --- | --- |
| `titanium` | **Default dark.** Mirrors `website/site.css` tokens exactly | `#000000` | Silver `#C6CBD4` / bright `#E6E9EE` | Ember `#F0862E` (links, accent border, bullets, selection glow) |
| `light` | **Default light.** Titanium's strict inverse (below) | `#FFFFFF` | `#5C6470` / `#343B45` | Ember `#F0862E` chrome, `#B65E14` links |
| `dark` ("Veyyon Dark") | Alternative dark on the same rules | `#000000` | Silver `#B8BDC7` | Silver (no ember carry — known drift, tracked in `BACKLOG.md`) |

The ~90 other bundled themes are user options, not brand surfaces.

### Light ground (the one sanctioned inversion)

The brand is silver on black; light terminals still exist, so the TUI ships one
light theme defined strictly as titanium's inverse — never a new palette:

- **One ground.** Pure white (`#FFFFFF`) everywhere, exactly as black is the
  only dark background. No tinted or raised panels, no colored state
  backgrounds. The selection surface carries a pale ember glow (`#FBE9D9`),
  mirroring `#241510` on dark.
- **Silver stays the design**, flipped in luminance: structure `#5C6470`,
  emphasis `#343B45`, muted `#7C838E`. Still strictly neutral — no hue creeps
  in on the way down.
- **Ember stays the accent.** The true ember `#F0862E` keeps the non-text roles
  (accent border, caret, bullets); text-sized ember (links) deepens to
  `#B65E14` so it holds contrast on white. Same rarity rule as dark.
- **Semantic trio re-tuned for white:** green `#2E7D45`, amber `#8F6A14`, red
  `#B04E4E`. Meaning only, as ever.
- **Still no blue.**

`brand-conformance.test.ts` locks both grounds; a light-theme edit that
reintroduces a tinted panel or a hue-carrying "silver" fails there.

### The accent rule (read this)

**Silver is the design. The sun is a rare accent, never a primary.** The ember
appears only on live, interactive, or focal things — the prompt caret, links,
the focus ring, the sun itself. It is never a fill, never structural, never
co-equal with silver. If a screen looks right with no ember at all, ship it with
no ember.

There is **no blue** in the brand. An earlier iteration used a deep blue accent;
it was removed entirely because it carried no meaning. The sun does. Do not
reintroduce blue.

### Semantic colors are different from the accent

Green, amber, and red are **encouraged wherever they carry state** — success /
added, warning / modified / pending, error / deleted, pass / fail. Use them
freely for meaning. Never use them decoratively, and never use the ember accent
to signal status (that's what the semantic trio is for). Ember stays distinct
from the amber warning color.

## The sun

The hero mark is a **living sun**: a dense field of monospace cells — block and
shade glyphs (`· : ░ ▒ ▓ █`) — that shimmer and ripple like a nanoswarm.

- Warmth comes from **stepped ember bands plus per-cell ordered dither**, never a
  smooth gradient. It stays sharp and cell-native — "tech meets sun," not a
  glowing blob.
- It's alive: the core shimmers, ripples propagate outward, it reacts to the
  cursor (ripples follow the pointer, a click sends a flare), and it sits on a
  dithered daybreak horizon with a watery reflection below.
- It degrades to a single static frame under `prefers-reduced-motion`.
- Implementation: `website/sun.js`. The same field algorithm is the reference
  for the TUI splash when that lands.

## Symbols

No decorative glyphs. An earlier design put a rotating diamond (`◆`) beside the
wordmark and on every section eyebrow — it meant nothing and was removed.
Don't add ornamental symbols anywhere. Functional glyphs inside product UI (the
prompt `›`, tree branches `├─ └─`, status `✓`) are fine because they carry
meaning.

## Onboarding and installers

Fullscreen setup: Veyyon wordmark + silver progress. No secondary product name
and no upstream tagline under the mark. Install/upgrade copy uses **Veyyon**,
commands `veyyon` / `vey` only.

Session welcome is a single hero card (not a dual-column dashboard): wordmark,
one value line (`Hashline edits that land. Your keys.`), action rows with
right-aligned shortcuts, optional recent sessions. Settings is a width-capped
centered panel.

## Conventions

- **CLI:** the installed binary is `veyyon`; the short terminal alias to launch
  it is **`vey`** (e.g. `vey` in a repo, `vey config init-xdg`). Prefer `vey` in
  user-facing copy and examples.
- Example model ids use the `provider/model` form, e.g. `openai/gpt-5.6-sol`,
  `anthropic/claude-haiku-4-5`.

## Do / Don't

**Do:** silver on black · JetBrains Mono everywhere · lowercase `veyyon` · ember
only as a rare accent · semantic green/amber/red for state · sharp edges.

**Don't:** blue (removed) · smooth gradients · glow or drop shadow · rounded
corners · decorative symbols · uppercase or title-case wordmark · ember as a
fill or status color.

## Documentation contract

- Identity and palette: this page (tokens machine-locked via `website/site.css`
  `:root` + `test/brand-conformance.test.ts`).
- Engine behavior: handbook pages reconciled to shipped code.
- **Spec — not shipped**: target design until a release ships it.

## Related

- [TUI design language](./tui-design-language.md) — how these rules land in the TUI.
- [Themes and identity](../handbook/src/using/themes.md) — the user-facing theme docs.
- `docs/theme.md` — how the TUI theme system loads and resolves these colors.
- `website/site.css` — the web token definitions this doc governs.

*Verified against `11c84f4` on 2026-07-17.*
