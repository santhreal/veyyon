# @veyyon/bench

Private benchmark, eval and simulation harnesses. Four harnesses share one manifest, one
`tsconfig.json` and one `bunfig.toml`; each keeps its own tree and its own README.

| Tree | What it is |
|---|---|
| [`src/deepswe/`](src/deepswe/README.md) | DeepSWE bench runner for performance-affecting changes. `bun run bench`. |
| [`src/metaharness/`](src/metaharness/README.md) | Harbor run storage, REST/SSE API and live dashboard. `bun run serve`, or the `metaharness` bin. |
| [`src/simulations/`](src/simulations/README.md) | Deterministic offline simulations driving real subsystems end to end. |
| `src/typescript-edit/` | Edit-tool benchmark built from TypeScript source mutations. `bun run generate`. |

Nothing outside this package imports it, so the trees address each other by relative path rather
than through a subpath export.

```sh
bun run --cwd=packages/bench test
bun run --cwd=packages/bench check:types
```
