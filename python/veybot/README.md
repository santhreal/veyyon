# veybot

Self-hosted GitHub triage bot. Drives [`veyyon --mode rpc`](https://github.com/santhreal/veyyon)
as a subprocess against a per-issue git worktree, then writes back to GitHub
through a sidecar that holds the PAT.

On `issues.opened` in an allowlisted repo it classifies the issue, labels it,
and branches:

- `bug` / `documentation` → reproduce, fix on a fresh branch, open a PR whose
  body has `## Repro` / `## Cause` / `## Fix` / `## Verification` and
  `Fixes #N`.
- `question` → one comment, suffixed with a 👎-to-keep-open prompt; if the
  issue author doesn't react 👎 within `VEYBOT_QUESTION_AUTOCLOSE_HOURS`
  (default 4), the issue auto-closes as `state_reason=completed`. A follow-up
  comment or external close cancels the schedule synchronously.
- `enhancement` / `proposal` → one comment, no PR.
- `invalid` / `duplicate` → one brief comment.

Follow-up issue comments and PR review comments resume the same veyyon session
(`--continue` against the persisted JSONL transcript). On orchestrator
restart, in-flight events are re-queued and resume the same way.

Two more task kinds run without a live webhook behind them. `port_upstream`
turns one `upstream-port` tracking issue into one candidate pull request that
a human reviews and merges. `ci_repair` fixes a candidate whose checks went
red, on the same branch, a bounded number of times. See
[Upstream port backlog](#upstream-port-backlog). veybot never merges anything.

## Architecture

Two containers, one trust boundary:

- **veybot** — FastAPI + sqlite event queue + `WorkerPool` running `veyyon` in
  per-issue worktrees under `/data/workspaces/`. Holds the HMAC key, never
  the PAT.
- **gh-proxy** — sibling on an `internal: true` network. Holds `GITHUB_TOKEN`,
  verifies HMAC-signed requests from veybot, executes REST + `git push`.
  Only egress to `api.github.com`.

Flow: webhook → HMAC verify → `github_events.route` → sqlite `events`
(dedup on `X-GitHub-Delivery`) → `WorkerPool` claims under
`BEGIN IMMEDIATE` with an in-process `_inflight` set per `(owner, repo, n)`
→ `sandbox.ensure_workspace` produces a worktree on `farm/<8hex>/<slug>`
→ `worker.run_task` spawns `veyyon --mode rpc` with `cwd=worktree`,
persistent `session_dir`, model randomly drawn from `VEYBOT_MODEL` (CSV).

The agent uses veyyon's built-in tools (`read`/`edit`/`bash`/`lsp`, scoped to
the worktree) plus the host tools in `src/host_tools.py` — the
exclusive surface for GitHub writes. Every host-tool invocation is audited
into the `tool_calls` table with credential-redacted args and results.

## Setup

Requires Docker Compose v2 and a LiteLLM-style proxy on the host. You point
veybot at that proxy with `VEYBOT_LLM_BASE_URL` in `.env`, and veybot generates
the agent's `~/.veyyon/agent/models.yml` from it on every agent launch. There is
no host file to write and nothing to mount: provider routing lives in the same
single config surface as everything else, so it cannot drift out of agreement
with `VEYBOT_MODEL`. The credential is read from the `VEYBOT_LLM_API_KEY`
environment variable and is never written into the generated file.

Leave `VEYBOT_LLM_BASE_URL` empty to say veybot does not manage routing, which
is what you want for a native run on a machine whose own veyyon profile already
has providers configured.

veybot lives inside the veyyon
monorepo at `python/veybot/`; both the docker build context and the
`/work/veyyon` bind mount default to the parent monorepo (`../..`). Override
`VEYYON_ROOT` only if you want a different veyyon checkout backing the build
and runtime.

Bot account needs **Write** on every repo in `VEYBOT_REPO_ALLOWLIST`. A
fine-grained PAT with Contents / Issues / Pull requests RW + Metadata R is
enough.

```bash
cp .env.example .env
$EDITOR .env
openssl rand -hex 32              # VEYBOT_GH_PROXY_HMAC_KEY
openssl rand -hex 32              # GITHUB_WEBHOOK_SECRET

bun run docker:build              # build veyyon:dev (one-time / on veyyon change)
bun run veybot:build && bun run veybot:up
curl -fsS http://localhost:8080/healthz
```

The bundled `docker-compose.yml` runs in gh-proxy mode, and gh-proxy mode is
the only mode the orchestrator supports. `_require_proxy_mode` in both
`server.py:228` and `cli.py:38` exits when it finds `GITHUB_TOKEN` in its own
environment, so there is no PAT-in-process alternative for `serve` or for any
CLI command that reaches GitHub. Outside containers, run gh-proxy as a second
local process rather than moving the token into the orchestrator.

Build invalidation is bounded: editing veybot Python touches only the
runtime layer; editing veyyon source rebuilds `veyyon:dev`, which
veybot's `Dockerfile.veybot` extends via `FROM ${VEYYON_BASE}`.

### Public URL

veybot does not ship a tunnel. Cloudflare, smee, ngrok are all fine. The
recommended ingress rule restricts the public hostname to
`/webhook/github` exactly; `/healthz`, `/events`, `/issues`, `/replay`
stay localhost-only.

### GitHub webhook

In *Settings → Webhooks*: payload URL `https://…/webhook/github`, content
type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, events =
*Issues, Issue comments, Pull requests, Pull request reviews, Pull
request review comments*. GitHub's `ping` should produce
`POST /webhook/github 202` within a second.

### Configuration

`.env` is the single configuration surface, and it is gitignored. Every key
veybot reads is declared as a field in `src/config.py`; `.env.example` lists all
of them with their real defaults. Nothing else in the tree reads the
environment, so there is exactly one file to write and one file to read when you
want to know how a deployment is set up.

A key in `.env` that matches no declared field is a startup error naming the
key. That is deliberate. Unknown keys used to be ignored, so a typo such as
`VEYBOT_MAX_CONCURENCY=2` parsed cleanly, did nothing, and left you reading a
file that disagreed with the running process.

The shipped `docker-compose.yml` uses per-service `environment:` allowlists
rather than `env_file:`, so `GITHUB_TOKEN` only reaches the gh-proxy container.

### Pointing veybot at another project

veybot's toolchain steps are configuration, not code, so it can service a
repository built with anything. Five keys describe the shape of the repo:

| Variable | Default | Effect |
|---|---|---|
| `VEYBOT_PROJECT_MARKERS` | `package.json,bun.lock` | Files that must all exist at the repo root for the dependency bootstrap to apply. This is the "is this repo my kind of project" test, which is what lets one veybot serve an allowlist holding several different projects. Empty matches every repo. |
| `VEYBOT_WORKSPACE_BOOTSTRAP_COMMAND` | `bun install --frozen-lockfile --ignore-scripts` | Dependency install, run before the agent starts. |
| `VEYBOT_WORKSPACE_BOOTSTRAP_TIMEOUT_SECONDS` | `300` | Budget for that install. |
| `VEYBOT_PRE_PR_FIX_COMMAND` | `bun run fix` | Formatter run before a push or PR; what it changes is amended into the agent's HEAD commit. |
| `VEYBOT_PRE_PR_CHECK_COMMAND` | `bun check` | Gate run before a push or PR. A non-zero exit refuses the publish. |

Each is a command line with shell-style quoting, run without a shell. An empty
value disables that step. A malformed one (an unbalanced quote) fails at
startup rather than hours later, mid-task.

A Rust project, for example, sets `VEYBOT_PROJECT_MARKERS=Cargo.toml,Cargo.lock`
with `cargo fetch`, `cargo fmt`, and `cargo clippy --workspace`.

Two properties are worth keeping when you replace the bootstrap default. A
frozen or locked install leaves no spurious lockfile diff for the agent to
commit. Skipping lifecycle scripts is a security property rather than a speed
one: it stops an untrusted pull request's `postinstall` executing as the slot
user.

The pre-publish gate is deliberately not filtered by the markers. The markers
include a lockfile, so gating on them would let a repo with a manifest and no
lockfile skip the gate entirely and silently, and a bot PR would be pushed with
no check having run. A gate may refuse, and you may switch it off in config, but
it must never quietly not happen.

## CLI

The container entrypoint is `python -m veybot serve`. Other commands run
inside the running container:

```bash
docker compose exec veybot veybot triage  owner/repo#123    # synthesize an issues.opened and wait
docker compose exec veybot veybot replay  <delivery_id>     # re-enqueue a stored event and wait
docker compose exec veybot veybot status                    # dump issues table
docker compose exec veybot veybot cleanup owner/repo#123    # force workspace removal, state=abandoned
docker compose exec veybot veybot port-backlog owner/repo   # queue open upstream-port issues
```

`bun run veybot:…` shortcuts in the root `package.json` cover the common
lifecycle commands (`veybot:dev`, `veybot:build`, `veybot:up`, `veybot:down`,
`veybot:logs`, `veybot:restart`, `veybot:reset`), plus `veybot:serve` and
`veybot:backlog` for a native host run.

## Upstream port backlog

Three terminals, two lanes, ten issues. The first terminal is gh-proxy, which
holds the token; the orchestrator refuses to run with the token in its own
environment, so this split is required rather than a hardening option.

```bash
# terminal 1: gh-proxy, the only process that sees the PAT
GITHUB_TOKEN=<pat> VEYBOT_GH_PROXY_BIND_PORT=8391 \
  python3 -m veybot.proxy serve

# terminal 2: the orchestrator and its two lanes
VEYBOT_GH_PROXY_URL=http://127.0.0.1:8391 \
  VEYBOT_MAX_CONCURRENCY=2 VEYBOT_MODEL=gemini-3.6-flash-medium \
  VEYBOT_AGENT_PROFILE=work VEYBOT_THINKING=off python3 -m veybot serve

# terminal 3: fill the queue
VEYBOT_GH_PROXY_URL=http://127.0.0.1:8391 \
  python3 -m veybot port-backlog santhreal/veyyon --limit 10
```

`VEYBOT_GH_PROXY_HMAC_KEY` is the same value in all three and is omitted above
only to keep the example short. The third command queues ten port issues. The
daemon picks them up and opens one candidate pull request per issue, then
stops. A human reviews each candidate and a human merges it.

### Where the work comes from

`scripts/upstream-radar.ts` watches `can1357/oh-my-pi`. When a pull request
merges there and survives `scripts/upstream-port-policy.json`, the radar opens
one tracking issue on `santhreal/veyyon` and labels it `upstream-port`. About
200 of those issues are open today.

The `port_upstream` task turns one tracking issue into one candidate pull
request. It reads the upstream diff, maps it onto veyyon's own owners, proves
the behavior locally, and calls `gh_open_pr`. For a fix it must produce a
failing negative control first, and prove the regression test fails when the
production change is reverted. For a feature it must prove an off-versus-on
differential through the real operator path. When the port does not apply it
calls `mark_unable_to_reproduce` with the evidence and opens nothing.

The label is the selector. `VEYBOT_PORT_LABEL` sets it and defaults to
`upstream-port`. Change the label and veybot stops seeing the backlog.

### Draining the backlog

The radar issues predate the bot, so no webhook will ever fire for them. Queue
them by hand:

```bash
python3 -m veybot port-backlog santhreal/veyyon --limit 10 --dry-run
python3 -m veybot port-backlog santhreal/veyyon --limit 10
```

The command asks GitHub for the open issues carrying the port label, walking
every page of the answer, and writes one event row each, the same way `veybot
triage` writes one. Every row gets a delivery id derived from the repo and the
issue number, so re-running the command is safe. An issue already in the events
table is skipped, whether a previous drain queued it or a live webhook did.
`--dry-run` prints the selection and writes nothing.

`--limit` defaults to 10 and bounds only the rows the run creates. It is not
the size of the scan. The scan always covers the whole labeled backlog, so the
summary line reports the true number of matching open issues alongside the
number this run queued and the number earlier runs already own. Issues that are
already queued do not spend the budget.

Run it again whenever the lanes go idle, and each run picks up where the budget
left off. A safety ceiling of 2000 issues stops the scan from walking an
unbounded repository forever. Reaching it is not silent: the summary line says
the scan stopped early and that the match count is a floor.

`bun run veybot:backlog` is the same command against `santhreal/veyyon`.

### CI repair

A candidate whose checks go red is repaired on its own branch. veybot reads the
failing check runs, pulls the failed job log, and starts a `ci_repair` task with
that log as its primary evidence. The task reproduces the failure locally, fixes
the cause, and adds a new commit to the same branch.

The budget is `VEYBOT_CI_MAX_REPAIRS` attempts per head commit, three by
default. A new push resets it. When the budget runs out veybot comments on the
pull request and stops. The pull request then waits for a human.

The repair task may never buy a green check by weakening a gate. Relaxing an
assertion, skipping or narrowing a test, lowering a threshold, silencing a lint
rule or a type error, and editing anything under `.github/` are all forbidden.
If the only way to make the gate pass is to weaken the gate, the correct
outcome is to stop and report failure.

### Configuration

| Variable | Default | Effect |
|---|---|---|
| `VEYBOT_PORT_UPSTREAM_ENABLED` | `true` | Master switch for the port task. Off means labeled issues are skipped and `port-backlog` refuses to run. |
| `VEYBOT_PORT_LABEL` | `upstream-port` | The label that marks a tracking issue as port work. |
| `VEYBOT_CI_REPAIR_ENABLED` | `true` | Master switch for the repair loop. Off means a red candidate stays red. |
| `VEYBOT_CI_MAX_REPAIRS` | `3` | Repair attempts per head commit before the candidate goes to a human. |
| `VEYBOT_AGENT_PROFILE` | empty | Appends `--profile <value>` to the veyyon invocation. Empty lets veyyon pick its own default profile. |

### Running two lanes on a spare PC

Run veybot natively on that machine, not through the docker compose recipes.
Profile `work` is authenticated in your own home directory, and the container
has its own `HOME` with no credentials in it.

```bash
bun run veybot:install
```

You also need `veyyon` on `PATH`.

veybot always runs as two processes, and that is not optional. The
orchestrator refuses to start when it can see `GITHUB_TOKEN`
(`server.py:228` and `cli.py:38`), so the token lives in a second process
called gh-proxy and the orchestrator reaches GitHub through it over a signed
local socket. Running them as two plain processes on the same machine is
enough; you do not need containers for this.

gh-proxy needs these:

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | a PAT belonging to the bot account |
| `VEYBOT_GH_PROXY_HMAC_KEY` | a shared secret, from `openssl rand -hex 32` |
| `VEYBOT_GH_PROXY_BIND_PORT` | a free local port, for example `8391` |

The orchestrator needs these, and must NOT see `GITHUB_TOKEN`:

| Variable | Value |
|---|---|
| `VEYBOT_GH_PROXY_URL` | `http://127.0.0.1:8391` |
| `VEYBOT_GH_PROXY_HMAC_KEY` | the same shared secret |
| `GITHUB_WEBHOOK_SECRET` | any strong random value, from `openssl rand -hex 32` |
| `VEYBOT_BOT_LOGIN` | `santhsecurity` |
| `VEYBOT_GIT_AUTHOR_EMAIL` | the email on that account |

Both processes read the same settings module, so put the shared values in one
`.env` and keep `GITHUB_TOKEN` out of the orchestrator's environment.

The webhook secret is required even in a backlog-only deployment where no
webhook is ever delivered. Set a random value and move on.

Every GitHub action in this repository is taken as `santhreal`, whose gh login
string is `santhsecurity`. The token must belong to that account. The routing
guards that recognize the bot's own work key off `VEYBOT_BOT_LOGIN`, so a wrong
value there makes veybot either ignore its own pull requests or try to repair
someone else's.

Then the lane settings:

```bash
VEYBOT_REPO_ALLOWLIST=santhreal/veyyon
VEYBOT_MAX_CONCURRENCY=2
VEYBOT_MODEL=gemini-3.6-flash-medium
VEYBOT_AGENT_PROFILE=work
VEYBOT_THINKING=off
```

`VEYBOT_REPO_ALLOWLIST` is not optional. `github_events.route` drops every
event whose repo is not on it.

`VEYBOT_MAX_CONCURRENCY` is global. Setting it to `2` caps every task kind
together, so two lanes means at most two veyyon subprocesses across triage,
ports, and repairs combined.

`VEYBOT_THINKING=off` is right for this model. `gemini-3.6-flash-medium`
carries its reasoning effort in the model id, so a separate thinking level
would fight it.

### Hard rules

- veybot never merges a pull request and never enables auto-merge. No merge
  path exists anywhere in the tree, and its absence is the guarantee.
- veybot never pushes to the default branch. It publishes only the
  `farm/<hex>/<slug>` branch the sandbox prepared.
- veybot never weakens a test, a gate, or a workflow to make CI green.
- veybot opens exactly one candidate per tracking issue.

## Tests

```bash
pytest -x tests/                              # unit suite, no network
VEYBOT_INTEGRATION=1 pytest -x tests/test_worker_smoke.py
```

The integration test spawns a real `veyyon --mode rpc` against an
`httpx.MockTransport` GitHub and a local bare repo, so it needs `veyyon` on
`PATH`. `bun run test:py` runs the unit suite.

## Security posture

- `GITHUB_TOKEN` lives only in the gh-proxy container. The orchestrator
  refuses to start if it sees `GITHUB_TOKEN` in its own environment.
- Orchestrator → gh-proxy is HMAC-SHA256 signed with a ±30s skew window
  and constant-time compare.
- `git push` inside gh-proxy uses `git -c http.extraheader=…` with the
  token passed through an ephemeral process env var; the remote URL in
  `.git/config` stays token-free.
- gh-proxy has no host port. The `veybot_internal` network is
  `internal: true` (no ingress, no egress); gh-proxy joins `default`
  only to reach `api.github.com`.
- The orchestrator's dashboard is published on `127.0.0.1:6543` only. The
  webhook route verifies its HMAC, but `/`, the static bundle and the
  issue-browser API carry no authentication, so a wider publish would hand the
  dashboard, the run logs and the issue browser to anyone who can reach the
  port, including everyone on the LAN or a tailnet. Reach it over an SSH tunnel
  (`ssh -L 6543:127.0.0.1:6543 <host>`). Do not widen the mapping without
  putting real authentication in front of the app first.
- Agent subprocess env is scrubbed of `GITHUB_TOKEN` /
  `VEYBOT_GH_PROXY_HMAC_KEY` / friends via `worker._SCRUBBED_ENV_KEYS`.
- Webhook signatures: bad sig → `401` (so GitHub stops retrying), never
  `5xx`.
- `git` errors flow through `git_ops.GitCommandError` which redacts
  `https://user:pw@host` to `https://***@host` from argv, stdout, stderr
  before raising. `host_tools._audit` only records agent-supplied args.
- Pre-push gates (`gh_push_branch`): branch matches the workspace
  branch, working tree clean, every commit on
  `origin/<default>..HEAD` carries `VEYBOT_GIT_AUTHOR_NAME` +
  `VEYBOT_GIT_AUTHOR_EMAIL`. Commit messages carrying shell-literal
  `\n` escapes (agents quoting `git commit -m 'a\n\nb'`) are rewritten
  to real newlines — message-only, trees/identities/dates preserved.
- Pre-PR gates (`gh_open_pr`): when the repo defines them, `bun run fix`
  runs first (any diff amended into the agent's HEAD commit — no
  standalone `style:` noise commits) and then
  `bun check`. A failing `bun check` returns to the agent as
  `RpcCommandError` for iteration.
- `gh_open_pr` validates `## Repro` / `## Cause` / `## Fix` /
  `## Verification` headers and a `Fixes`/`Closes`/`Resolves #N`
  reference before opening.

## Operational notes

- **One PR per issue.** Follow-up events push amendments to the same
  `farm/<hex>/<slug>` branch.
- **No PR without a recorded repro.** Persona prompt requires
  `repro_record`; `mark_unable_to_reproduce` asks for missing details,
  marks the row `needs_info`, and resumes the same session on the next reply.
- **Crash recovery.** On startup, `db.reset_stuck_running()` flips
  `running` rows back to `queued`. Existing `<session_dir>/*.jsonl`
  triggers `--continue`. Drain bounded by
  `VEYBOT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS` (25s) +
  `VEYBOT_SHUTDOWN_KILL_TIMEOUT_SECONDS` (5s); compose
  `stop_grace_period: 30s` covers both.
- **Logs.** Structured JSON on stdout, rotated to
  `/data/logs/veybot.log.jsonl`.
- **Inspection** (localhost only): `GET /events?limit=N`,
  `GET /issues?limit=N`, `GET /healthz`, `GET /readyz`, and the
  dashboard at `/`.
- **Port backlog.** `veybot port-backlog owner/repo` is the only way the
  radar's pre-existing `upstream-port` issues reach the queue. It is
  idempotent, so re-run it whenever the lanes go idle.
- **No merge path.** Nothing in this tree merges a pull request or enables
  auto-merge. Candidates wait for a human.

## Troubleshooting

| Symptom | Check |
|---|---|
| `401 invalid signature` | `GITHUB_WEBHOOK_SECRET` mismatch with the repo webhook config. |
| Container exits with `VEYYON_ROOT … missing` | `/work/veyyon` mount empty inside the container; on the host either run `docker compose` from `python/veybot/` so `VEYYON_ROOT` defaults to `../..`, or export `VEYYON_ROOT` to a valid veyyon checkout. |
| `git push: Authentication required` | Bot PAT lacks push, or `VEYBOT_BOT_LOGIN` does not identify the PAT account's mention handle (production: `veybot`, no `@`/`[bot]`). |
| `refusing to push: commit author identity mismatch` | Some commit not authored as `VEYBOT_GIT_AUTHOR_*`. The error lists the offending shas; `git commit --amend --reset-author --no-edit`. |
| `refusing to push: working tree is dirty` | Uncommitted agent edits. Or just call `gh_open_pr`, which auto-commits `bun run fix` output. |
| `bun check failed before PR creation` | Fix the reported failure and retry `gh_open_pr`. |
| `Failed to load veyyon_natives` | Wrong arch / missing native. `bun run docker:build` then `bun run veybot:build`. |
| `No API key found for <provider>` | `VEYBOT_LLM_API_KEY` unset in `.env`, or `VEYBOT_LLM_PROVIDER_ID` disagrees with the provider prefix in `VEYBOT_MODEL`. Read the generated `/srv/agent-home/.veyyon/agent/models.yml` in the container to see what veybot published. |

## Layout

```
src/
  server.py          FastAPI app, /webhook/github, /events, /issues, /replay, dashboard at /
  github_events.py   verify_signature + route()
  queue.py           WorkerPool, dispatch loop, per-issue _inflight serialization
  tasks.py           triage_issue, handle_comment, handle_pr_conversation, handle_review,
                     cleanup_workspace, port_upstream, ci_repair
  worker.py          synchronous veyyon RPC driver, prompt assembly, env scrubbing
  host_tools.py      classify_issue, set_issue_labels, gh_post_comment, repro_record,
                     gh_push_branch, gh_open_pr, gh_request_review,
                     mark_unable_to_reproduce, abort_task, fetch_issue_thread
  sandbox.py         clone pool + worktree lifecycle
  github_client.py   typed httpx client; webhook payload parsing
  proxy_client.py    GitHubProxyClient + HMAC signer
  db.py              sqlite schema + DAOs
  config.py          pydantic Settings; mode-exclusive PAT vs gh-proxy validation
  cli.py             serve / triage / replay / status / cleanup / port-backlog
  manual_triage.py   synthetic webhook payloads for `triage` and `port-backlog`
  prompts/           system_append.md + per-task kickoff templates
tests/               pytest unit suite + one VEYBOT_INTEGRATION=1 smoke test
web/                 vite + solid dashboard, built into src/static/
```

## License

MIT.
