import * as ptree from "@veyyon/utils/ptree";
import { primarySessionCpuAdoption } from "../session/cpu-limit";
import { scopedTimeoutSignal } from "../utils/fetch-timeout";
import { buildRemoteCommand, ensureConnection, ensureHostInfo, type SSHConnectionTarget } from "./connection-manager";
import { quotePosixPath, wrapInPosixShell } from "./utils";

const DEFAULT_TIMEOUT_MS = 30_000;

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
	maxBytes: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface RemoteFileReadResult {
	bytes: Uint8Array;
	truncated: boolean;
}

export interface RemoteFileWriteOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export async function readRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: RemoteFileReadOptions,
): Promise<RemoteFileReadResult> {
	const shell = await ensurePosixRemote(target);
	const command = `head -c ${opts.maxBytes + 1} ${quotePosixPath(remotePath)}`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command));
	const opTimeout = scopedTimeoutSignal(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
	try {
		using child = ptree.spawn(["ssh", ...args], {
			signal: opTimeout.signal,
			onSpawnPid: primarySessionCpuAdoption(),
		});
		const raw = await child.bytes();
		await child.exitedCleanly;
		const truncated = raw.length > opts.maxBytes;
		return { bytes: truncated ? raw.subarray(0, opts.maxBytes) : raw, truncated };
	} finally {
		opTimeout.cancel();
	}
}

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

export type RemotePathKind = "file" | "directory" | "other" | "missing";

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

export interface RemoteDirEntry {
	name: string;
	isDirectory: boolean;
}

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
	entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
	return entries;
}
