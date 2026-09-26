/**
 * A browser context's session as a file: its cookies and each origin's localStorage, in the shape
 * Playwright's `storageState` writes, so a state file from either tool loads in the other.
 *
 * Capture reads the context, not one page: every cookie the context holds, on every domain, and the
 * localStorage of every http(s) origin a page or frame of the context has open. Load writes the
 * cookies into the context and each origin's localStorage once, through a throwaway page whose
 * requests are answered locally, so nothing reaches the network and a reload of a real page later
 * runs against whatever the site has done to its storage since.
 *
 * sessionStorage belongs to one tab by definition and is neither captured nor loaded.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { bestEffort } from "@veyyon/utils/discarded-fault";
import { type } from "arktype";
import type { BrowserContext, Cookie, CookieData, Frame, HTTPRequest } from "puppeteer-core";
import { ToolError } from "../../core/tool-errors";

const storageItemSchema = type({ name: "string", value: "string" });

const storageCookieSchema = type({
	name: "string",
	value: "string",
	domain: "string",
	"path?": "string",
	/** Seconds since the epoch; -1 marks a session cookie. */
	"expires?": "number",
	"httpOnly?": "boolean",
	"secure?": "boolean",
	"sameSite?": "'Strict' | 'Lax' | 'None'",
});

const storageStateSchema = type({
	"cookies?": storageCookieSchema.array(),
	"origins?": type({ origin: "string", localStorage: storageItemSchema.array() }).array(),
});

export type StorageCookie = typeof storageCookieSchema.infer;

export interface StorageOrigin {
	readonly origin: string;
	readonly localStorage: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

export interface StorageState {
	readonly cookies: readonly StorageCookie[];
	readonly origins: readonly StorageOrigin[];
}

/** What a load put into a context. */
export interface StorageStateLoaded {
	readonly cookies: number;
	/** The origins whose localStorage was written, in file order. */
	readonly origins: readonly string[];
}

/** The slice of `window.localStorage` the in-page code touches; this package compiles without the DOM lib. */
interface PageStorage {
	readonly length: number;
	key(index: number): string | null;
	getItem(name: string): string | null;
	setItem(name: string, value: string): void;
}

/** A scheme, host and port such as `https://example.com`: the one thing localStorage is keyed by. */
function isWebOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin;
	} catch {
		return false;
	}
}

/** Validate a parsed storage state; `source` names where it came from in the error. */
export function parseStorageState(raw: unknown, source: string): StorageState {
	const result = storageStateSchema(raw);
	if (result instanceof type.errors) {
		throw new ToolError(`${source} is not a storage state: ${result.summary}`);
	}
	const origins = result.origins ?? [];
	for (const { origin } of origins) {
		if (!isWebOrigin(origin)) {
			throw new ToolError(
				`${source} names ${JSON.stringify(origin)} as an origin; an origin is a scheme, host and port such as https://example.com`,
			);
		}
	}
	return { cookies: result.cookies ?? [], origins };
}

