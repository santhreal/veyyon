# @veyyon/tool-render

Shared React tool-call renderers used by:

- `packages/coding-agent` HTML session export (`<vey-tool-view>`)
- `packages/collab-web` live transcript tool cards

Host shells (`element.tsx`, `standalone.tsx`) stay in each consumer. Do not fork
`registry.ts`, `tools/`, `parts.tsx`, `util.ts`, or `ToolView.tsx` outside this package.
