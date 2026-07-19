# Exit codes

Exit codes follow common shell conventions for scripts and CI.

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | A Veyyon runtime error: bad config, auth failure, no such session, an unrecoverable runtime error, or the fallback when a child process ended without a reportable status. |
| `2` | A command-line usage error, following the conventional shell meaning of code `2`. You get it for an unrecognized flag, a bad flag value, or a single-shot run (`--print`) with no prompt to send. Veyyon fails before starting a session, so no LLM call or MCP connection happens. |
| `130` | Veyyon itself was interrupted. A second `Ctrl+C` during shutdown hard-aborts the process at `128 + SIGINT` (`128 + 2`), rather than waiting on a teardown step that is stuck. |
| `N` | When Veyyon runs a child process (for example a shell tool command), the child's own exit code passes through unchanged. |
| `128 + signal` | On Unix, a child killed by a signal is reported as `128 + signal` (the POSIX shell convention): `SIGKILL` (9) → `137`, `SIGTERM` (15) → `143`. |

Two guarantees hold everywhere:

- A failure is **never** reported as `0`. An unknown or missing child status falls back to `1`, never
  success.
- A signal death is surfaced as a distinct non-zero code, never swallowed.

For the machine-readable event stream (including per-turn and per-tool outcomes), use the
Agent Client Protocol mode (`veyyon acp`); see the [CLI reference](./cli.md).
