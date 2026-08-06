# CPU limits

A CPU limit caps how much processor time the processes a session spawns may use. You set it in
cores: `session.cpuLimitCores: 2` lets the session's commands consume at most two cores, no matter
how many the machine has. The limit is per session, not per machine: two sessions capped at 2
cores each may use 4 between them. There is no cross-session cap, by design.

Two settings drive it:

```yaml
session:
  cpuLimitCores: 2      # 0 (the default) is off
  cpuLimitKill: false   # what to do past the budget; see below
```

## What is capped

Every process a session spawns to do its work joins the budget. That covers bash commands (plain
and PTY), MCP stdio servers, the `exec` calls that custom tools, custom commands, and extensions
make, background processes from the `launch` tool, the eval kernels (Python, Ruby, Julia),
language servers, debug adapters, the managed browser, `git` and `jj`, `ssh`, and the installs
that plugins run. A capped process passes the budget to its own children, so a build that spawns
a compiler fleet is still one budget.

Some processes belong to no single session and join the root session's budget instead. Those are
the shared harness workers, such as the tiny title model and embeddings, and the speech capture
and playback helpers.

Five kinds of process stay outside the budget. Each is outside for a reason rather than by
oversight:

- **Anything that starts before a session exists.** Host capability probes, the shell environment
  snapshot, model provider probes, and the ssh bootstrap for a remote auth broker all run when
  there is no budget to join.
- **The harness itself.** Agent turns, the TUI, and the relaunch that replaces the veyyon process.
- **Programs that are yours rather than the agent's.** The editor veyyon opens a file in, the
  clipboard helper, `veyyon shell`, and the self-updater. Capping the updater could leave a
  half-written install, and killing your editor on a budget breach would discard unsaved text.
- **Threads rather than processes.** The browser tab supervisor and the JavaScript eval context
  run as Bun Workers inside the harness process, and a cgroup holds processes, not threads of one.
- **Processes the session did not start.** Attaching to a browser that is already running adopts
  nothing, because the session does not own that process.

If you cap a session at 1 core, veyyon stays responsive while the build under it crawls.

## How it is enforced

Where the operating system offers a per-group CPU quota, the kernel does the capping:

- **Linux** uses a cgroup v2 directory per session with `cpu.max` set to the core count. If the
  harness's own cgroup is not writable, veyyon asks the systemd user manager for a scope with
  `CPUQuota` instead.
- **Windows** uses a Job Object with a hard CPU rate cap.

A once-per-second watcher reads the group's usage on top of the kernel cap. When usage stays
pinned at the budget for about three seconds, new commands are refused with an error that names
the budget, the measured usage, and the fix (raise `session.cpuLimitCores` or wait), until usage
drops. The kernel cap is the enforcement of last resort: if the watcher lags, commands throttle,
they never run free.

With `session.cpuLimitKill: true`, a sustained breach also sends SIGTERM to the group's
processes. The kill is reported as a budget action: the notice and the killed command's result
both say the command was stopped by the CPU budget, not that it crashed.

**macOS has no per-group CPU quota.** There the budget is policy only: new commands are refused
while the group is saturated, running members are reniced, and `session.cpuLimitKill` still
kills. Nothing throttles. The settings row and the startup warning say this, and the same
warning appears on any platform where no backend works. A configured limit never fails silently.

Changing `session.cpuLimitCores` mid-session takes effect on the next command: the live quota is
rewritten, and setting it back to 0 lifts it.

## Example

Cap a session to 2 cores and run a parallel build:

```yaml
# ~/.veyyon/profiles/<profile>/agent/config.yml
session:
  cpuLimitCores: 2
```

```
$ veyyon
> run make -j16 and watch the load
```

`make` spawns sixteen compilers, but the whole tree shares two cores: the build takes roughly
eight times longer than uncapped wall time would suggest, and the rest of the machine stays
idle. While the build runs flat out, another command is refused:

```
Refused to start a bash command: this session's CPU budget of 2 core(s) is saturated
(spawned commands used ~2.00 cores for the last 3s). New commands run again once usage
drops below the budget. Fix: wait for the running command to finish, or raise
session.cpuLimitCores.
```

With `session.cpuLimitKill: true`, the same breach ends the build instead:

```
Session CPU budget exceeded: limit 2 core(s), spawned commands used ~2.00 cores for 3s.
Sent SIGTERM to 9 process(es) because session.cpuLimitKill is on. A command that just
stopped was killed by the CPU budget, not a crash.
```

## Related

- [Approvals](./sandbox.md)
- [Non-interactive mode](./exec.md)
- [Settings reference](../../../settings-reference.md)
