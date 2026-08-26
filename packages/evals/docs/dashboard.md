# Dashboard and wire contract

The dashboard is a React app served by the manager server over the same process that owns the run
store. `docs/manager.md` documents the API endpoints and the store. This page documents the contract
between them and the rules the UI follows when a number was never measured.

```sh
bun --cwd=packages/evals run serve --port 4700
```

## The wire module

`src/wire.ts` declares every type that crosses `/api/*`: row shapes, request and response bodies,
literal unions, the route inventory, and the three formatters both sides use. It depends on nothing
else in the package — no store, no core, no server — so a browser bundle or an external client
imports it without pulling in `bun:sqlite`.

`src/web/**` imports from `src/wire.ts` and from nothing under `src/manager/` or `src/server/`. That
is what keeps the dashboard buildable as a DOM-typed project (`src/web/tsconfig.json`) while the
server stays Node-typed.

## Routes

`SERVER_ROUTES` is the inventory of all sixteen endpoints, each a `{ method, path }` pair. It is a
runtime value, so a contract suite enumerates it instead of restating a list that goes stale:
`test/web/a-wire-contract-governs-all-endpoints-and-renders-unmeasured-spend-as-null.test.ts` sweeps
it and fails when an endpoint has no wire contract.

## Absent is not zero

A cost, a token count or an ETA that nothing measured is `null` on the wire, `NULL` in the store, and
an em dash in the UI. Three surfaces reached that decision separately and one of them printed
`$0.000` for a run nobody priced, which reads as a free run.

`formatUsd(value, absent = "—")` is the one owner: `null` renders the caller's marker, and a measured
value renders at 0 decimal places at or above `$100`, 2 at or above `$1`, and 3 below it. The marker
varies by surface — a dashboard cell and the harbor summary read `—`, the markdown report reads
`n/a` — and the tiers and the never-zero rule do not. `src/report/bench-report.ts` and
`src/backends/harbor/runner/ui.ts` both delegate to it.

`formatEta(etaMs, now)` renders `—` for an unknown ETA rather than `~0m`, which claimed a run was
about to finish. `formatMinutes(ms)` renders a measured duration.

## Live updates

`GET /api/events` is a Server-Sent Events stream carrying run row updates. The dashboard applies each
event to its row table; it does not poll. A row's `schemaVersion` travels with it, so a client
reading a row written by an older store version reports the mismatch instead of rendering fields it
cannot interpret.
