# Dashboard and wire contract

The dashboard is a React app served by the manager server in the same process as the run
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

## Trial status

`TRIAL_STATUSES` is the inventory of trial statuses — `pass`, `fail`, `error`, `running` — and
`TrialStatus` is the type every row, cell and store read carries. Two classifications sit beside it:

- `isDecidedTrialStatus` — the trial is over. It counts toward `done` and toward a pass-rate
  denominator. `pass`, `fail` and `error`.
- `isGradedTrialStatus` — a verifier produced a verdict. It informs task difficulty and which
  attempt a re-run merge keeps. `pass` and `fail`.

Both are exhaustive switches over the union, and `CELL_CLASS` in `task-matrix.tsx` is keyed by it, so
adding a status fails the type check in `src/wire.ts`, `runner/ui.ts` and the matrix until each
states its answer.

`RunStore.listTraces` normalises a recorded status this build does not know: the trial reads as
`error` and its `detail` states the value the row held. An unclassified status otherwise counted
toward no total, so the arm's `done` stayed below `nTotal` and the run read as running forever.

## Routes

`SERVER_ROUTES` is the inventory of all sixteen endpoints, each a `{ method, path }` pair. It is a
runtime value, so a contract suite enumerates it instead of restating a list that goes stale:
`test/web/a-wire-contract-governs-all-endpoints-and-renders-unmeasured-spend-as-null.test.ts` sweeps
it and fails when an endpoint has no wire contract.

## Action outcomes

Every mutating action — launch, add arm, cancel, resume, delete — goes through `mutate` in
`src/web/api.ts`, which returns `{ data, error }` and never throws at a click handler. On a rejection
the error is the manager's own `error` field, or `<route>: the manager answered <status>` when the
answer carries no readable body; a successful answer that cannot be parsed reports
`<route>: the manager's answer could not be read` rather than success. A cancel that signalled
nothing (`cancelled: false`) says so, because the row keeps running either way.

`getAuthToken` states why a session token could not be obtained instead of sending the request
unauthenticated. The token is cached, and a 401 drops the cached copy and re-issues exactly once:
a manager that restarted minted a new token, and a second rejection is the manager's answer rather
than a stale token.

Every request goes through `fetchWithin` in `src/core/bounded-fetch.ts`, which bounds it at 15s and
reports a peer that did not
answer by name. A page whose request never settles shows no rows and no error, and the poll behind it
never fires again, because a poll cycle waits for the request it started. A caller's own signal still
cancels; only the bound produces the timeout message. The SSE stream is exempt: it is long-lived by
design and bounded by its heartbeat.

## Arm identity

An `ArmSummary` carries two names. `recordedArm` is the arm the run's coordinates state, computed by
`experiments.ts` from the recorded `experiment`/`arm` fields, or from the job name split at a
registered experiment id, or the whole job name when nothing registered a prefix to strip. `arm` is
what a reader shows: the label an operator set, falling back to `recordedArm`.

The matrix is keyed by `arm`, so a labelled row and its cells agree. A re-run merged into its base
arm reports the canonical arm, without the `-fix` or `-backfill` suffix.

No component derives either name. Slicing a job name at its first hyphen turned `sb-v2-base` into
`v2-base`, and a job name with no hyphen into the whole name.

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

An absent value has to survive the reader that produced it. A harbor trial's spend and token counts
are `null` until something measures them: the live transcript probe reports absent until it reads a
usage event, and reports absent spend beside measured tokens when the provider priced nothing; a
finished trial's `result.json` that recorded no agent context, or a field that is not a finite
number, sums to `null` rather than 0. Job totals sum only the trials that measured a field. A
measured `0` still renders as `$0.000` and `0`, which is what distinguishes a free trial from an
unpriced one.

A trial whose verifier recorded no reward graded nothing, so both readers of that `result.json` —
the runner's report and the manager snapshot — call it an error with `missing or unparsable reward`,
not a fail.

## Live updates

`GET /api/events` is a Server-Sent Events stream carrying run row updates. The dashboard applies each
event to its row table; it does not poll. A row's `schemaVersion` travels with it, so a client
reading a row written by an older store version reports the mismatch instead of rendering fields it
cannot interpret.

A frame the page cannot use is one frame, not the end of the subscription: a payload that is not a
list of rows carrying a job name leaves the last run list on screen and the page states what
arrived. A dropped connection is stated the same way, because a stale table and a live one look
identical otherwise. `usePolled` returns the same reason beside the payload it last read, so a
detail pane whose endpoint stopped answering says so instead of continuing to render its last
response.
