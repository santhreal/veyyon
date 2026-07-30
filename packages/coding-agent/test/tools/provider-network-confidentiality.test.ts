import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { CustomToolContext } from "@veyyon/coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@veyyon/coding-agent/session/session-manager";
import { hasCredentialBearingUrl, renderHtmlToText } from "@veyyon/coding-agent/tools/fetch";
import {
	__resetAutoQaFlushStateForTests,
	flushGrievances,
	sanitizeAutoQaPayload,
} from "@veyyon/coding-agent/tools/report-tool-issue";
import { ttsTool } from "@veyyon/coding-agent/tools/tts";
import { removeWithRetries } from "@veyyon/utils";
import { asGlobalFetch, mockFetch } from "../helpers/fetch-mock";

const generatedAudioPaths: string[] = [];
const originalParallelApiKey = Bun.env.PARALLEL_API_KEY;

afterEach(async () => {
	vi.restoreAllMocks();
	__resetAutoQaFlushStateForTests();
	await Promise.all(generatedAudioPaths.splice(0).map(path => removeWithRetries(path)));
	if (originalParallelApiKey === undefined) delete Bun.env.PARALLEL_API_KEY;
	else Bun.env.PARALLEL_API_KEY = originalParallelApiKey;
});

function openReportDb(): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE grievances (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			model TEXT NOT NULL,
			version TEXT NOT NULL,
			tool TEXT NOT NULL,
			report TEXT NOT NULL,
			pushed INTEGER NOT NULL DEFAULT 0
		)
	`);
	return db;
}

function insertReport(db: Database, report: string): void {
	db.prepare("INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)").run(
		"boundary-model",
		"boundary-version",
		"read",
		report,
	);
}

function reportSettings(): Settings {
	return Settings.isolated({
		"dev.autoqa": true,
		"dev.autoqaPush.enabled": true,
		"dev.autoqaPush.endpoint": "https://collector.invalid/grievances",
	});
}

function ttsContext(): CustomToolContext {
	const modelRegistry = {
		authStorage: { hasNonEnvCredential: () => false },
		getApiKeyForProvider: async () => "bootstrap-key",
		getProviderBaseUrl: () => "https://xai-boundary.invalid/v1",
		getAll: () => [],
		resolver: () => (resolution: { error?: unknown }) => (resolution.error === undefined ? "key-one" : "key-two"),
	} as unknown as ModelRegistry;
	return {
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "tts-boundary-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

function substantialHtml(): string {
	const paragraphs = Array.from(
		{ length: 6 },
		(_, index) =>
			`<p>Paragraph ${index + 1} contains enough ordinary article text to clear the reader quality threshold without any remote extraction service.</p>`,
	).join("");
	return `<html><body><article><h1>Local article</h1>${paragraphs}</article></body></html>`;
}

describe("cloud TTS final confidentiality boundary", () => {
	it("rebuilds and sanitizes every free string again after a 401 credential refresh", async () => {
		// Why: withAuth retries are separate physical disclosures; reusing the
		// first body's sanitizer snapshot leaks secrets learned during refresh.
		const early = "TTS_EARLY_SECRET_41";
		const late = "TTS_LATE_SECRET_82";
		let currentSanitizer = (text: string) => text.replaceAll(early, "#EARLY#");
		const ctx = ttsContext();
		ctx.obfuscateProviderText = text => currentSanitizer(text);
		const bodies: Array<Record<string, string>> = [];
		const authorizations: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch((_input, init) => {
				bodies.push(JSON.parse(String(init?.body)) as Record<string, string>);
				authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
				if (bodies.length === 1) {
					currentSanitizer = text => text.replaceAll(early, "#EARLY#").replaceAll(late, "#LATE#");
					return new Response(`unauthorized ${early}`, { status: 401 });
				}
				return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
			}),
		);
		const outputPath = `/tmp/veyyon-tts-boundary-${crypto.randomUUID()}.mp3`;
		generatedAudioPaths.push(outputPath);

		const result = await ttsTool.execute(
			"tts-boundary",
			{
				text: `${early} ${late}`,
				voice_id: `voice-${early}-${late}`,
				language: `lang-${early}-${late}`,
				output_path: outputPath,
			},
			undefined,
			ctx,
		);

		expect(result.isError).not.toBe(true);
		expect(bodies).toHaveLength(2);
		expect(authorizations).toEqual(["Bearer key-one", "Bearer key-two"]);
		for (const field of ["text", "voice_id", "language"] as const) {
			expect(bodies[0][field]).not.toContain(early);
			expect(bodies[0][field]).toContain("#EARLY#");
			expect(bodies[1][field]).not.toContain(early);
			expect(bodies[1][field]).not.toContain(late);
		}
	});

	it("sanitizes an echoed provider error before truncating or returning it", async () => {
		// Why: provider errors routinely echo invalid request fields and are then
		// returned to the model, creating a second disclosure path.
		const secret = "TTS_ERROR_SECRET_93";
		const ctx = ttsContext();
		ctx.obfuscateProviderText = text => text.replaceAll(secret, "#ERROR_REDACTED#");
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(() => new Response(`invalid voice ${secret}`, { status: 400 })),
		);
		const outputPath = `/tmp/veyyon-tts-error-${crypto.randomUUID()}.mp3`;
		generatedAudioPaths.push(outputPath);

		const result = await ttsTool.execute(
			"tts-error",
			{ text: secret, voice_id: secret, language: secret, output_path: outputPath },
			undefined,
			ctx,
		);
		const rendered = JSON.stringify(result);
		expect(result.isError).toBe(true);
		expect(rendered).not.toContain(secret);
		expect(rendered).toContain("#ERROR_REDACTED#");
	});
});

describe("delayed auto-QA report confidentiality", () => {
	it("clones recursively and sanitizes nested keys and values without mutating the local report", () => {
		// Why: key-only sanitation misses secrets used as property names, while
		// mutating the stored row destroys the user's local source of truth.
		const secret = "REPORT_NESTED_SECRET_54";
		const raw = {
			[`outer-${secret}`]: [{ [`inner-${secret}`]: `value-${secret}` }],
			ordinary: 7,
		};
		const sanitized = sanitizeAutoQaPayload(raw, text => text.replaceAll(secret, "#REPORT#"));
		const wire = JSON.stringify(sanitized);
		expect(wire).not.toContain(secret);
		expect(wire).toContain("outer-#REPORT#");
		expect(wire).toContain("inner-#REPORT#");
		expect(JSON.stringify(raw)).toContain(secret);
	});

	it("resolves the runtime sanitizer after a delayed queue reaches its physical POST", async () => {
		// Why: consent/UI delays can refresh the session's secret set while the
		// raw SQLite row waits; the flush must not retain the old callback.
		const db = openReportDb();
		try {
			const secret = "REPORT_DELAYED_SECRET_65";
			insertReport(db, `nested={"${secret}":"${secret}"}`);
			let current = (text: string) => text;
			let captured = "";
			const result = await flushGrievances(db, reportSettings(), {
				onStart: () => {
					current = text => text.replaceAll(secret, "#DELAYED#");
				},
				resolveSanitizer: () => current,
				fetch: mockFetch((_input, init) => {
					captured = String(init?.body);
					return new Response("", { status: 200 });
				}),
			});
			expect(result).toEqual({ pushed: 1, ok: true });
			expect(captured).not.toContain(secret);
			expect(captured).toContain("#DELAYED#");
		} finally {
			db.close();
		}
	});

	it("re-resolves the sanitizer for a later physical batch after an intervening request", async () => {
		// Why: the worker drains multiple batches; a runtime refresh during batch
		// one must govern batch two rather than a stale flush-level snapshot.
		const db = openReportDb();
		try {
			const late = "REPORT_RETRY_SECRET_76";
			for (let index = 0; index < 50; index += 1) insertReport(db, `ordinary-${index}`);
			insertReport(db, late);
			let current = (text: string) => text;
			const bodies: string[] = [];
			const result = await flushGrievances(db, reportSettings(), {
				resolveSanitizer: () => current,
				fetch: mockFetch((_input, init) => {
					bodies.push(String(init?.body));
					current = text => text.replaceAll(late, "#RETRY#");
					return new Response("", { status: 200 });
				}),
			});
			expect(result).toEqual({ pushed: 51, ok: true });
			expect(bodies).toHaveLength(2);
			expect(bodies[1]).not.toContain(late);
			expect(bodies[1]).toContain("#RETRY#");
		} finally {
			db.close();
		}
	});

	it("fails closed without dispatch when the sanitizer errors with secret-bearing text", async () => {
		const db = openReportDb();
		try {
			const secret = "REPORT_SANITIZER_ERROR_87";
			insertReport(db, secret);
			const fetchSpy = vi.fn(() => new Response("", { status: 200 }));
			const result = await flushGrievances(db, reportSettings(), {
				resolveSanitizer: () => text => {
					throw new Error(`could not sanitize ${text}`);
				},
				fetch: mockFetch(fetchSpy),
			});
			expect(result).toEqual({ pushed: 0, ok: false });
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			db.close();
		}
	});
});

describe("secondary reader URL confidentiality", () => {
	it("detects userinfo, query credentials, labeled path tokens, and encoded adversarial variants", () => {
		const credentialUrls = [
			"https://user:password@example.com/private",
			"https://example.com/private?access_token=short",
			"https://example.com/download/token/short",
			"https://example.com/private?%2561ccess_token=short",
			"https://example.com/download/%2574oken/short",
			"https://example.com/download/eyJhbGciOiJIUzI1NiJ9.payload.signature",
		];
		for (const url of credentialUrls) expect(hasCredentialBearingUrl(url)).toBe(true);
	});

	it("keeps ordinary URLs and label-only path boundaries eligible for remote readers", () => {
		const ordinaryUrls = [
			"https://example.com/articles/quarterly-roadmap-2026?page=2&sort=date",
			"https://example.com/token",
			"https://example.com/code-examples",
		];
		for (const url of ordinaryUrls) expect(hasCredentialBearingUrl(url)).toBe(false);
	});

	it("skips a preferred Jina reader and uses loaded HTML for a credential-bearing URL", async () => {
		// Why: redacting a signed URL produces a broken URL; the only safe path is
		// to avoid the unrelated reader entirely and preserve local/direct modes.
		const remoteFetch = vi.fn(() => new Response("should not be called", { status: 200 }));
		const url = "https://example.com/private?signature=SIGNED_URL_SECRET_98";
		const result = await renderHtmlToText(
			url,
			substantialHtml(),
			5,
			Settings.isolated({ "providers.fetch": "jina" }),
			undefined,
			null,
			mockFetch(remoteFetch),
		);
		expect(result.ok).toBe(true);
		expect(result.method).toBe("native");
		expect(remoteFetch).not.toHaveBeenCalled();
	});

	it("skips a credentialed preferred Parallel reader and uses loaded HTML instead", async () => {
		// A configured Parallel key makes this a real eligible production
		// dispatch path; the URL guard, not missing credentials, must stop it.
		Bun.env.PARALLEL_API_KEY = "parallel-test-key";
		const remoteFetch = vi.fn(() => new Response("should not be called", { status: 200 }));
		const result = await renderHtmlToText(
			"https://example.com/download/token/PARALLEL_URL_SECRET_19",
			substantialHtml(),
			5,
			Settings.isolated({ "providers.fetch": "parallel" }),
			undefined,
			null,
			mockFetch(remoteFetch),
		);
		expect(result.ok).toBe(true);
		expect(result.method).toBe("native");
		expect(remoteFetch).not.toHaveBeenCalled();
	});
});
