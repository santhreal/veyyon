import { formatCount } from "@veyyon/utils/format";
import * as capability from "../capability";
import { type SSHHost, sshCapability } from "../capability/ssh";
import type { SSHConnectionTarget } from "../ssh/connection-manager";
import {
	listRemoteDir,
	type RemoteDirEntry,
	type RemotePathKind,
	readRemoteFile,
	statRemotePath,
	writeRemoteFile,
} from "../ssh/file-transfer";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	UrlCompletion,
	WriteContext,
} from "./types";

const SSH_TEXT_MAX_BYTES = 1024 * 1024;

function contentTypeFor(remotePath: string): InternalResource["contentType"] {
	const slash = remotePath.lastIndexOf("/");
	const base = slash === -1 ? remotePath : remotePath.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	const ext = dot <= 0 ? "" : base.slice(dot).toLowerCase();
	if (ext === ".md") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}

function decodeUtf8Text(bytes: Uint8Array): string | null {
	if (bytes.indexOf(0) !== -1) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function remotePathFromUrl(url: InternalUrl): string {
	if (url.search) {
		throw new Error(
			`ssh:// does not support URL query strings; percent-encode a literal '?' as %3F in the path: ${url.href}`,
		);
	}
	if (url.hash) {
		throw new Error(
			`ssh:// does not support URL fragments; percent-encode a literal '#' as %23 in the path: ${url.href}`,
		);
	}
	const raw = url.rawPathname ?? url.pathname;
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		throw new Error(`Invalid URL encoding in ssh:// path: ${url.href}`);
	}
	if (!decoded) {
		throw new Error(
			"ssh:// requires an absolute path, e.g. ssh://host/etc/hosts or ssh://host/ for the root directory",
		);
	}
	return decoded;
}

async function loadConfiguredHosts(cwd?: string): Promise<SSHHost[]> {
	const { items } = await capability.loadCapability<SSHHost>(sshCapability.id, cwd ? { cwd } : {});
	return items;
}

function hostAddress(host: SSHHost): string {
	return `${host.username ? `${host.username}@` : ""}${host.host}${host.port ? `:${host.port}` : ""}`;
}

function formatHostIndex(hosts: readonly SSHHost[]): string {
	if (hosts.length === 0) {
		return "# SSH hosts\n\nNo SSH hosts are configured. Add hosts to an `ssh.json` capability file, or read `ssh://<host>/<path>` with any destination OpenSSH can resolve (e.g. a `~/.ssh/config` alias).\n";
	}
	const lines = hosts.map(host => {
		const addr = hostAddress(host);
		const suffix = addr === host.name ? "" : ` — \`${addr}\``;
		const desc = host.description ? ` (${host.description})` : "";
		return `- [${host.name}](ssh://${encodeURIComponent(host.name)}/)${suffix}${desc}`;
	});
	return `# SSH hosts\n\n${formatCount("configured host", hosts.length)}:\n\n${lines.join("\n")}\n`;
}

async function resolveTarget(url: InternalUrl, cwd?: string): Promise<SSHConnectionTarget> {
	if (!URL.canParse(url.href)) {
		throw new Error(`ssh://: invalid host or port in "${url.href}"; use ssh://host[:1-65535]/<absolute-path>`);
	}
	const bareHost = url.hostname;
	const rawAuthority = url.rawHost || bareHost;
	if (!bareHost && !rawAuthority) {
		throw new Error("ssh:// requires a host: ssh://<host>/<absolute-path>");
	}
	for (const part of [url.username, bareHost]) {
		if (part.includes("%")) {
			try {
				decodeURIComponent(part);
			} catch {
				throw new Error(`ssh://: invalid percent-escape in authority "${url.href}"`);
			}
		}
	}
	if (url.password) {
		throw new Error(
			"ssh://: password authentication is not supported; ssh:// uses key/agent auth — drop the ':<password>' from the URL",
		);
	}
	const isIpv6Literal = bareHost.startsWith("[") && bareHost.endsWith("]");
	const sshHost = isIpv6Literal ? bareHost.slice(1, -1) : bareHost;
	const username = url.username || undefined;
	const port = url.port ? Number(url.port) : undefined;
	if (port === 0) {
		throw new Error("ssh://: port 0 is not a valid SSH port; use ssh://host:<1-65535>/<path> or omit the port");
	}
	const decodeOr = (s: string): string => {
		try {
			return decodeURIComponent(s);
		} catch {
			return s;
		}
	};
	if (port === undefined && url.rawHost === `${username ? `${decodeOr(username)}@` : ""}${decodeOr(bareHost)}:`) {
		throw new Error(`ssh://: empty port in "${url.href}"; use ssh://host:<1-65535>/<path> or drop the colon`);
	}
	if (username === undefined && url.rawHost === `@${decodeOr(bareHost)}${port !== undefined ? `:${port}` : ""}`) {
		throw new Error(`ssh://: empty username in "${url.href}"; drop the leading '@' or provide a username before it`);
	}
	const canonicalAuthority = `${url.username ? `${decodeOr(url.username)}@` : ""}${decodeOr(bareHost)}${port !== undefined ? `:${port}` : ""}`;
	if (url.rawHost !== canonicalAuthority) {
		throw new Error(
			`ssh://: unsupported or malformed authority in "${url.href}"; use ssh://[user@]host[:1-65535]/<absolute-path>`,
		);
	}
	const items = await loadConfiguredHosts(cwd);

	if (username || port !== undefined) {
		const decodedBareHost = decodeOr(bareHost);
		if (items.some(entry => entry.name === bareHost || entry.name === decodedBareHost)) {
			throw new Error(
				`ssh://: user/port overrides are not allowed for the configured host "${decodedBareHost}"; use ssh://${bareHost}/<path> or an unconfigured hostname`,
			);
		}
		const sshUser = username ? decodeOr(username) : undefined;
		const sshTargetHost = decodeOr(sshHost);
		const name = `${sshUser ? `${sshUser}@` : ""}${sshTargetHost}${port !== undefined ? `:${port}` : ""}`;
		return { name, host: sshTargetHost, username: sshUser, port };
	}

	const match = items.find(entry => entry.name === rawAuthority) ?? items.find(entry => entry.name === bareHost);
	if (match) {
		return {
			name: match.name,
			host: match.host,
			username: match.username,
			port: match.port,
			keyPath: match.keyPath,
			compat: match.compat,
		};
	}
	return { name: rawAuthority, host: isIpv6Literal ? sshHost : rawAuthority };
}

