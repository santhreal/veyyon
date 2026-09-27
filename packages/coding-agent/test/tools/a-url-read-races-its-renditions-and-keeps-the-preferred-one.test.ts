/**
 * WHY: reading an HTML page probed its digestible renditions one round trip at a time: the markdown
 * alternate link, the `.md` sibling, content negotiation, then up to two feed alternates. Most probes
 * miss, so an ordinary article paid three sequential round trips before its reader ran, and a
 * script-rendered shell then walked every llms.txt endpoint in its scope one at a time as well.
 *
 * The contract: every probe of one kind (renditions, llms.txt endpoints) is in flight before any of
 * them answers; the answer is the most preferred probe that answers, whichever order they settle
 * in; the read settles as soon as that probe and those ahead of it have answered, and every probe
 * still running is aborted; a cancellation while probes are in flight ends the read.
 *
 * Gap: a sequential implementation fails these tests by the per-test timeout rather than by an
 * assertion, because a probe that is never sent cannot be observed as missing without a clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import * as toolsManager from "@veyyon/coding-agent/utils/tools-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import * as which from "@veyyon/utils/which";
import type { LoadPageResult } from "@veyyon/web/scrapers/types";
import * as scrapers from "@veyyon/web/scrapers/types";

const PROSE = "Rendition body line with enough text to clear every length threshold a probe applies.\n";
const MARKDOWN = `# Markdown\n\n${PROSE.repeat(4)}`;
const FEED = `<?xml version="1.0"?><rss><channel><title>Feed</title>${"<item><title>Entry</title><description>An entry description.</description></item>".repeat(4)}</channel></rss>`;
const ARTICLE = `<html><head><title>Article</title>{{head}}</head><body><article><h1>Page heading</h1>${"<p>This paragraph carries enough prose to count as real content for every reader backend that reads it.</p>".repeat(6)}</article></body></html>`;
const SHELL = `<html><head><title>App</title></head><body><div id="root"></div></body></html>`;

function makeSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async toolType => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.${toolType}.log`) };
		},
		settings: Settings.isolated({ "fetch.enabled": true }),
		// The remote reader backends answer nothing, so a shell page falls through to llms.txt.
		fetch: (async () => new Response("", { status: 404 })) as ToolSession["fetch"],
	};
}

/** A request the stub holds open until the test answers it or its signal aborts. */
interface HeldRequest {
	readonly key: string;
	readonly signal: AbortSignal | undefined;
	answer(result: LoadPageResult): void;
}

const notFound = (url: string): LoadPageResult => ({
	ok: false,
	status: 404,
	content: "",
	contentType: "text/plain",
	finalUrl: url,
});
const found = (url: string, contentType: string, content: string): LoadPageResult => ({
	ok: true,
	status: 200,
	content,
	contentType,
	finalUrl: url,
});

/**
 * Serves `page` at `pageUrl` at once, answers requests `held` does not match with a 404 at once, and
 * holds every request `held` matches open. `sent` resolves once `expected` requests are held.
 */
function stubHeldSite(pageUrl: string, page: string, held: (key: string) => boolean, expected: number) {
	const requests: HeldRequest[] = [];
	const sent = Promise.withResolvers<HeldRequest[]>();
	vi.spyOn(scrapers, "loadPage").mockImplementation((url, options) => {
		const key = options?.headers?.Accept?.startsWith("text/markdown") ? `${url} [negotiated]` : url;
		if (key === pageUrl) return Promise.resolve(found(url, "text/html", page));
		if (!held(key)) return Promise.resolve(notFound(url));
		const response = Promise.withResolvers<LoadPageResult>();
		const signal = options?.signal;
		signal?.addEventListener("abort", () => response.reject(signal.reason), { once: true });
		requests.push({ key, signal, answer: response.resolve });
		if (requests.length === expected) sent.resolve(requests);
		return response.promise;
	});
	return sent.promise;
}

