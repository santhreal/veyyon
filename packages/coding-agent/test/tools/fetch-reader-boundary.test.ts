import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type SettingPath, Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { renderHtmlToText } from "@veyyon/coding-agent/tools/fetch";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import * as scrapers from "@veyyon/coding-agent/web/scrapers/types";
import * as natives from "@veyyon/natives";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { asGlobalFetch } from "../helpers/fetch-mock";

describe("fetch remote reader confidentiality boundary", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-reader-boundary-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PARALLEL_API_KEY;
		removeSyncWithRetries(testDir);
	});

	const createSession = (overrides: Partial<Record<SettingPath, unknown>>): ToolSession => {
		const sessionFile = path.join(testDir, "session.jsonl");
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => sessionFile,
			getArtifactsDir: () => sessionFile.slice(0, -6),
			getSessionSpawns: () => null,
			allocateOutputArtifact: async toolType => ({
				id: "0",
				path: path.join(sessionFile.slice(0, -6), `0.${toolType}.log`),
			}),
			settings: Settings.isolated({
				"fetch.enabled": true,
				...overrides,
			}),
		};
	};

	it("keeps the direct target byte-exact while skipping Jina and Parallel when a short secret is transformed", async () => {
		process.env.PARALLEL_API_KEY = "test-parallel-key";
		const providers = ["jina", "parallel"] as const;
		const directTargets = providers.map(provider => `https://example.com/${provider}?view=s3`);
		const directRequests: string[] = [];
		const remoteRequests: string[] = [];
		const html = "<html><body><main>Already loaded target content</main></body></html>";

		vi.spyOn(natives, "htmlToMarkdown").mockResolvedValue(
			`# Loaded locally\n\n${"Content from the exact direct target. ".repeat(6)}`,
		);
		vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => {
			directRequests.push(requestedUrl);
			if (directTargets.includes(requestedUrl as (typeof directTargets)[number])) {
				return {
					ok: true,
					status: 200,
					contentType: "text/html",
					finalUrl: requestedUrl,
					content: html,
				};
			}
			return {
				ok: false,
				status: 404,
				contentType: "text/plain",
				finalUrl: requestedUrl,
				content: "",
			};
		});

		for (const [index, provider] of providers.entries()) {
			const session = createSession({ "providers.fetch": provider });
			let transformCalls = 0;
			session.obfuscateProviderText = value => {
				transformCalls++;
				return value.replace("s3", "[REDACTED]");
			};
			session.fetch = asGlobalFetch(input => {
				remoteRequests.push(String(input));
				return new Response("unexpected remote reader request", { status: 500 });
			});

			const result = await new ReadTool(session).execute(`fetch-${provider}-boundary`, {
				path: directTargets[index]!,
			});

			expect(result.details?.method).toBe("native");
			expect(transformCalls).toBe(1);
		}

		expect(directRequests).toEqual(expect.arrayContaining(directTargets));
		expect(directRequests).not.toContain("https://example.com/jina?view=[REDACTED]");
		expect(directRequests).not.toContain("https://example.com/parallel?view=[REDACTED]");
		expect(remoteRequests).toEqual([]);
	});

	it("does not send to Jina when the live transform throws", async () => {
		const remoteRequests: string[] = [];
		vi.spyOn(natives, "htmlToMarkdown").mockResolvedValue(
			`# Loaded locally\n\n${"Safe fallback content. ".repeat(8)}`,
		);
		const fetchMock = asGlobalFetch(input => {
			remoteRequests.push(String(input));
			return new Response("unexpected remote reader request", { status: 500 });
		});

		const result = await renderHtmlToText(
			"https://example.com/article?view=s3",
			"<html><body><main>Already loaded target content</main></body></html>",
			1,
			Settings.isolated({ "providers.fetch": "jina" }),
			undefined,
			null,
			fetchMock,
			() => () => {
				throw new Error("raw provider-bound arguments must not surface");
			},
		);

		expect(result.method).toBe("native");
		expect(remoteRequests).toEqual([]);
	});
});
