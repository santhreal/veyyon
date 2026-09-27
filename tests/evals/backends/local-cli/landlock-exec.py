#!/usr/bin/env python3
"""Run a command under a Landlock ruleset.

    python3 landlock-exec.py --abi
    python3 landlock-exec.py '<rules json>' -- <command> [args...]

`--abi` prints the kernel's Landlock ABI version and exits 0, or prints why there is none and exits 1.

The rules are `[{"path": ..., "access": "list" | "read" | "write"}]`. Beneath each path the command
lists directories (`list`), also reads and runs files (`read`), or also creates, changes and deletes
(`write`); every other file access is refused with EACCES. A path that does not exist grants nothing.
The restriction survives `exec` and binds every process the command starts. Landlock needs no
privilege and no user namespace, only a kernel built with it (5.13 or later) and enabled in its LSM
list.
"""

import ctypes
import json
import os
import stat
import sys

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38

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


def main(argv):
    if argv[1:] == ["--abi"]:
        try:
            print(abi())
        except OSError as error:
            print(f"Landlock is unavailable: {error.strerror}", file=sys.stderr)
            return 1
        return 0
    if len(argv) < 4 or argv[2] != "--":
        print("usage: landlock-exec.py --abi | '<rules json>' -- <command> [args...]", file=sys.stderr)
        return 2
    restrict(json.loads(argv[1]))
    os.execvp(argv[3], argv[3:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
