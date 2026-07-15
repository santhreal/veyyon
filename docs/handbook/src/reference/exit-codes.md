# Exit codes

Veyyon follows the standard shell conventions so it composes cleanly in scripts and CI.

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | A Veyyon error (bad config, auth failure, no such session, an unrecoverable runtime error) — or the fallback when a child process ended without a reportable status. |
| `2` | Usage error from argument parsing (an unknown flag or missing value); the standard `clap` convention. |
| `N` | When Veyyon runs a child process (for example a sandboxed shell command), the child's own exit code passes through unchanged. |
| `128 + signal` | On Unix, a child killed by a signal is reported as `128 + signal` (the POSIX shell convention): `SIGKILL` (9) → `137`, `SIGTERM` (15) → `143`. |

Two guarantees hold everywhere:

- A failure is **never** reported as `0`. An unknown or missing child status falls back to `1`, never
  success.
- A signal death is surfaced as a distinct non-zero code, never swallowed.

For the machine-readable event stream (including per-turn and per-tool outcomes), use the
Agent Control Protocol mode (`veyyon acp`); see the [CLI reference](./cli.md).
