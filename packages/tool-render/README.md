# @veyyon/tool-render

React components that draw one tool call. Two surfaces render the same transcript and both
get their tool cards from here:

- `packages/coding-agent` HTML session export, through the `<vey-tool-view>` web component
- `packages/collab-web` live transcript

One tool, one renderer, one place. A card that looks right in an export and wrong in a live
session is the failure this package exists to prevent, so `registry.ts`, `tools/`,
`parts.tsx`, `util.ts` and `ToolView.tsx` are never forked into a consumer. Only the host
shells (`element.tsx`, `standalone.tsx`) live outside, because each host mounts React
differently.

## Writing a renderer

A renderer is two components:

```tsx
export const myToolRenderer: ToolRenderer = {
	Summary: ({ args }) => <PathText path={str(args.path) ?? ""} />,
	Body: ({ result }) => <ResultText result={result} />,
};
```

`Summary` is the one-line header the chrome truncates, so it must not render block
elements. `Body` is the expanded detail view and is optional: omit it when the summary
already says everything.

Register the renderer in `RENDERERS` in `registry.ts` under its wire tool name. Lookups go
through `resolveToolRenderer(name)`, which uses `Object.hasOwn` rather than plain property
access, because a tool name arriving over the wire is model-controlled and `constructor`
must not resolve to something. An unregistered name falls back to `genericRenderer`, which
prints the JSON, so a new tool renders readably before anyone writes a card for it.

## Aliases

Several keys point at one renderer, which is how a transcript recorded under an older tool
name stays readable: `puppeteer` renders as `browser`, `apply_patch` as `edit`, `find` as
`glob`, `search` as `grep`, and `js`, `python` and `notebook` all as `eval`. The `job`
renderer additionally answers to `await`, `poll` and `cancel_job`. Keep an alias when you
rename a tool; deleting one silently degrades every old session to the generic renderer.

## Constraints a renderer must respect

- **Host-agnostic.** No imports of `node:*`, of the coding-agent runtime, or of anything
  host-specific. The same bundle runs in a browser tab and inside an exported HTML file.
- **Hostile input.** `args` and `details` arrive as plain JSON that a model produced and a
  transcript may have truncated. Both may be partial or the wrong shape. The helpers in
  `util.ts` (`str`, `num`, `isRecord`, `detailsRecord`) exist so a renderer narrows rather
  than asserts, and `InvalidArg` from `parts.tsx` is the honest thing to render when it
  cannot.
- **Live calls.** `running` is true while the tool is still executing in a collab session,
  so a renderer that assumes `result` exists breaks the live view while looking fine in an
  export.
- **Host capabilities are optional.** `host.hasAgent` and `host.openAgent` let a `task`
  card drill into a subagent transcript. They are functions, so they cannot travel through
  the JSON `payload` attribute, and a host that does not offer them omits them. Check
  before calling.

## What `parts.tsx` and `util.ts` are for

`parts.tsx` holds the shared vocabulary every card draws with: `Badge`/`Badges`,
`PathText`, `Kv`/`KvGrid`/`Row`, `Output`, `CodeBlock`, `DiffBlock`, `ResultText`,
`ResultImages`, `Note`, `InvalidArg`, `AgentLink`. `util.ts` holds the narrowing and
formatting helpers, including `shortenPath`, `replaceTabs`, `truncate`, `languageFromPath`
and `argsDigest`. Reach for these before writing local markup: they are what makes an
unfamiliar tool card look like the others.

Styling lives in one stylesheet, `src/tool-render.css`, which `ToolView.tsx` imports
directly; it is also published as `@veyyon/tool-render/tool-render.css` for a host that
bundles CSS itself. Its `--tv-*` tokens fall back to the host palette variables, so a card
picks up the surrounding theme rather than carrying its own colors. Renderers use the `tv-`
class names and add no inline styles, which is what lets a theme change land in both
surfaces at once.
