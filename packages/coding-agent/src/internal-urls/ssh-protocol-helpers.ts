import { formatCount } from "@veyyon/utils/format";
import * as capability from "../capability";
import { type SSHHost, sshCapability } from "../capability/ssh";
import type { SSHConnectionTarget } from "../ssh/connection-manager";
import type { RemoteDirEntry } from "../ssh/file-transfer";
import type { InternalResource, InternalUrl } from "./types";

export const SSH_TEXT_MAX_BYTES = 1024 * 1024;

export function contentTypeFor(remotePath: string): InternalResource["contentType"] {
	const slash = remotePath.lastIndexOf("/");
	const base = slash === -1 ? remotePath : remotePath.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	const ext = dot <= 0 ? "" : base.slice(dot).toLowerCase();
	if (ext === ".md") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}

export function decodeUtf8Text(bytes: Uint8Array): string | null {
	if (bytes.indexOf(0) !== -1) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

export function remotePathFromUrl(url: InternalUrl): string {
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

export async function loadConfiguredHosts(cwd?: string): Promise<SSHHost[]> {
	const { items } = await capability.loadCapability<SSHHost>(sshCapability.id, cwd ? { cwd } : {});
	return items;
}

export function hostAddress(host: SSHHost): string {
	return `${host.username ? `${host.username}@` : ""}${host.host}${host.port ? `:${host.port}` : ""}`;
}

export function formatHostIndex(hosts: readonly SSHHost[]): string {
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

export async function resolveTarget(url: InternalUrl, cwd?: string): Promise<SSHConnectionTarget> {
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

export function formatDirListing(entries: readonly RemoteDirEntry[]): string {
	if (entries.length === 0) return "(empty directory)";
	return entries.map(entry => `${entry.name}${entry.isDirectory ? "/" : ""}`).join("\n");
}
