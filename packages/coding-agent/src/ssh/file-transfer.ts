/** Byte-preserving remote file I/O over the shared SSH ControlMaster connection. Unlike `executeSSH` (which truncates/sanitizes through an OutputSink) and */
import * as ptree from "@veyyon/utils/ptree";
import { primarySessionCpuAdoption } from "../session/cpu-limit";
import { scopedTimeoutSignal } from "../utils/fetch-timeout";
import { buildRemoteCommand, ensureConnection, ensureHostInfo, type SSHConnectionTarget } from "./connection-manager";
import { quotePosixPath, wrapInPosixShell } from "./utils";

/** Per-operation timeout for remote transfers (matches the ssh tool's grep window). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Ensure the ControlMaster connection and pick the verified POSIX shell to run transfer commands under. Returns the shell name so the caller can */
async function ensurePosixRemote(target: SSHConnectionTarget): Promise<"sh" | "bash" | "zsh"> {
	await ensureConnection(target);
	const info = await ensureHostInfo(target);
	if (info.os === "windows") {
		throw new Error(
			`ssh://: ${target.name} is a Windows host; ssh:// supports POSIX remotes only (head/cat/mv) — use the ssh tool for Windows hosts`,
		);
	}
	if (!info.transferShell) {
		throw new Error(
			`ssh://: ${target.name} has no verified POSIX shell for ssh:// read/write — none of sh/bash/zsh round-tripped a capability probe (use the ssh tool for this host)`,
		);
	}
	return info.transferShell;
}

export interface RemoteFileReadOptions {
	/** Maximum bytes to materialize; the helper fetches one extra byte to detect truncation. */
	maxBytes: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface RemoteFileReadResult {
	/** Raw file bytes, capped at `maxBytes`. */
	bytes: Uint8Array;
	/** True when the remote file was larger than `maxBytes` (`bytes` is the prefix). */
	truncated: boolean;
}

export interface RemoteFileWriteOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Read a remote file's raw bytes. Fetches `maxBytes + 1` so the caller can distinguish an exactly-`maxBytes` file from a larger (truncated) one. */
export async function readRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: RemoteFileReadOptions,
): Promise<RemoteFileReadResult> {
	const shell = await ensurePosixRemote(target);
	const command = `head -c ${opts.maxBytes + 1} ${quotePosixPath(remotePath)}`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command));
	// Scoped so the deadline timer is cleared on settle instead of staying
	// armed like a bare AbortSignal.timeout.
	const opTimeout = scopedTimeoutSignal(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
	try {
		using child = ptree.spawn(["ssh", ...args], {
			signal: opTimeout.signal,
			onSpawnPid: primarySessionCpuAdoption(),
		});
		// Drain stdout before awaiting exit so a full pipe can't deadlock the child.
		const raw = await child.bytes();
		await child.exitedCleanly;
		const truncated = raw.length > opts.maxBytes;
		return { bytes: truncated ? raw.subarray(0, opts.maxBytes) : raw, truncated };
	} finally {
		opTimeout.cancel();
	}
}

/** Write `content` to a remote file byte-exact. Stdin is always staged first into a uniquely named temp in the destination directory (so the remote never blocks */
export async function writeRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	content: Uint8Array,
	opts: RemoteFileWriteOptions,
): Promise<void> {
	const shell = await ensurePosixRemote(target);
	if (remotePath.endsWith("/")) {
		throw new Error("ssh://: destination is a directory path (trailing '/'); ssh:// write requires a file path");
	}
	const dest = quotePosixPath(remotePath);
	const tmp = quotePosixPath(`${remotePath}.veyyon-tmp.${crypto.randomUUID()}`);
	// Stage stdin into the temp first (so the remote never blocks on an unread pipe and a dropped connection lands in the temp, never the destination).
	const command =
		`t=${tmp}; trap 'rm -f -- "$t"' 0; ` +
		`mkdir -p -- "$(dirname "$t")" && ` +
		`cat > "$t" && { ` +
		`if [ -d ${dest} ]; then echo 'ssh://: destination is a directory' >&2; exit 1; ` +
		`elif [ -f ${dest} ] && [ ! -L ${dest} ]; then cat "$t" > ${dest} || exit 1; ` +
		`elif [ -e ${dest} ] && [ ! -L ${dest} ]; then echo 'ssh://: destination is a special file (not a regular file)' >&2; exit 1; ` +
		`else mv "$t" ${dest}; fi; ` +
		`}`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command), { allowStdin: true });
	const opTimeout = scopedTimeoutSignal(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
	try {
		using child = ptree.spawn(["ssh", ...args], {
			stdin: content,
			signal: opTimeout.signal,
			onSpawnPid: primarySessionCpuAdoption(),
		});
		await child.exitedCleanly;
	} finally {
		opTimeout.cancel();
	}
}

/** Classification of a remote path, used by the read handler's directory dispatch. */
export type RemotePathKind = "file" | "directory" | "other" | "missing";

/** Classify a remote path with POSIX `test` (portable across Linux/BSD/macOS): `directory`, regular `file`, `other` (special file), or `missing`. */
export async function statRemotePath(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RemotePathKind> {
	const shell = await ensurePosixRemote(target);
	const p = quotePosixPath(remotePath);
	const command = `if [ -d ${p} ]; then echo directory; elif [ -f ${p} ]; then echo file; elif [ -e ${p} ]; then echo other; else echo missing; fi`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command));
	const opTimeout = scopedTimeoutSignal(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
	try {
		using child = ptree.spawn(["ssh", ...args], {
			signal: opTimeout.signal,
			onSpawnPid: primarySessionCpuAdoption(),
		});
		const out = new TextDecoder().decode(await child.bytes()).trim();
		await child.exitedCleanly;
		return out === "directory" || out === "file" || out === "other" ? out : "missing";
	} finally {
		opTimeout.cancel();
	}
}

/** A single entry in a remote directory listing. */
export interface RemoteDirEntry {
	/** Entry name (no path component), trailing `/` stripped. */
	name: string;
	/** True when the entry is a directory. */
	isDirectory: boolean;
}

/** List a remote directory one level deep with `ls -1Ap` (one per line; all entries incl. dotfiles but not `.`/`..`; trailing `/` marks directories). */
export async function listRemoteDir(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RemoteDirEntry[]> {
	const shell = await ensurePosixRemote(target);
	const command = `LC_ALL=C ls -1Ap -- ${quotePosixPath(remotePath)}`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command));
	const opTimeout = scopedTimeoutSignal(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
	let text: string;
	try {
		using child = ptree.spawn(["ssh", ...args], {
			signal: opTimeout.signal,
			onSpawnPid: primarySessionCpuAdoption(),
		});
		text = new TextDecoder().decode(await child.bytes());
		await child.exitedCleanly;
	} finally {
		opTimeout.cancel();
	}
	const entries = text
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => {
			const isDirectory = line.endsWith("/");
			return { name: isDirectory ? line.slice(0, -1) : line, isDirectory };
		});
	// JS sort is the order contract (mirrors buildDirectoryResource): dirs first, then by name.
	entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
	return entries;
}
