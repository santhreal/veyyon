Supervises a process that does NOT end on its own, shared by every veyyon instance in the same directory.

<routing>
- Pick by how the process ENDS, never by how long it runs. Ends on its own (test suite, build, benchmark, migration, install, any command with a last line)? That is `bash`, backgrounded if it is slow — however long it takes. Runs until something stops it, or you must talk to it later (server, watcher, daemon, REPL, tunnel)? That is `launch`.
- `launch` is NOT the way to background a command. A supervised process that exits is reported to you as a background job when it exits, so you never poll for one — but a finite command belongs in `bash`, which returns its full output and exit code.
</routing>

<instruction>
- `start` launches `application` + `args` directly. `cwd` defaults to the session directory; `pty` defaults true.
- `ready.log` is a regex; `ready.port` is a TCP port. Both supplied? BOTH MUST pass. `ready.timeout` is seconds — `start` BLOCKS until readiness or that timeout, so a pattern that never prints costs you the whole timeout.
- Names are unique per project directory. A completed name MAY be started again; a live name MUST be stopped or restarted.
- `list`, `logs`, `wait`, `send`, `stop`, `restart`, and `describe` address the stable `name`.
- `logs` defaults to the last 100 lines. `head: true` reads the beginning. `grep` is a regex.
- `logs` with `follow: true` waits for output after `cursor`; reuse the returned cursor on the next call.
- `wait` blocks until readiness/exit/pattern or timeout. An exit already arrives on its own, so `wait` is for readiness or a pattern you need before the next step — never a poll loop.
- `send.text` writes stdin; `enter` defaults true. `keys` supports ENTER, TAB, ESCAPE, CTRL_C, CTRL_D, UP, DOWN, LEFT, RIGHT.
- `send.signal` supports SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGKILL. PTY input is serialized; many clients MAY observe, but writes share one input stream.
- `stop` performs graceful process-tree termination before hard-kill. `restart` reuses the retained launch spec. Neither reports an exit you asked for.
- `restart` policy defaults `no`; `on-failure` and `always` use bounded backoff.
- `persist: true` opts out of last-veyyon teardown. Otherwise the broker stops every non-persistent supervised process after the last veyyon in this directory exits.
- `detached: true` survives broker shutdown and all veyyon exits. It implies `persist`, disables PTY/stdin, and reports no exit.
</instruction>

<critical>
- Readiness MUST be observed; process creation alone is not readiness.
- Omit `persist` and `detached` unless their survival guarantees are required.
- Use `stop`; NEVER kill an unverified PID through bash.
</critical>
