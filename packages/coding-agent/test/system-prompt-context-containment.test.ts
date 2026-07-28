import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import { estimateTokensFromText } from "@veyyon/utils";

const cwd = process.cwd();
const workspaceTree = {
	rootPath: cwd,
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

type ContextFile = { path: string; content: string; depth?: number };
async function renderAssembledPrompt(contextFiles: ContextFile[]): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd,
		resolvedCustomPrompt: "Focused containment test prompt.",
		contextFiles,
		skills: [],
		rules: [],
		toolNames: [],
		workspaceTree,
		activeRepoContext: null,
	});

	return systemPrompt.join("\n\n");
}

function renderedFile(path: string, content: string): string {
	return `<file path="${path}">\n${content}\n</file>`;
}

describe("context-file containment deduplication", () => {
	/**
	 * An earlier layer contributes no provider-visible information when its whole
	 * normalized paragraph sequence is already contiguous in the authoritative layer.
	 */
	it("drops an exact-contained less-prominent file from the assembled project prompt", async () => {
		const parent = {
			path: "/repo/AGENTS.md",
			content: "Run focused checks.\n\nPreserve public behavior.",
			depth: 2,
		};
		const child = {
			path: "/repo/app/AGENTS.md",
			content: `Child-only preface.\n\n${parent.content}\n\nChild-only suffix.`,
			depth: 0,
		};
		// The one-word substitution is the same byte length but breaks exact
		// containment, giving us an assembled pre-dedup byte baseline.
		const sameSizeDistinctParent = {
			...parent,
			content: parent.content.replace("focused", "limited"),
		};

		const assembled = await renderAssembledPrompt([parent, child]);
		const preDedupByteBaseline = await renderAssembledPrompt([sameSizeDistinctParent, child]);
		const authoritativeOnly = await renderAssembledPrompt([child]);
		const removedProviderBytes = Buffer.byteLength(preDedupByteBaseline) - Buffer.byteLength(assembled);
		const removedProviderText = `${renderedFile(sameSizeDistinctParent.path, sameSizeDistinctParent.content)}\n\n`;
		const removedProviderTokens = estimateTokensFromText(removedProviderText);

		expect(assembled).toBe(authoritativeOnly);
		expect(removedProviderBytes).toBe(Buffer.byteLength(removedProviderText));
		expect(removedProviderBytes).toBeGreaterThan(Buffer.byteLength(parent.content));
		expect(removedProviderTokens).toBe(22);
		expect(assembled).not.toContain(parent.path);
		expect(assembled).toContain(renderedFile(child.path, child.content));
	});

	/**
	 * Matching every paragraph somewhere is insufficient: an intervening block
	 * may carry precedence, so both original layers must remain byte-identical.
	 */
	it("keeps noncontiguous parent and child instructions byte-identical", async () => {
		const parent = {
			path: "/repo/AGENTS.md",
			content: "Run focused checks.\n\nPreserve public behavior.",
			depth: 2,
		};
		const child = {
			path: "/repo/app/AGENTS.md",
			content: "Run focused checks.\n\nChild-specific override.\n\nPreserve public behavior.",
			depth: 0,
		};

		const assembled = await renderAssembledPrompt([parent, child]);

		expect(assembled).toContain(renderedFile(parent.path, parent.content));
		expect(assembled).toContain(renderedFile(child.path, child.content));
	});

	/**
	 * Similar meaning is not duplication: a wording change remains an independent
	 * layered instruction and neither file's bytes may be rewritten or removed.
	 */
	it("keeps paraphrased parent and child instructions byte-identical", async () => {
		const parent = {
			path: "/repo/AGENTS.md",
			content: "Run only the focused checks.",
			depth: 2,
		};
		const child = {
			path: "/repo/app/AGENTS.md",
			content: "Run just the targeted checks.",
			depth: 0,
		};

		const assembled = await renderAssembledPrompt([parent, child]);

		expect(assembled).toContain(renderedFile(parent.path, parent.content));
		expect(assembled).toContain(renderedFile(child.path, child.content));
	});

	/**
	 * When complete copies occur at multiple prominence levels, only the latest,
	 * closest path survives so the authoritative copy and its provenance are kept.
	 */
	it("keeps only the closest copy of identical context", async () => {
		const content = "Use the repository conventions exactly.";
		const far = { path: "/repo/AGENTS.md", content, depth: 2 };
		const close = { path: "/repo/app/AGENTS.md", content, depth: 0 };

		const assembled = await renderAssembledPrompt([far, close]);

		expect(assembled).not.toContain(far.path);
		expect(assembled).toContain(renderedFile(close.path, content));
		expect(assembled.match(/Use the repository conventions exactly\./g)).toHaveLength(1);
	});
});