function formatDirListing(entries: readonly RemoteDirEntry[]): string {
	if (entries.length === 0) return "(empty directory)";
	return entries.map(entry => `${entry.name}${entry.isDirectory ? "/" : ""}`).join("\n");
}

export class SshProtocolHandler implements ProtocolHandler {
	readonly scheme = "ssh";
	readonly immutable = false;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (!(url.rawHost || url.hostname)) {
			const rawPath = url.rawPathname ?? url.pathname;
			if (rawPath && rawPath !== "/") {
				throw new Error(
					`ssh:// requires a host before the path: ssh://<host>${rawPath} (host-less ssh://${rawPath} is not valid)`,
				);
			}
			return this.#resolveHostIndex(url, context?.cwd);
		}
		const target = await resolveTarget(url, context?.cwd);
		const remotePath = remotePathFromUrl(url);
		let kind: RemotePathKind | undefined;
		try {
			kind = await statRemotePath(target, remotePath, { signal: context?.signal });
		} catch {}
		if (kind === "directory") {
			return this.#resolveDirectory(target, remotePath, url, context?.signal, context?.skipDirectoryListing);
		}
		if (kind === "other") {
			throw new Error(
				`ssh://: ${remotePath} is not a regular file (FIFO, socket, or device); ssh:// reads UTF-8 text files only — use the ssh tool for special files`,
			);
		}
		const fileResult = await readRemoteFile(target, remotePath, {
			maxBytes: SSH_TEXT_MAX_BYTES,
			signal: context?.signal,
		});
		if (fileResult.truncated) {
			throw new Error(
				`ssh://: ${remotePath} exceeds the 1 MiB limit; ssh:// supports text files up to 1 MiB — use an sshfs mount for larger files`,
			);
		}
		const content = decodeUtf8Text(fileResult.bytes);
		if (content === null) {
			throw new Error(
				`ssh://: ${remotePath} is a binary or non-UTF-8 file; ssh:// supports UTF-8 text only — use the ssh tool or an sshfs mount`,
			);
		}
		return {
			url: url.href,
			content,
			contentType: contentTypeFor(remotePath),
			size: fileResult.bytes.length,
		};
	}

	async #resolveDirectory(
		target: SSHConnectionTarget,
		remotePath: string,
		url: InternalUrl,
		signal?: AbortSignal,
		skipListing?: boolean,
	): Promise<InternalResource> {
		const content = skipListing ? "" : formatDirListing(await listRemoteDir(target, remotePath, { signal }));
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			immutable: true,
			isDirectory: true,
		};
	}

	async #resolveHostIndex(url: InternalUrl, cwd?: string): Promise<InternalResource> {
		const content = formatHostIndex(await loadConfiguredHosts(cwd));
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			immutable: true,
		};
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const hosts = await loadConfiguredHosts(context?.cwd);
		return hosts.map(host => ({
			value: encodeURIComponent(host.name),
			label: host.name,
			description: host.description ?? hostAddress(host),
		}));
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const target = await resolveTarget(url, context?.cwd);
		const remotePath = remotePathFromUrl(url);
		await writeRemoteFile(target, remotePath, new TextEncoder().encode(content), { signal: context?.signal });
	}
}
