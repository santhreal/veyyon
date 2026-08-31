# Resource limits

Veyyon caps what the processes it runs may consume: CPU, memory, disk writes and process
count. Every limit is off by default, and each has two scopes:

|Scope|Key prefix|Covers|
|---|---|---|
|Machine|`machine.*`|Every veyyon process on this machine at once, including ones already running|
|Session|`session.*`|One session and the commands it spawns|

```yaml
machine:
  cpuLimitCores: 8      # 0 (the default) is off, at both scopes
  memoryLimitGb: 0
  writeBudgetGb: 0
  maxProcesses: 0
session:
  cpuLimitCores: 2      # this session's commands get at most two cores
  cpuLimitKill: false   # what to do past the budget; see below
  memoryLimitGb: 0
  writeBudgetGb: 0
  maxProcesses: 0
```

Set both in `/settings` under **Resources**, where the two rows for a resource sit side by
side. Machine values are written to the global configuration file, so they hold across every
project, profile and concurrently running veyyon.

A session limit alone is per session: two sessions capped at 2 cores each may use 4 between
them. A machine limit is what bounds the pair.

## How the two scopes combine

The machine scope is not a second limiter running beside the first. Session groups are created
inside the machine group, so the kernel bounds the whole subtree:

```
<delegated parent>/
└── veyyon.machine/          ← machine.* limits are written here
    ├── veyyon-<session-a>/  ← session.* limits
    └── veyyon-<session-b>/
```

One set of kernel files enforces both tiers, so they cannot disagree. A machine limit binds a
session that sets no limit of its own, and binds a session whose own limit is looser, because
the parent bounds its children. The machine group is left in place when a session ends, since
another veyyon's sessions live inside it.

Writes are counted from two places because they arrive from two places: a spawned command
writes through the kernel and appears in `io.stat`, while the file tools write in-process and
are tallied to a file inside the machine group, so concurrent veyyon processes see each
other's totals.

## What is capped

Every process a session spawns to do its work joins the budget. That covers bash commands (plain
and PTY), MCP stdio servers, the `exec` calls that custom tools, custom commands, extensions, and
hooks make, background processes from the `launch` tool, the eval kernels (Python, Ruby, Julia),
language servers, debug adapters, the managed browser, `git` and `jj`, `ssh`, and the installs
that plugins run. A capped process passes the budget to its own children, by cgroup and Job
Object inheritance on Linux and Windows and by a process-tree walk on macOS, so a build that
spawns a compiler fleet is still one budget.

A spawn is refused while the budget is saturated or the group could not be created. That applies
to a bash command, a new MCP stdio server, an `exec` call from a custom tool, custom command,
extension, or hook, and a new eval cell. An extension module the CLI loads before a session
exists resolves the root session's gate when it spawns.

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
  clipboard helper, the desktop notifier, `veyyon shell`, and the self-updater. Capping the
  updater could leave a half-written install, and killing your editor on a budget breach would
  discard unsaved text.
- **Threads rather than processes.** The browser tab supervisor and the JavaScript eval context
  run as Bun Workers inside the harness process, and a cgroup holds processes, not threads of one.
- **Processes the session did not start.** Attaching to a browser that is already running adopts
  nothing, because the session does not own that process.

If you cap a session at 1 core, veyyon stays responsive while the build under it crawls.

## How it is enforced

Each control file below is written on the group for the scope that declares it, so the machine
and session tiers use the same mechanism one directory apart:

|Setting|Enforced by|
|---|---|
|`cpuLimitCores`|`cpu.max` on the group|
|`memoryLimitGb`|`memory.max` on the group|
|`maxProcesses`|`pids.max` on the group; the fork itself is refused|
|`writeBudgetGb`|`io.stat` on the group plus the harness write tally|

Where the operating system offers a per-group CPU quota, the kernel does the capping:

- **Linux** uses a cgroup v2 directory per session with `cpu.max` set to the core count. A
  positive budget smaller than one microsecond of the 100ms period writes `1 100000`, not a freeze
  quota of `0`. If the harness's own cgroup is not writable, veyyon starts a delegated transient
  **service** in the systemd user manager (`Delegate=yes`, `CPUQuota`) and adopts children into that
  cgroup. It is not a `--scope` unit: a scope would block on the placeholder and leave setup failed.
  A positive `CPUQuota` too small for systemd to express floors at `0.001%` rather than `0%`.
- **Windows** uses an unnamed Job Object with a hard CPU rate cap. `CpuRate` is a fraction of
  **host** logical processors (4 cores on a 16-processor machine is 2500, not 40000), counted with
  `GetActiveProcessorCount` rather than this process's affinity mask, so a 2-core budget inside a
  2-of-16 slice is 12.5% of the machine rather than 100%. Setting the limit to 0, or
  `/cpu-limit lift`, turns rate control off rather than flooring to 0.01% of the machine.

A once-per-second watcher reads the group's usage on top of the kernel cap. When usage stays
pinned at the budget for about three seconds, new commands are rejected with an error that names
the budget, the measured usage, and the fix (raise `session.cpuLimitCores` or wait), until usage
drops. The kernel cap is the enforcement of last resort: if the watcher lags, commands throttle,
they never run free.

With `session.cpuLimitKill: true`, a sustained breach sends SIGTERM to the group's processes,
then SIGKILL on the next watcher tick if they are still over budget. The kill is reported as a
budget action: the notice and the killed command's result both state the command was stopped by
the CPU budget, not that it crashed.

**macOS has no per-group CPU quota.** There the budget is policy only: new commands are rejected
while the group is saturated, running members (including descendants of the adopted child, so a
`make -j` compiler fleet is in the same set) are reniced, and `session.cpuLimitKill` still
kills. Nothing throttles. The settings row and the startup warning state this, and the same
warning appears on any platform where no backend works. A configured limit never fails silently:
if the group cannot be created, new commands are refused rather than run uncapped.

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
idle. While the build runs flat out, another command is rejected:

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

## Reading and lifting limits

`/cpu-limit` reports; it does not configure. Limits are set in `/settings` under Resources.

|Command|Effect|
|---|---|
|`/cpu-limit`, `/cpu-limit status`|Report both scopes, the values in force and what is enforcing them|
|`/cpu-limit lift`|Drop this session's CPU cap for the rest of the session|
|`/cpu-limit reset`|Drop the session override and return to the configured value|

`lift` writes nothing to disk: the configured value returns on the next session. It does not
reach a machine limit, which belongs to every session at once.

## Related

- [Approvals](./sandbox.md)
- [Non-interactive mode](./exec.md)
- [Settings reference](../reference/settings-reference.md)
