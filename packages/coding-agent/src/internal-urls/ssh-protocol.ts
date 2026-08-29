import type { SSHConnectionTarget } from "../ssh/connection-manager";
import {
	listRemoteDir,
	type RemotePathKind,
	readRemoteFile,
	statRemotePath,
	writeRemoteFile,
} from "../ssh/file-transfer";
import {
	contentTypeFor,
	decodeUtf8Text,
	formatDirListing,
	formatHostIndex,
	hostAddress,
	loadConfiguredHosts,
	remotePathFromUrl,
	resolveTarget,
	SSH_TEXT_MAX_BYTES,
} from "./ssh-protocol-helpers";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	UrlCompletion,
	WriteContext,
} from "./types";

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
