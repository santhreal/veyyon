import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@veyyon/ai";
import type { AssistantMessage, Context } from "@veyyon/ai";
import { generateConventionalAnalysis, generateSummary } from "@veyyon/coding-agent/commit/analysis";
import { generateChangelogEntries } from "@veyyon/coding-agent/commit/changelog/generate";
import { runMapPhase } from "@veyyon/coding-agent/commit/map-reduce/map-phase";
import { runReducePhase } from "@veyyon/coding-agent/commit/map-reduce/reduce-phase";
import { generateCommitMessage } from "@veyyon/coding-agent/utils/commit-message-generator";

const PLACEHOLDER = "#OBFUSCATED#";

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		stopReason: "end_turn",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function conventionalResponse(): AssistantMessage {
	return assistantText(JSON.stringify({ type: "fix", scope: null, details: [], issue_refs: [] }));
}

function commitSettings() {
	return {
		get: () => undefined,
		getModelRole: () => undefined,
		getStorage: () => undefined,
	} as never;
}

function commitRegistry(models: Array<{ provider: string; id: string }>, apiKey: ai.ApiKey = async () => "key") {
	return {
		getAvailable: () => models,
		getApiKey: async () => "key",
		resolver: () => apiKey,
	} as never;
}

function requestText(context: Context): string {
	return JSON.stringify(context);
}

