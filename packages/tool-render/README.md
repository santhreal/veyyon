# @veyyon/tool-render

Shared React components for rendering tool calls in transcripts. Consumed by:

- `packages/coding-agent` HTML session exports (`<vey-tool-view>` web component)
- `packages/collab-web` live web transcript

## Writing a renderer

A renderer lives in `src/tools/` and exports `Summary` and an optional `Body` React component:

```tsx
import type { ToolRenderer } from "../types";
import { PathText, ResultText } from "../parts";
import { str } from "../util";

export const myToolRenderer: ToolRenderer = {
	Summary: ({ args }) => <PathText path={str(args.path) ?? ""} />,
	Body: ({ result }) => <ResultText result={result} />,
};
```

- `Summary`: Single-line header rendered in card title bar. Block elements are not permitted.
- `Body`: Collapsible detail component. Omit if summary displays all relevant information.

Register renderers in `RENDERERS` in `registry.ts` under their wire tool names. `resolveToolRenderer(name)` resolves registered renderers, falling back to `genericRenderer` for unknown tool names.

## Aliases

Tool aliases map legacy names to current renderers:
- `puppeteer` → `browser`
- `apply_patch` → `edit`
- `find` → `glob`
- `search` → `grep`
- `js`, `python`, `notebook` → `eval`
- `await`, `poll`, `cancel_job` → `job`

## Constraints

- **Host-agnostic:** No imports of `node:*` or coding-agent host runtime packages.
- **Untrusted input:** `args` and `details` are arbitrary JSON. Use narrowing helpers (`str`, `num`, `isRecord`, `detailsRecord`) from `util.ts` and render `InvalidArg` on invalid schemas.
- **In-flight calls:** `running` is true while execution is in progress. Handle cases where `result` is undefined.
- **Optional host methods:** `host.hasAgent` and `host.openAgent` must be checked before calling.

## Shared components and helpers

`parts.tsx` provides standard card UI components:
- `Badge`, `Badges`
- `PathText`
- `Kv`, `KvGrid`, `Row`
- `Output`, `CodeBlock`, `DiffBlock`
- `ResultText`, `ResultImages`
- `Note`, `InvalidArg`, `AgentLink`

`util.ts` provides parsing and sanitization utilities:
- `shortenPath`
- `replaceTabs`
- `truncate`
- `languageFromPath`
- `argsDigest`

## Styling

Styles are defined in `src/tool-render.css` and published as `@veyyon/tool-render/tool-render.css`. CSS rules use `tv-` class prefixes and CSS variables (`--tv-*`) that fall back to host theme definitions.
