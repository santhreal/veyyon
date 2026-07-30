# `/secret` container harness

Runs veyyon's real `/secret` flow end to end against a container-owned `HOME` and an
empty vault, and prints a pass/fail row per claim.

```sh
scripts/secret-harness/run.sh
```

Exit code is the number of failures collapsed to 0 or 1, so this works as a gate. A
run takes about a minute; `--rebuild-base` forces the base image to be rebuilt first.

## Why a container

`/secret list`, the stored-name completion, and the secret inventory in the system
prompt all read the global, profile **and** project scopes. On a developer machine
that means every capture names that developer's real credentials, so the output is
neither reproducible nor safe to paste into a bug report. Isolation therefore comes
from the image (`ENV HOME=/harness/home`), not from a `HOME=` prefix at call time and
not from `VEYYON_CONFIG_DIR` — which `getConfigDirName` rejects as an absolute path
anyway. `--network none` leaves only loopback, which is all the mock provider needs,
so a passing run also proves nothing phoned home.

`guard/no-foreign-secret-names` is the tripwire for that isolation. It sweeps every
captured byte, the append-only wire log included, for `#NAME#`-shaped tokens outside
the four this run seeded, and fails the run if it finds one. Without it a polluted
environment would pass every count and alignment assertion while proving nothing.
Two tokens are allowlisted because the product writes them about itself: the `#NAME#`
in the empty-vault help, and the `#NAME#`/`#XXXX#` pair in
`prompts/session/statements/tool-policy/secrets-redaction.md`.

## How it reaches the interesting code

Expansion, the secret-use boundary, and the post-revocation literal only happen on a
real model turn that emits a real tool call, so `mock-provider.ts` serves an
OpenAI-compatible endpoint on loopback and a generated `models.yml` points a custom
provider at it. `HARNESS_TOOL_SPEC` names a file holding the tool call the model
should emit next, which is how a bash check makes veyyon run an arbitrary command;
`HARNESS_WIRE_LOG` records every request body for the leak sweep. Everything below
the HTTP boundary is shipped code.

Two things the checks deliberately do **not** do:

- **Never assert on a value.** The tool call the model emits hashes its own argument
  and writes only the digest; the harness compares digests. So "the tool received the
  real credential" and "the tool received the literal `#NAME#`" are both provable
  without a value entering an assertion, a failure message, or this file.
- **Never quote a capture on failure.** One capture does contain an expanded
  credential today (`leak/json-event-stream-never-prints-a-value`), so a helper that
  printed the offending file would turn a detected leak into a printed one. Failures
  report the harness-authored needle and the path. `leak-paths.ts` reports the JSON
  _paths_ that carry a value and never the value.

`tools.approval.bash: allow` is what isolates the secret-use boundary from the
approval **tier**. bash is exec tier, so in `ask`/`auto-edit`/`plan` it would prompt
for being bash and the run would prove nothing about secrets. With an explicit allow,
`requiresApproval` returns false in every mode and the only thing left that can force
a prompt is the boundary. The `spend/*-identical-call-without-a-secret-runs` rows are
the negative control: the same call with no placeholder in it, which must run.

## Diagnosing a failure

Keep the captures and get a shell in the fully set-up state:

```sh
docker run --rm --network none -v /tmp/out:/harness/work veyyon-secret-harness:dev --shell
docker run --rm --network none -v /tmp/out:/harness/work veyyon-secret-harness:dev --shell probe.sh
```

`--shell` stops after setup — provider up, `models.yml` written, empty vault — which
is the state every check starts from. Anything after it is handed to bash, so a file
argument or `-c '…'` both work. Every capture is written to `/harness/work` as
`<tag>.out` / `<tag>.err`, plus `wire.log` (append-only, whole run),
`tui-first-launch.pty` and `tui-masked.pty`.

## The one PTY leg

Print mode covers `/secret add|list|rm` and the whole approval-mode matrix. It cannot
cover masked value entry, because that claim is about what a terminal shows, so that
one leg runs under `script -qec` — a real PTY, never tmux, which AGENTS.md forbids for
verification and which would distort exactly the rendering under test.

The first launch is its own check rather than a warm-up. The startup crash it catches
only reproduces while the interactive-only files under the agent directory do not yet
exist, so it is reachable roughly once per machine, and a harness that opened the TUI
a second time first would never see it.

## Files

| file               | role                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `run.sh`           | host driver: builds both images, runs the harness, exits with its status                 |
| `Dockerfile`       | `FROM` the repo `Dockerfile`'s `runtime` target; owns `HOME`, installs nothing           |
| `entrypoint.sh`    | the checks                                                                               |
| `mock-provider.ts` | loopback OpenAI-compatible endpoint, replays a tool call from a spec file, logs the wire |
| `leak-paths.ts`    | reports which JSON event fields carry a value, never the value                           |
