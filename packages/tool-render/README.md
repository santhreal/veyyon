# @veyyon/tool-render

React tool-call components and a host-independent view interpreter for HTML transcripts. Consumed by:

- `packages/coding-agent` HTML session exports (`<vey-tool-view>` web component)
- `clients/web` live web transcript
- `hosts/gui` HTML view adapter

`ToolView` accepts a projected `ToolExecutionDisplay` from `@veyyon/wire/presentation`.
Calls without a projection retain the raw `Summary` and `Body` renderer API.
The React and GUI HTML adapters use `@veyyon/tool-render/view-core` to interpret `ToolView`
structure; each adapter supplies its output elements and symbol glyphs.
Compact card headers omit repeated complete tool labels and retain operation suffixes.

## Writing a renderer

A descriptor in `src/descriptors/` specifies a tool name, `Summary`, and an optional `Body` React component:

```tsx
import type { ToolDescriptor } from "../types";
import { PathText, ResultText } from "../parts";
import { str } from "../util";

export const myToolDescriptor: ToolDescriptor = {
	name: "my_tool",
	Summary: ({ args }) => <PathText path={str(args.path) ?? ""} />,
	Body: ({ result }) => <ResultText result={result} />,
};
```

- `Summary`: Single-line header rendered in card title bar. Block elements are not permitted.
- `Body`: Collapsible detail component. Omit if summary displays all relevant information.

Add the descriptor to its domain array in `src/descriptors/`. `registry.ts` registers those arrays and their aliases. `resolveToolRenderer(name)` returns the registered renderer or `genericRenderer` for an unknown tool name.

## Aliases

Tool aliases map legacy names to current renderers:
- `puppeteer` → `browser`
- `apply_patch` → `edit`
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
