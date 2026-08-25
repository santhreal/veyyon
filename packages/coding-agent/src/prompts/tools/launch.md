Supervises a process that does NOT end on its own, private to the session that started it.

<routing>
- Pick by how the process ENDS, never by how long it runs. Ends on its own (test suite, build, benchmark, migration, install — any command with a last line)? That is `bash`, backgrounded if it is slow. Runs until something stops it, or you must talk to it later (server, watcher, daemon, REPL, tunnel)? That is `launch`.
- `launch` is NOT how you background a command. A supervised process reports its own exit as a background job, so you never poll — but a finite command belongs in `bash`, which returns its output and exit code.
</routing>

<instruction>
- The schema documents every field; these are the facts it cannot state.
- `start` BLOCKS until readiness or `ready.timeout`, so a pattern that never prints costs the whole timeout. Without `ready` it returns as soon as the process is spawned.
- Scope: a launch is yours alone. `persist`/`detached` land in the project scope the `veyyon launch` CLI and later sessions reach, and `list` shows both; `launch.sharedCrossSession` puts every launch there. Names are unique per scope: a completed name MAY be started again, a live name MUST be stopped or restarted.
- Every op except `start` and `list` addresses the stable `name`.
- `logs` with `follow` returns a cursor; pass it back on the next call to continue where you stopped.
- `wait` blocks. An exit already arrives on its own, so `wait` is for readiness or a pattern you need before the next step — never a poll loop.
- `send.keys` accepts ENTER, TAB, ESCAPE, CTRL_C, CTRL_D, UP, DOWN, LEFT, RIGHT. PTY input is serialized: many clients MAY observe, but writes share one input stream.
- `stop` terminates the process tree gracefully before hard-kill; `restart` reuses the retained spec. Neither reports an exit you asked for, and `on-failure`/`always` restarts use bounded backoff.
- Lifetime is decided at `start` and shown in `list` as `lifetime=`: `last-client-exit` (default — dies when the last veyyon holding this scope exits), `broker-shutdown` (`persist` — outlives the last client, dies with the broker), or `detached` (survives every veyyon and broker exit, reports no exit). Read it before assuming a process is still alive later.
- Every termination records WHO ended the process and WHY: `list` and terminal results carry `terminated-by=` plus a reason. Owners: `process-exit`, `external-signal` (nothing in veyyon asked — suspect the OOM killer or another process), `operator-stop`, `operator-restart`, `operator-signal`, `broker-shutdown`, `idle-reaper`, `os-signal`, `broker-recovery`, `launch-failure`.
- A finished process's completion record (exit code, termination owner and reason, output tail) is retained — the last 100 or 24h, across broker restarts — and `list` shows it under "Recently completed".
</instruction>

<critical>
- Readiness MUST be observed; process creation alone is not readiness.
- Use `stop`; NEVER kill an unverified PID through bash.
</critical>
