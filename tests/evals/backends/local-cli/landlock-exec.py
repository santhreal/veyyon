#!/usr/bin/env python3
"""Run a command under a Landlock ruleset, and end everything it started when it exits.

    python3 landlock-exec.py --abi
    python3 landlock-exec.py '<rules json>' -- <command> [args...]
    python3 landlock-exec.py --no-rules -- <command> [args...]

`--abi` prints the kernel's Landlock ABI version and exits 0, or prints why there is none and exits 1.

The rules are `[{"path": ..., "access": "list" | "read" | "write"}]`. Beneath each path the command
lists directories (`list`), also reads and runs files (`read`), or also creates, changes and deletes
(`write`); every other file access is refused with EACCES. A path that does not exist grants nothing.
The restriction binds this process and every process the command starts. Landlock needs no
privilege and no user namespace, only a kernel built with it (5.13 or later) and enabled in its LSM
list. `--no-rules` applies none, on a host without Landlock, and keeps what follows.

The command runs as a child of this process, which is a child subreaper: a process the command
starts in a session of its own (a browser a launcher detaches, a daemon that calls setsid) is
reparented here when its parent exits instead of to init. When the command exits, every process
left under this one is killed and reaped, and this process exits with the command's status. SIGTERM,
SIGINT and SIGHUP are passed to the command, which is killed if it has not exited after
KILL_AFTER_SEC.
"""

import ctypes
import json
import os
import signal
import stat
import sys

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38
PR_SET_CHILD_SUBREAPER = 36

# Shorter than the runner's own SIGTERM grace, so the command is killed and its descendants ended
# here before the runner kills this process.
KILL_AFTER_SEC = 1.5

# Passed to the command. Blocked from before the fork until each process has its handlers, so one
# arriving in between is held rather than killing this process and orphaning the command.
FORWARDED = {signal.SIGTERM, signal.SIGINT, signal.SIGHUP}

EXECUTE = 1 << 0
WRITE_FILE = 1 << 1
READ_FILE = 1 << 2
READ_DIR = 1 << 3
REFER = 1 << 13
TRUNCATE = 1 << 14
IOCTL_DEV = 1 << 15
READ = EXECUTE | READ_FILE | READ_DIR
# The only rights a rule on a file rather than a directory may hold.
FILE_RIGHTS = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def failed(call):
    error = ctypes.get_errno()
    return OSError(error, f"{call}: {os.strerror(error)}")


def abi():
    version = libc.syscall(
        SYS_LANDLOCK_CREATE_RULESET, None, ctypes.c_size_t(0), ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION)
    )
    if version < 0:
        raise failed("landlock_create_ruleset")
    return version


def handled_rights(version):
    """Every filesystem right the kernel's ABI knows: ABI 1 has bits 0-12, 2 adds REFER, 3 TRUNCATE, 5 IOCTL_DEV."""
    rights = (1 << 13) - 1
    if version >= 2:
        rights |= REFER
    if version >= 3:
        rights |= TRUNCATE
    if version >= 5:
        rights |= IOCTL_DEV
    return rights


def restrict(rules):
    handled = handled_rights(abi())
    attr = RulesetAttr(handled)
    ruleset = libc.syscall(
        SYS_LANDLOCK_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)), ctypes.c_uint32(0)
    )
    if ruleset < 0:
        raise failed("landlock_create_ruleset")
    for rule in rules:
        try:
            fd = os.open(rule["path"], os.O_PATH | os.O_CLOEXEC)
        except FileNotFoundError:
            continue
        try:
            rights = {"list": READ_DIR, "read": READ, "write": handled}[rule["access"]]
            if not stat.S_ISDIR(os.fstat(fd).st_mode):
                rights &= FILE_RIGHTS
            if rights == 0:
                continue
            beneath = PathBeneathAttr(rights & handled, fd)
            if libc.syscall(SYS_LANDLOCK_ADD_RULE, ctypes.c_int(ruleset), ctypes.c_int(LANDLOCK_RULE_PATH_BENEATH),
                            ctypes.byref(beneath), ctypes.c_uint32(0)) != 0:
                raise failed(f"landlock_add_rule {rule['path']}")
        finally:
            os.close(fd)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise failed("prctl(PR_SET_NO_NEW_PRIVS)")
    if libc.syscall(SYS_LANDLOCK_RESTRICT_SELF, ctypes.c_int(ruleset), ctypes.c_uint32(0)) != 0:
        raise failed("landlock_restrict_self")
    os.close(ruleset)


def children():
    """The processes whose parent is this one, read from /proc."""
    me = os.getpid()
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as file:
                line = file.read()
        except OSError:
            continue
        # The parent pid is the second field after the parenthesised command name.
        if int(line[line.rfind(")") + 2:].split()[1]) == me:
            found.append(int(entry))
    return found


def end_descendants():
    """Kill and reap every process under this one. Each killed process's children are reparented
    here, so the loop ends once nothing is left to wait for."""
    while True:
        for pid in children():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.waitpid(-1, 0)
        except ChildProcessError:
            return


def run(command):
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        raise failed("prctl(PR_SET_CHILD_SUBREAPER)")
    signal.pthread_sigmask(signal.SIG_BLOCK, FORWARDED)
    agent = os.fork()
    if agent == 0:
        # The command starts with the default handlers; a signal held since the fork arrives now.
        signal.pthread_sigmask(signal.SIG_UNBLOCK, FORWARDED)
        try:
            os.execvp(command[0], command)
        except OSError as error:
            print(f"cannot run {command[0]}: {error.strerror}", file=sys.stderr)
            os._exit(127)

    def kill_agent(_signum, _frame):
        try:
            os.kill(agent, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def forward(signum, _frame):
        try:
            os.kill(agent, signum)
        except ProcessLookupError:
            pass
        signal.setitimer(signal.ITIMER_REAL, KILL_AFTER_SEC)

    signal.signal(signal.SIGALRM, kill_agent)
    for signum in FORWARDED:
        signal.signal(signum, forward)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, FORWARDED)
    _, status = os.waitpid(agent, 0)
    signal.setitimer(signal.ITIMER_REAL, 0)
    end_descendants()
    code = os.waitstatus_to_exitcode(status)
    return code if code >= 0 else 128 - code


def main(argv):
    if argv[1:] == ["--abi"]:
        try:
            print(abi())
        except OSError as error:
            print(f"Landlock is unavailable: {error.strerror}", file=sys.stderr)
            return 1
        return 0
    if len(argv) < 4 or argv[2] != "--":
        print("usage: landlock-exec.py --abi | '<rules json>' -- <command> [args...] | --no-rules -- <command> [args...]",
              file=sys.stderr)
        return 2
    if argv[1] != "--no-rules":
        restrict(json.loads(argv[1]))
    return run(argv[3:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