export async function readStorageStateFile(file: string): Promise<StorageState> {
	let text: string;
	try {
		text = await fs.promises.readFile(file, "utf8");
	} catch (error) {
		throw new ToolError(`Cannot read storage state ${file}: ${errorMessage(error)}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new ToolError(`Storage state ${file} is not JSON: ${errorMessage(error)}`);
	}
	return parseStorageState(raw, file);
}

/** Write `state` to `file`, readable and writable by its owner alone: it holds live session cookies. */
export async function writeStorageStateFile(file: string, state: StorageState): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	// The open's mode applies only to a file it creates: an existing file is narrowed through the same
	// handle, after the truncation and before the cookies are written.
	const handle = await fs.promises.open(file, "w", 0o600);
	try {
		await handle.chmod(0o600);
		await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
	} finally {
		await handle.close();
	}
}

function toStorageCookie(cookie: Cookie): StorageCookie {
	return {
		name: cookie.name,
		value: cookie.value,
		domain: cookie.domain,
		path: cookie.path,
		expires: cookie.expires,
		httpOnly: cookie.httpOnly ?? false,
		secure: cookie.secure,
		// Chrome's "Default" is no attribute at all; a state file names only the three a cookie can carry.
		...(cookie.sameSite === undefined || cookie.sameSite === "Default" ? {} : { sameSite: cookie.sameSite }),
	};
}

function toCookieData(cookie: StorageCookie): CookieData {
	return {
		name: cookie.name,
		value: cookie.value,
		domain: cookie.domain,
		...(cookie.path === undefined ? {} : { path: cookie.path }),
		// A session cookie carries no expiry; -1 is how a capture writes one.
		...(cookie.expires === undefined || cookie.expires < 0 ? {} : { expires: cookie.expires }),
		...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
		...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
		...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
	};
}

/** The origin of a frame's document when localStorage can be keyed by it; nothing for about:, data: and file:. */
function frameOrigin(url: string): string | undefined {
	try {
		const { protocol, origin } = new URL(url);
		return protocol === "http:" || protocol === "https:" ? origin : undefined;
	} catch {
		return undefined;
	}
}

/** A frame's localStorage, or null when the frame is sandboxed away from it or detached before the read. */
async function readFrameStorage(frame: Frame): Promise<Array<{ name: string; value: string }> | null> {
	try {
		return await frame.evaluate(() => {
			// A sandboxed frame throws on the first touch of its storage.
			try {
				const storage = (globalThis as unknown as { localStorage: PageStorage }).localStorage;
				const read: Array<{ name: string; value: string }> = [];
				for (let i = 0; i < storage.length; i++) {
					const name = storage.key(i);
					if (name !== null) read.push({ name, value: storage.getItem(name) ?? "" });
				}
				return read;
			} catch {
				return null;
			}
		});
	} catch (error) {
		// A frame that navigated or detached between listing and reading has nothing to give.
		if (frame.detached) return null;
		throw error;
	}
}

/**
 * Every cookie `context` holds, and the localStorage of every http(s) origin its pages and frames have
 * open, read from one frame per origin, all origins at once.
 */
export async function captureStorageState(context: BrowserContext): Promise<StorageState> {
	const [rawCookies, pages] = await Promise.all([context.cookies(), context.pages()]);
	const frameOf = new Map<string, Frame>();
	for (const page of pages) {
		for (const frame of page.frames()) {
			const origin = frameOrigin(frame.url());
			if (origin !== undefined && !frameOf.has(origin)) frameOf.set(origin, frame);
		}
	}
	const read = await Promise.all(
		Array.from(frameOf, async ([origin, frame]) => ({ origin, localStorage: await readFrameStorage(frame) })),
	);
	const origins: StorageOrigin[] = [];
	for (const entry of read) {
		if (entry.localStorage !== null && entry.localStorage.length > 0) {
			origins.push({ origin: entry.origin, localStorage: entry.localStorage });
		}
	}
	return { cookies: rawCookies.map(toStorageCookie), origins };
}

/** Serve every request of the throwaway page from here: an empty document, and nothing reaches the network. */
function answerLocally(request: HTTPRequest): void {
	void bestEffort(
		request.respond({ status: 200, contentType: "text/html", body: "" }),
		"a request answered after its page closed has nobody to answer",
	);
}

/**
 * Put `state` into `context`: its cookies that have not expired, and each origin's localStorage,
 * written once through a throwaway page that never reaches the network.
 */
export async function applyStorageState(context: BrowserContext, state: StorageState): Promise<StorageStateLoaded> {
	const now = Date.now() / 1000;
	const cookies = state.cookies.filter(
		cookie => cookie.expires === undefined || cookie.expires < 0 || cookie.expires > now,
	);
	if (cookies.length > 0) await context.setCookie(...cookies.map(toCookieData));
	const origins = state.origins.filter(entry => entry.localStorage.length > 0);
	if (origins.length > 0) {
		const page = await context.newPage();
		try {
			await page.setRequestInterception(true);
			page.on("request", answerLocally);
			for (const entry of origins) {
				await page.goto(entry.origin, { waitUntil: "domcontentloaded" });
				await page.evaluate(items => {
					const storage = (globalThis as unknown as { localStorage: PageStorage }).localStorage;
					for (const item of items) storage.setItem(item.name, item.value);
				}, entry.localStorage);
			}
		} finally {
			await bestEffort(page.close(), "a throwaway page that will not close goes with its context");
		}
	}
	return { cookies: cookies.length, origins: origins.map(entry => entry.origin) };
}
