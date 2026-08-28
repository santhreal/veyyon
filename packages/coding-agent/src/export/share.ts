import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentState } from "@veyyon/agent-core";
import { $which, errorMessage, isRecord, logger, trimTrailingSlashes } from "@veyyon/utils";
import { DEFAULT_SHARE_URL, sealBytes } from "@veyyon/wire";
import { $ } from "bun";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { SessionManager } from "../session/session-manager";
import { buildSessionData, type SessionData } from "./html";
import { redactSessionDataForShare } from "./redact-snapshot";

export { DEFAULT_SHARE_URL };

export const SERVER_MAX_SEALED_BYTES = 1_000_000;
const GIST_MAX_SEALED_BYTES = 5_000_000;

const SHARE_KEY_BYTES = 32;
const GIST_FILENAME = "session.veyyonshare.txt";
const GIST_ID_RE = /^[0-9a-f]{20,64}$/;

const TEXT_CAPS = [32_768, 8_192, 2_048, 512];
const BLANK_IMAGE_DATA_URL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const IMAGE_OMITTED_TEXT = "[image omitted from share]";

export type ShareStore = "blob" | "gist";

export interface ShareSessionOptions {
	serverUrl?: string;
	store?: ShareStore;
	state?: AgentState;
	obfuscator?: SecretObfuscator;
}

export interface ShareSessionResult {
	url: string;
	method: "gist" | "server";
	gistUrl?: string;
	truncated: boolean;
	sealedBytes: number;
}

export function buildShareSnapshot(sm: SessionManager, options?: ShareSessionOptions): SessionData {
	const data = buildSessionData(sm, options?.state);
	return options?.obfuscator?.hasSecrets() ? redactSessionDataForShare(options.obfuscator, data) : data;
}

export async function shareSession(sm: SessionManager, options?: ShareSessionOptions): Promise<ShareSessionResult> {
	const data = buildShareSnapshot(sm, options);
	const keyBytes = new Uint8Array(SHARE_KEY_BYTES);
	crypto.getRandomValues(keyBytes);
	const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
	const keyText = Buffer.from(keyBytes).toString("base64url");
	const base = normalizeShareServerUrl(options?.serverUrl);

	if (options?.store === "gist") {
		const forGist = await sealToFit(key, data, GIST_MAX_SEALED_BYTES);
		const gist = await tryCreateGist(forGist.sealed);
		if (gist) {
			return {
				url: `${base}/${gist.id}#${keyText}`,
				method: "gist",
				gistUrl: gist.url,
				truncated: forGist.truncated,
				sealedBytes: forGist.sealed.byteLength,
			};
		}
		return shareViaServer(key, data, base, keyText, forGist);
	}

	return shareViaServer(key, data, base, keyText);
}

export function normalizeShareServerUrl(serverUrl?: string): string {
	const base = trimTrailingSlashes((serverUrl ?? DEFAULT_SHARE_URL).trim());
	return base || DEFAULT_SHARE_URL;
}

interface SealedSession {
	sealed: Uint8Array<ArrayBuffer>;
	truncated: boolean;
}

export async function sealToFit(key: CryptoKey, data: SessionData, maxBytes: number): Promise<SealedSession> {
	let sealed = await sealSessionData(key, data);
	if (sealed.byteLength <= maxBytes) return { sealed, truncated: false };

	const working = structuredClone(data);
	stripImagePayloads(working);
	sealed = await sealSessionData(key, working);
	if (sealed.byteLength <= maxBytes) return { sealed, truncated: true };

	for (const cap of TEXT_CAPS) {
		capLongStrings(working, cap);
		sealed = await sealSessionData(key, working);
		if (sealed.byteLength <= maxBytes) return { sealed, truncated: true };
	}

	while (working.entries.length > 4) {
		working.entries = working.entries.slice(Math.ceil(working.entries.length / 2));
		sealed = await sealSessionData(key, working);
		if (sealed.byteLength <= maxBytes) return { sealed, truncated: true };
	}

	throw new Error(`Session too large to share: ${sealed.byteLength} bytes sealed exceeds the ${maxBytes} byte limit`);
}

async function sealSessionData(key: CryptoKey, data: SessionData): Promise<Uint8Array<ArrayBuffer>> {
	return sealBytes(key, Bun.gzipSync(new TextEncoder().encode(JSON.stringify(data))));
}

function stripImagePayloads(value: unknown): void {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const item: unknown = value[i];
			if (isRecord(item) && item.type === "image" && typeof item.data === "string" && item.data.length > 1024) {
				value[i] = { type: "text", text: IMAGE_OMITTED_TEXT };
				continue;
			}
			stripImagePayloads(item);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const k in value) {
		const v = value[k];
		if (typeof v === "string") {
			if (v.length > 1024 && v.startsWith("data:")) value[k] = BLANK_IMAGE_DATA_URL;
			continue;
		}
		stripImagePayloads(v);
	}
}

function capLongStrings(value: unknown, cap: number): void {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const item: unknown = value[i];
			if (typeof item === "string" && item.length > cap) value[i] = `${item.slice(0, cap)}\n…[truncated for share]`;
			else capLongStrings(item, cap);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const k in value) {
		const v = value[k];
		if (typeof v === "string") {
			if (v.length > cap) value[k] = `${v.slice(0, cap)}\n…[truncated for share]`;
			continue;
		}
		capLongStrings(v, cap);
	}
}

async function tryCreateGist(sealed: Uint8Array): Promise<{ id: string; url: string } | null> {
	if (!$which("gh")) return null;
	const auth = await $`gh auth status`.quiet().nothrow();
	if (auth.exitCode !== 0) {
		logger.debug("share: gh present but not authenticated; falling back to share server");
		return null;
	}

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-share-"));
	try {
		const file = path.join(dir, GIST_FILENAME);
		await Bun.write(file, Buffer.from(sealed).toString("base64"));
		const result = await $`gh gist create --public=false ${file}`.quiet().nothrow();
		if (result.exitCode !== 0) {
			logger.warn("share: gist creation failed; falling back to share server", {
				stderr: result.stderr.toString("utf-8").trim().slice(0, 500),
			});
			return null;
		}
		const url = result.text().trim().split("\n").pop()?.trim() ?? "";
		const id = url.split("/").pop() ?? "";
		if (!GIST_ID_RE.test(id)) {
			logger.warn("share: could not parse gist id from gh output", { url });
			return null;
		}
		return { id, url };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function shareViaServer(
	key: CryptoKey,
	data: SessionData,
	base: string,
	keyText: string,
	preFit?: SealedSession,
): Promise<ShareSessionResult> {
	const forServer =
		preFit && preFit.sealed.byteLength <= SERVER_MAX_SEALED_BYTES
			? preFit
			: await sealToFit(key, data, SERVER_MAX_SEALED_BYTES);
	const id = await uploadToServer(forServer.sealed, base);
	return {
		url: `${base}/${id}#${keyText}`,
		method: "server",
		truncated: forServer.truncated,
		sealedBytes: forServer.sealed.byteLength,
	};
}

async function uploadToServer(sealed: Uint8Array, base: string): Promise<string> {
	let res: Response;
	try {
		res = await fetch(base, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: sealed,
		});
	} catch (err) {
		throw new Error(`Share upload to ${base} failed: ${errorMessage(err)}`);
	}
	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).trim().slice(0, 200);
		throw new Error(`Share upload to ${base} failed: HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
	}
	const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
	const id = body && typeof body.id === "string" ? body.id : "";
	if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) {
		throw new Error(`Share upload to ${base} failed: server returned no usable id`);
	}
	return id;
}
