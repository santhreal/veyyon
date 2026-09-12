/**
 * WHY: a system instruction that contains the upstream oh-my-pi conventions header is
 * rejected by Google's consumer Antigravity backend.
 *
 * THE DEFECT. Every turn on `google-antigravity` from a consumer account
 * (`projectId: aicode-consumers`) failed with `429 RESOURCE_EXHAUSTED
 * "Resource has been exhausted (e.g. check quota)"` on both
 * `daily-cloudcode-pa.googleapis.com` and its sandbox host, with the daily quota at
 * 0%, the credential refreshing, and the same account serving the official client.
 * A live bisection of the request against the stored credential located the cause in
 * the system instruction, not its size: the first 85 characters of the default prompt
 * were enough to draw the 429, the remaining 117 KB alone returned 200, a one-character
 * change inside that window (`RFC 2119` to `RFC 2118`) let the whole prompt through,
 * and the window still drew the 429 when other text preceded it. The backend matches
 * the substring `<system-conventions>\nRFC 2119: MUST, REQUIRED, SHOULD, RECOMMENDED,
 * MAY, OPTIONAL. \`NEVER\` = \``, which is the opening of the upstream oh-my-pi
 * system prompt, and answers with a quota error rather than a rejection.
 *
 * THE CLASS. Any prompt this package sends as a system instruction that carries that
 * window: the composed default prompt at every section order, the subagent prompt
 * built through the same assembler, and every static `.md` prompt that reaches a
 * provider on its own (advisor, title, commit, compaction). A sync from upstream that
 * restores the original wording turns this red.
 *
 * ENUMERATION. The static prompts are swept from the tree at run time, so a prompt
 * added later is covered without editing this file.
 *
 * WHAT IT DOES NOT CATCH. A new window the backend starts matching tomorrow; the
 * constant here is the one observed. Nor an operator's custom prompt, which the
 * builder passes through unchanged.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";

/** The exact window the consumer Antigravity backend answers with 429 RESOURCE_EXHAUSTED. */
const REJECTED_WINDOW =
	"<system-conventions>\nRFC 2119: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` = `";

const EMPTY_TREE = {
	rootPath: "/tmp",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

type BuildOptions = Parameters<typeof buildSystemPrompt>[0];

const options = (extra: Partial<BuildOptions> = {}): BuildOptions =>
	({
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
		...extra,
	}) as BuildOptions;

const composed = async (extra: Partial<BuildOptions> = {}): Promise<string> => {
	const { systemPrompt } = await buildSystemPrompt(options(extra));
	return (systemPrompt as string[]).join("\n");
};

const SRC_ROOT = path.resolve(import.meta.dirname, "../src");

async function promptFiles(): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await fs.readdir(SRC_ROOT, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const full = path.join(entry.parentPath, entry.name);
		const rel = path.relative(SRC_ROOT, full);
		if (
			rel.includes(`${path.sep}prompts${path.sep}`) ||
			rel.startsWith(`system-prompt-builder${path.sep}statements`)
		) {
			found.push(full);
		}
	}
	return found.sort();
}

describe("the system prompt never carries the header the consumer Antigravity backend rejects", () => {
	it("keeps the conventions preamble while composing the default prompt without the rejected window", async () => {
		const prompt = await composed();
		expect(prompt.startsWith("<system-conventions>\n")).toBe(true);
		expect(prompt).toContain("RFC 2119");
		expect(prompt).not.toContain(REJECTED_WINDOW);
	});

	it("holds at every reordering the operator can request", async () => {
		const prompt = await composed({ sectionOrder: ["delivery-contract", "tool-policy"] });
		expect(prompt).not.toContain(REJECTED_WINDOW);
	});

	it("holds for every static prompt file the package ships", async () => {
		const files = await promptFiles();
		expect(files.length).toBeGreaterThan(0);
		const offending: string[] = [];
		for (const file of files) {
			if ((await fs.readFile(file, "utf8")).includes(REJECTED_WINDOW)) {
				offending.push(path.relative(SRC_ROOT, file));
			}
		}
		expect(offending).toEqual([]);
	});
});