function replacing(secret: string): (text: string) => string {
	return text => text.replaceAll(secret, PLACEHOLDER);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("commit provider confidentiality boundary", () => {
	it("preserves a safe single-helper request and output", async () => {
		// Why (negative): an identity boundary must preserve byte-for-byte prompt
		// behavior so local/no-secret sessions do not change commit semantics.
		const diff = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+safe";
		let captured = "";
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			captured = String(context.messages[0]?.content ?? "");
			return assistantText("fix safe behavior");
		});

		const result = await generateCommitMessage(
			diff,
			commitRegistry([{ provider: "test", id: "safe-model" }]),
			commitSettings(),
			() => text => text,
		);

		expect(result).toBe("fix safe behavior");
		expect(captured).toBe(`<diff>\n${diff}\n</diff>`);
	});

	it("redacts raw paths and a truncation-boundary secret for every fallback candidate", async () => {
		// Why (positive/adversarial): repository-controlled filenames and aligned
		// diff bytes can otherwise reach every fallback model independently.
		const filenameSecret = "COMMIT_FILENAME_SECRET_5f013";
		const boundarySecret = "COMMIT_BOUNDARY_SECRET_62a1c";
		const header = `diff --git a/${filenameSecret}.ts b/${filenameSecret}.ts\n@@ -1 +1 @@\n+`;
		// Why: redacting after the 4,000-character slice leaves a prefix that no
		// longer equals the configured secret and therefore cannot be replaced.
		const diff = `${header}${"x".repeat(3996 - header.length)}${boundarySecret}`;
		const candidates: string[] = [];
		let calls = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			candidates.push(requestText(context));
			calls += 1;
			return calls === 1
				? ({ ...assistantText(""), stopReason: "error", errorMessage: "candidate unavailable" } as AssistantMessage)
				: assistantText("fix confidential diff");
		});
		const sanitize = (text: string) =>
			text.replaceAll(filenameSecret, PLACEHOLDER).replaceAll(boundarySecret, PLACEHOLDER);

		const result = await generateCommitMessage(
			diff,
			commitRegistry([
				{ provider: "test", id: "candidate-one" },
				{ provider: "test", id: "candidate-two" },
			]),
			commitSettings(),
			() => sanitize,
		);

		expect(result).toBe("fix confidential diff");
		expect(candidates).toHaveLength(2);
		for (const candidate of candidates) {
			expect(candidate).not.toContain(filenameSecret);
			expect(candidate).not.toContain(boundarySecret);
			expect(candidate).not.toContain(boundarySecret.slice(0, 12));
			expect(candidate).toContain(PLACEHOLDER);
		}
	});

	it("rebuilds the raw single-helper diff after credential refresh on an auth retry", async () => {
		// Why (stale refresh): a 401 can reload both credentials and the encrypted
		// secret runtime between two physical sends of one logical request.
		const originalSecret = "COMMIT_ORIGINAL_SECRET_711d";
		const refreshedSecret = "COMMIT_REFRESHED_BOUNDARY_SECRET_f3c5";
		const header = "diff --git a/src/retry.ts b/src/retry.ts\n@@ -1 +1 @@\n+";
		const diff = `${header}${originalSecret}\n${"x".repeat(3995 - header.length - originalSecret.length)}${refreshedSecret}`;
		let protectedSecrets = [originalSecret];
		const attempts: string[] = [];
		let keyCalls = 0;
		const apiKey = async (): Promise<string> => {
			keyCalls += 1;
			if (keyCalls === 2) protectedSecrets = [...protectedSecrets, refreshedSecret];
			return "rotated-key";
		};
		let confidentialityLoads = 0;
		const resolveObfuscateProviderText = async () => {
			confidentialityLoads += 1;
			const currentSecrets = [...protectedSecrets];
			return (text: string) =>
				currentSecrets.reduce((result, secret) => result.replaceAll(secret, PLACEHOLDER), text);
		};
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context, options) => {
			const resolver = options?.apiKey;
			if (typeof resolver !== "function") throw new Error("Expected per-attempt API-key resolver");
			await resolver({ lastChance: false, error: undefined });
			attempts.push(requestText(context));
			await resolver({ lastChance: true, error: new Error("401") });
			attempts.push(requestText(context));
			return assistantText("fix refreshed secret boundary");
		});

		await generateCommitMessage(
			diff,
			commitRegistry([{ provider: "test", id: "retry-model" }], apiKey),
			commitSettings(),
			resolveObfuscateProviderText,
		);

		expect(attempts).toHaveLength(2);
		expect(confidentialityLoads).toBe(4);
		expect(attempts[0]).not.toContain(originalSecret);
		// Why: the second sanitizer resolution happens only after the credential
		// refresh await, and must rebuild from the unsliced source rather than the
		// first attempt's now-unmatchable truncation fragment.
		expect(attempts[1]).not.toContain(refreshedSecret);
		expect(attempts[1]).not.toContain(refreshedSecret.slice(0, 14));
		expect(attempts[1]).toContain(PLACEHOLDER);
	});

	it("sanitizes every conventional and summary prompt field", async () => {
		// Why: conventional and summary prompts aggregate independent repository
		// surfaces, so protecting only the main diff still leaks side-channel text.
		const secret = "COMMIT_ANALYSIS_SECRET_42bd";
		const captures: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			captures.push(requestText(context));
			return context.tools?.[0]?.name === "create_conventional_analysis"
				? conventionalResponse()
				: assistantText("safe summary");
		});
		const model = { provider: "test", id: "analysis-model" } as never;
		const sanitize = replacing(secret);

		const analysis = await generateConventionalAnalysis({
			model,
			apiKey: "key",
			contextFiles: [{ path: `docs/${secret}.md`, content: `context ${secret}` }],
			userContext: `user ${secret}`,
			typesDescription: `types ${secret}`,
			recentCommits: [`subject ${secret}`],
			scopeCandidates: `scope ${secret}`,
			stat: `stat ${secret}`,
			diff: `diff ${secret}`,
			resolveObfuscateProviderText: () => sanitize,
		});
		const summary = await generateSummary({
			model,
			apiKey: "key",
			commitType: `fix-${secret}`,
			scope: `scope-${secret}`,
			details: [`detail ${secret}`],
			stat: `stat ${secret}`,
			maxChars: 72,
			userContext: `summary context ${secret}`,
			resolveObfuscateProviderText: () => sanitize,
		});

		expect(analysis.type).toBe("fix");
		expect(summary.summary).toBe("safe summary");
		expect(captures).toHaveLength(2);
		for (const capture of captures) {
			expect(capture).not.toContain(secret);
			expect(capture).toContain(PLACEHOLDER);
		}
	});

	it("sanitizes changelog metadata and diff before its configured truncation", async () => {
		// Why (boundary): changelog diff limits are attacker-alignable and slicing
		// before replacement creates a prefix the exact-secret matcher cannot see.
		const secret = "COMMIT_CHANGELOG_BOUNDARY_SECRET_8b9e";
		const maxDiffChars = 96;
		const diffPrefix = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n+";
		const diff = `${diffPrefix}${"q".repeat(maxDiffChars - diffPrefix.length - 7)}${secret}`;
		let candidate = "";
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			candidate = requestText(context);
			return assistantText('{"entries":{}}');
		});

		const result = await generateChangelogEntries({
			model: { provider: "test", id: "changelog-model" } as never,
			apiKey: "key",
			changelogPath: `packages/${secret}/CHANGELOG.md`,
			isPackageChangelog: true,
			existingEntries: `## Fixed\n- ${secret}`,
			stat: `1 file ${secret}`,
			diff,
			maxDiffChars,
			resolveObfuscateProviderText: () => replacing(secret),
		});

		expect(result).toEqual({ entries: {} });
		expect(candidate).not.toContain(secret);
		expect(candidate).not.toContain(secret.slice(0, 14));
		expect(candidate).toContain(PLACEHOLDER);
	});

	it("sanitizes map retries and reduce filenames, observations, and metadata", async () => {
		// Why (retry): map retries rebuild requests, while reduce consumes model
		// observations; both stages need the same live final-send boundary.
		const secret = "COMMIT_MAP_REDUCE_SECRET_94ca";
		const mapCandidates: string[] = [];
		let mapCalls = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			if (context.tools?.[0]?.name === "create_conventional_analysis") {
				mapCandidates.push(requestText(context));
				return conventionalResponse();
			}
			mapCandidates.push(requestText(context));
			mapCalls += 1;
			if (mapCalls === 1) throw new Error("transient map failure");
			return assistantText("- safe observation");
		});
		const model = { provider: "test", id: "map-model" } as never;
		const sanitize = replacing(secret);

		const observations = await runMapPhase({
			model,
			apiKey: "key",
			files: [
				{
					filename: `src/${secret}.ts`,
					content: `+const token = "${secret}";`,
					additions: 1,
					deletions: 0,
					isBinary: false,
				},
				{
					filename: `src/context-${secret}.ts`,
					content: "+export const safe = true;",
					additions: 1,
					deletions: 0,
					isBinary: false,
				},
			],
			config: { maxConcurrency: 1, maxRetries: 2, retryBackoffMs: 0 },
			resolveObfuscateProviderText: () => sanitize,
		});
		expect(observations[0]?.file).toContain(secret);

		await runReducePhase({
			model,
			apiKey: "key",
			observations: [
				{ file: `src/${secret}.ts`, observations: [`changed ${secret}`], additions: 1, deletions: 0 },
			],
			stat: `stat ${secret}`,
			scopeCandidates: `scope ${secret}`,
			typesDescription: `types ${secret}`,
			resolveObfuscateProviderText: () => sanitize,
		});

		expect(mapCandidates).toHaveLength(4);
		for (const candidate of mapCandidates) {
			expect(candidate).not.toContain(secret);
			expect(candidate).toContain(PLACEHOLDER);
		}
	});
});
