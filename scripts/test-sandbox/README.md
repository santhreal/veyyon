# The test sandbox

Every `bun test` in this repo runs inside a kernel boundary that does not contain your
home directory. This directory is the whole of that machinery.

You do not normally call anything here by hand. `bun run test` goes through it.

```
scripts/test-sandbox/
  run.sh                 the entry point, and the ladder that picks a boundary
  rungs/                 one file per boundary: remote, docker, microvm, bwrap
  guest/                 the userland every rung boots, and the script that builds it
  leak-proof.sh          the red run that tries to break out and must fail
  find-test-leaks.ts     a static check for suites that would write to a real home
  rung-contract.test.ts  the suite that holds run.sh to the contract below
```

## Why it exists

The first defence was a bunfig preload that moved `HOME` and armed a write tripwire. It
only applies to `bun test` runs that load bunfig. A standalone script has neither, and a
bare config directory name gets joined onto `os.homedir()`, so a new name creates a
directory in your real home. There were 136 stray `.veyyon*` directories in one home by
the time this was written.

A boundary a test process can talk its way past is not a boundary. So the defence is the
kernel: a namespace or a virtual machine whose mount table has no entry that resolves to
your home.

## The rungs

Rungs are tried in order. Each one is a kernel boundary and each one passes the same
hostile-write proof in `leak-proof.sh`.

| rung | boundary | where |
| --- | --- | --- |
| `remote` | container, `--network none`, no home bind | another machine on the LAN |
| `docker` | the same, locally | this machine |
| `microvm` | separate kernel, virtiofs repo, tmpfs overlay | this machine |
| `bwrap` | mount and user namespace | this machine |

`remote` is first on a workstation and absent on a GitHub runner. That is what keeps a
local test run off your CPU: it costs an rsync and an ssh session instead of the whole
suite. A runner keeps the local-first order, because it is already a disposable machine
and has no route to the remote host.

`microvm` is the strongest boundary and it is not the default. Measured on this
workstation it adds 2.1s of boot and roughly 10x on small-file reads, because virtiofsd
1.10 serves exactly one request queue. That changes test outcomes, not just timings, and
a sandbox that turns green suites red is one people switch off. Select it deliberately
with `--rung=microvm`.

`bwrap` does not work on this workstation. Bubblewrap is installed and the sysctl says
unprivileged user namespaces are enabled, but AppArmor refuses the `uid_map` write. The
probe therefore runs bubblewrap rather than looking for it on `PATH`, because the sysctl
advertises a capability the host does not grant.

## The contract

These four properties are what everything else depends on, and
`rung-contract.test.ts` holds `run.sh` to them.

1. Rungs are tried in order, and an unavailable rung prints the exact reason before the
   next one is tried. Never a silent drop.
2. A rung pinned with `--rung=` or `VEYYON_SANDBOX_RUNG` that is unavailable is a nonzero
   exit. Never a substitution onto a weaker boundary.
3. If no rung works, the command does not run. Not on the host, not anywhere.
4. The guest exports `VEYYON_TEST_SANDBOX=<rung id>`, and the test bootstrap refuses to
   run without it.

The marker is a fast pre-check only. The bootstrap gate also reads the filesystem and
proves your home is unreachable, so exporting the variable by hand gets you nowhere.

## Commands

```sh
bash scripts/test-sandbox/run.sh bun test <paths>   # run a suite in the first available rung
bash scripts/test-sandbox/run.sh --probe            # the rung table, with reasons
bash scripts/test-sandbox/run.sh --build            # build the guest for the selected rung
bash scripts/test-sandbox/run.sh --rung=docker ...  # pin a rung
bash scripts/test-sandbox/leak-proof.sh             # the red run, every available rung
```

Package scripts wrap the common ones: `test:sandbox:probe`, `test:sandbox:build`,
`test:sandbox:remote:build`, `test:sandbox:proof`.

## The remote rung

Set `VEYYON_SANDBOX_REMOTE_HOST=<user>@<host-or-address>` to enable it; there is no
default host, and without the variable the rung reports itself unavailable. It syncs the
work tree there with rsync, honouring `.gitignore`, then runs the container on that
machine. The first sync moves about 490 MB and takes ten seconds; later ones take under a
second because rsync only ships the difference. `VEYYON_SANDBOX_REMOTE_KEY` picks the ssh
key, defaulting to `~/.ssh/id_ed25519`.

Dependencies are installed in a separate networked container keyed on the lockfile hash,
so the test container itself still runs with `--network none`.

What the remote is protected from is enumerated at the top of `rungs/remote.sh`: the
remote home, root, privilege escalation, unbounded CPU and memory, wedged containers, and
the sync ever deleting anything outside the tree it owns. Read that list before changing
the rung.

To build the guest image on the remote:

```sh
bun run test:sandbox:remote:build
```

## Changing a rung

Add or edit a file in `rungs/`. Each defines `probe_<id>`, `run_<id>` and
`binprobe_<id>`, and reads `REPO_ROOT`, `GUEST_REPO`, `HOST_HOME` and `GUEST_IMAGE` from
the driver. Add the id to `KNOWN_RUNGS` in `run.sh` and to `MARKER_BY_RUNG` in
`rung-contract.test.ts`.

Then run the proof. A rung that has not been through `leak-proof.sh` is not a rung.

```sh
bash scripts/test-sandbox/leak-proof.sh <your-rung>
```
