/**
 * The session-scoped store every eval kernel shares, on disk next to the session's artifacts.
 *
 * WHY THIS EXISTS. An eval kernel dies with its owning agent session, and a goal that spans
 * continuations cycles sessions, so a value that exists only in a kernel namespace is lost at every
 * continuation: a CDP helper, an ephemeral OAST callback handle. Re-creating some values is not
 * possible (the handle names a live callback the target already knows), and writing them to the
 * target repository leaks them. This store is the place those values go: keyed by the session,
 * addressed from inside a kernel by name only, so the value itself never transits a tool argument
 * or a transcript.
 *
 * The file is JSON on purpose: the JavaScript, Python, Ruby and Julia kernels all read the same
 * store, so a handle saved from one language is loadable from another. Writes are atomic (temp
 * file + rename) and last-writer-wins; two kernels racing one key get a whole-file winner, never
 * a torn file.
 *
 * The format is versioned. A store whose version this code does not understand is refused, not
 * served: a stale shape after an upgrade must fail loud rather than hand back half-parsed values.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { atomicWriteFile } from "@veyyon/utils/atomic-write";
import { withFileLock } from "@veyyon/utils/file-lock";
import { isEnoent } from "@veyyon/utils/fs-error";
import { errorMessage } from "@veyyon/utils/type-guards";

const STORE_VERSION = 1;
/** A single value above this is refused: the store is for handles and small state, not payloads. */
export const KV_VALUE_SIZE_LIMIT = 256 * 1024;
/** The whole store above this is refused: it rides no hot path, but a runaway loop should not grow it. */
export const KV_STORE_SIZE_LIMIT = 4 * 1024 * 1024;

export interface KernelStore {
	/** Absolute path of the backing file, for diagnostics. Never printed with values. */
	readonly filePath: string;
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	/** Key names only: listing must never move a value into a log line or a status event. */
	list(): Promise<string[]>;
}

interface StoreFile {
	version: number;
	values: Record<string, unknown>;
}

export class KernelStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KernelStoreError";
	}
}
export function sessionStoreFileName(sessionId: string): string {
	const prefix = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 32);
	const hash = createHash("sha256").update(sessionId, "utf8").digest("hex");
	return prefix.length > 0 ? `${prefix}_${hash}.json` : `${hash}.json`;
}

function assertKey(key: string): void {
	if (typeof key !== "string" || key.length === 0 || key.length > 256 || /[\\/\0]/.test(key)) {
		throw new KernelStoreError("kv keys are 1-256 characters and contain no path separators or NUL bytes");
	}
}

function assertSerializable(value: unknown): string {
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch (error) {
		throw new KernelStoreError(
			`kv values must be JSON-serializable; this one is not (${errorMessage(error)}). ` +
				"Store the handle or token, not the live object.",
		);
	}
	if (encoded === undefined) {
		throw new KernelStoreError(
			"kv values must be JSON-serializable; undefined and functions are not. Store the handle or token.",
		);
	}
	if (encoded.length > KV_VALUE_SIZE_LIMIT) {
		throw new KernelStoreError(
			`kv value is ${encoded.length} bytes, over the ${KV_VALUE_SIZE_LIMIT}-byte limit. Write payloads to a file and store the path.`,
		);
	}
	return encoded;
}

async function readFile(filePath: string): Promise<StoreFile> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf-8");
	} catch (error) {
		if (isEnoent(error)) {
			return { version: STORE_VERSION, values: Object.create(null) as Record<string, unknown> };
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new KernelStoreError(
			`${filePath} is not valid JSON; move it aside and the next write starts a fresh store`,
		);
	}
	const file = parsed as Partial<StoreFile>;
	if (
		file?.version !== STORE_VERSION ||
		typeof file.values !== "object" ||
		file.values === null ||
		Array.isArray(file.values)
	) {
		throw new KernelStoreError(
			`${filePath} is a kernel store of an unrecognized shape or version; move it aside and the next write starts a fresh store`,
		);
	}
	const values = Object.create(null) as Record<string, unknown>;
	for (const key of Object.keys(file.values)) {
		values[key] = (file.values as Record<string, unknown>)[key];
	}
	return { version: STORE_VERSION, values };
}

async function writeFile(filePath: string, values: Record<string, unknown>): Promise<void> {
	const body = JSON.stringify({ version: STORE_VERSION, values } satisfies StoreFile);
	if (body.length > KV_STORE_SIZE_LIMIT) {
		throw new KernelStoreError(
			`the kernel store would grow to ${body.length} bytes, over the ${KV_STORE_SIZE_LIMIT}-byte limit. Delete keys you no longer need.`,
		);
	}
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await atomicWriteFile(filePath, body);
}

/**
 * Open the store for one session under `root` (the session's artifacts directory). The session id
 * is the whole scope: two sessions never share a file, and a subagent that should share uses its
 * parent's id, the same rule the artifact manager already follows.
 */
export function openKernelStore(root: string, sessionId: string): KernelStore {
	if (root.length === 0 || sessionId.length === 0) {
		throw new KernelStoreError(
			"the kernel store needs a session artifacts directory and a session id; this session has neither",
		);
	}
	const fileName = sessionStoreFileName(sessionId);
	const filePath = path.join(root, "kernel-store", fileName);
	return {
		filePath,
		get: async key => {
			assertKey(key);
			const file = await readFile(filePath);
			return Object.hasOwn(file.values, key) ? file.values[key] : undefined;
		},
		set: async (key, value) => {
			assertKey(key);
			assertSerializable(value);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await withFileLock(filePath, async () => {
				const file = await readFile(filePath);
				file.values[key] = value;
				await writeFile(filePath, file.values);
			});
		},
		delete: async key => {
			assertKey(key);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			return await withFileLock(filePath, async () => {
				const file = await readFile(filePath);
				if (!Object.hasOwn(file.values, key)) return false;
				delete file.values[key];
				await writeFile(filePath, file.values);
				return true;
			});
		},
		list: async () => {
			const file = await readFile(filePath);
			return Object.keys(file.values).sort();
		},
	};
}