describe("a URL read races its renditions and keeps the preferred one", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `url-read-races-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
		vi.spyOn(which, "$which").mockReturnValue(null);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	const origin = "https://example.com";
	const renditions = [
		{
			method: "alternate-markdown",
			key: `${origin}/docs/alt.md`,
			answer: (url: string) => found(url, "text/markdown", MARKDOWN),
		},
		{
			method: "md-suffix",
			key: `${origin}/docs/page.md`,
			answer: (url: string) => found(url, "text/markdown", MARKDOWN),
		},
		{
			method: "content-negotiation",
			key: `${origin}/docs/page [negotiated]`,
			answer: (url: string) => found(url, "text/markdown", MARKDOWN),
		},
		{
			method: "alternate-feed",
			key: `${origin}/docs/page/feed.xml`,
			answer: (url: string) => found(url, "application/rss+xml", FEED),
		},
		{
			method: "alternate-feed",
			key: `${origin}/docs/page/comments.atom`,
			answer: (url: string) => found(url, "application/rss+xml", FEED),
		},
	];
	const head = [
		`<link rel="alternate" type="text/markdown" href="/docs/alt.md">`,
		`<link rel="alternate" type="application/rss+xml" href="/docs/page/feed.xml">`,
		`<link rel="alternate" type="application/atom+xml" href="/docs/page/comments.atom">`,
	].join("");

	for (let winner = 0; winner < renditions.length; winner++) {
		it(`keeps rendition ${winner} (${renditions[winner]!.method}) over every later one, whichever answers first`, async () => {
			const pageUrl = `${origin}/docs/page`;
			const sent = stubHeldSite(pageUrl, ARTICLE.replace("{{head}}", head), () => true, renditions.length);
			const reading = new ReadTool(makeSession(testDir)).execute("read-url", { path: pageUrl });

			const requests = await sent;
			expect(requests.map(request => request.key)).toEqual(renditions.map(rendition => rendition.key));
			// Every later probe answers first, then the ones ahead of the winner miss, then the winner
			// answers. A probe behind the winner and still open stays open: the read must not wait for it.
			const open = winner + 1 < renditions.length ? requests[winner + 1]! : undefined;
			for (let index = renditions.length - 1; index > winner + 1; index--) {
				requests[index]!.answer(renditions[index]!.answer(renditions[index]!.key));
			}
			for (let index = 0; index < winner; index++) requests[index]!.answer(notFound(renditions[index]!.key));
			const winning = renditions[winner]!;
			requests[winner]!.answer(winning.answer(winning.key.replace(" [negotiated]", "")));

			const result = await reading;

			expect(result.details?.method).toBe(winning.method);
			expect(open?.signal?.aborted ?? true).toBe(true);
		});
	}

	it("sends every llms.txt probe in a shell page's scope at once and keeps the nearest that answers", async () => {
		const pageUrl = `${origin}/app/view/shell`;
		const llms = [
			`${origin}/app/view/llms.txt`,
			`${origin}/app/view/llms.md`,
			`${origin}/app/llms.txt`,
			`${origin}/app/llms.md`,
		];
		const sent = stubHeldSite(pageUrl, SHELL, key => /\/llms\.(txt|md)$/.test(key), llms.length);
		const reading = new ReadTool(makeSession(testDir)).execute("read-url", { path: pageUrl });

		const requests = await sent;
		expect(requests.map(request => request.key)).toEqual(llms);
		requests[2]!.answer(found(llms[2]!, "text/plain", PROSE.repeat(3)));
		requests[0]!.answer(notFound(llms[0]!));
		requests[1]!.answer(notFound(llms[1]!));

		const result = await reading;

		expect(result.details?.method).toBe("llms.txt");
		expect(result.details?.notes).toContain(`Used llms.txt fallback: ${llms[2]}`);
		expect(requests[3]!.signal?.aborted).toBe(true);
	});

	it("ends the read when it is cancelled while every probe is in flight", async () => {
		const pageUrl = `${origin}/docs/page`;
		const sent = stubHeldSite(pageUrl, ARTICLE.replace("{{head}}", head), () => true, renditions.length);
		const controller = new AbortController();
		const reading = new ReadTool(makeSession(testDir)).execute("read-url", { path: pageUrl }, controller.signal);

		const requests = await sent;
		controller.abort(new Error("stopped by the caller"));

		await expect(reading).rejects.toThrow();
		expect(requests.every(request => request.signal?.aborted)).toBe(true);
	});
});
