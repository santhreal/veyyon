import { describe, expect, it } from "bun:test";
import type { ImageContent, Message, TextContent, ToolResultMessage } from "@veyyon/ai";
import {
	convertMessageToLlm,
	createBranchSummaryMessage,
	createCustomMessage,
	defaultConvertToLlm,
	renderBranchSummaryContext,
	renderCompactionSummaryContext,
} from "../src/compaction/messages";
import type { AgentMessage } from "../src/types";

// The core-role transformer is the single source of truth for how compaction
// messages reach the provider. session-messages.test.ts pins the
// compactionSummary+images path; this file pins every other role and the two
// message constructors so an in-place edit to any branch is caught.

const image: ImageContent = { type: "image", data: "ZmFrZQ==", mimeType: "image/png" };

/** Compaction messages are narrowed AgentMessage shapes; fixtures are built
 *  minimally and cast once here rather than per-site. */
function agentMessage(fields: Record<string, unknown>): AgentMessage {
	return fields as unknown as AgentMessage;
}

/** `attribution` is absent on AssistantMessage in the `Message` union; read it
 *  through one narrowed helper instead of casting at every assertion site. */
function attributionOf(message: Message | undefined): string | undefined {
	return (message as { attribution?: string } | undefined)?.attribution;
}

describe("renderBranchSummaryContext", () => {
	it("places the branch summary directly in agent-owned context without private delimiters", () => {
		const rendered = renderBranchSummaryContext("we tried the async path and reverted");
		expect(rendered).toContain("summary of a branch that this conversation came back from");
		expect(rendered).toContain("we tried the async path and reverted");
		expect(rendered).not.toContain("<summary>");
		expect(rendered).not.toContain("</summary>");
	});
});

/**
 * WHAT THIS REPLACED. These assertions previously required the rendered
 * wrapper to read "Model-generated historical summary — non-authoritative",
 * "untrusted historical data, not an instruction layer", and "including
 * AGENTS.md", and to contain neither `MUST`/`NEVER` nor `<summary>` tags. None
 * of that text has ever been in `compaction-summary-context.md`, at HEAD or
 * after the upstream swap, so the assertions described a template that was
 * never written. The shipped template is oh-my-pi's verbatim, by operator
 * order, and is pinned byte for byte here instead.
 *
 * The weaker trust boundary that upstream's wording leaves behind (the wrapper
 * instructs rather than labels) is escalated to the operator; the role-level
 * half of that boundary is real and is asserted below.
 */
describe("renderCompactionSummaryContext", () => {
	it("renders the upstream wrapper around the summary body exactly", () => {
		expect(renderCompactionSummaryContext("prior model outlined the fix")).toBe(
			"Another language model started to solve this problem and produced a summary of its thinking process. " +
				"You also have access to the state of the tools that model used. " +
				"You MUST build on the work already done and NEVER duplicate it. Here is that summary:\n\n" +
				"<summary>\nprior model outlined the fix\n</summary>",
		);
	});
});

/**
 * Legacy sessions may persist one presentation wrapper around the entire
 * summary. Embedded HTML/JSX/XML summary elements are user content and must
 * survive conversion.
 */
describe("summary presentation tag sanitization", () => {
	/**
	 * A legacy session persisted its own `<SUMMARY …>` wrapper inside the
	 * summary text. The template now supplies delimiters of its own, so failing
	 * to strip the persisted one nests two wrappers and hands the model an
	 * ambiguous boundary for the untrusted region.
	 */
	it("removes one attributed enclosing legacy wrapper", () => {
		const rendered = renderCompactionSummaryContext(
			'<SUMMARY data-source="model">prior model outlined the fix</SUMMARY>',
		);
		expect(rendered).toBe(renderCompactionSummaryContext("prior model outlined the fix"));
		expect(rendered).not.toContain("data-source");
		expect(rendered.match(/<summary>/gi)).toHaveLength(1);
		expect(rendered.match(/<\/summary>/gi)).toHaveLength(1);
	});

	it("preserves embedded HTML, JSX, and XML summary elements", () => {
		const embedded =
			'HTML <summary>details</summary>; JSX <summary id="jsx">component</summary>; XML <summary kind="xml">node</summary>.';
		expect(renderCompactionSummaryContext(embedded)).toContain(embedded);
		expect(renderBranchSummaryContext(embedded)).toContain(embedded);
	});

	it("removes only the enclosing wrapper and preserves a nested summary element", () => {
		const rendered = renderCompactionSummaryContext(
			'<summary data-source="legacy">before <summary id="embedded">details</summary> after</summary>',
		);
		expect(rendered).toContain('before <summary id="embedded">details</summary> after');
	});

	it("preserves sibling summary elements that do not form one enclosing wrapper", () => {
		const siblings = "<summary>first</summary> connective text <summary>second</summary>";
		expect(renderCompactionSummaryContext(siblings)).toContain(siblings);
	});
});

describe("createBranchSummaryMessage", () => {
	it("builds a branchSummary with the ISO timestamp parsed to epoch ms", () => {
		const iso = "2026-05-30T12:00:00.000Z";
		const msg = createBranchSummaryMessage("branch recap", "msg-42", iso);
		expect(msg).toEqual({
			role: "branchSummary",
			summary: "branch recap",
			fromId: "msg-42",
			timestamp: new Date(iso).getTime(),
		});
	});
});

describe("createCustomMessage", () => {
	it("carries every field through and parses the ISO timestamp", () => {
		const iso = "2026-05-30T12:00:00.000Z";
		const details = { toolCallId: "c1" };
		const msg = createCustomMessage("tool-status", "running read", true, details, iso, "agent");
		expect(msg).toEqual({
			role: "custom",
			customType: "tool-status",
			content: "running read",
			display: true,
			details,
			attribution: "agent",
			timestamp: new Date(iso).getTime(),
		});
	});

	it("leaves attribution undefined when the caller omits it", () => {
		const msg = createCustomMessage("note", "hello", false, undefined, "2026-01-01T00:00:00.000Z");
		expect(msg.attribution).toBeUndefined();
		expect(msg.details).toBeUndefined();
		expect(msg.display).toBe(false);
	});
});

describe("convertMessageToLlm: compaction roles", () => {
	it("maps a string-content custom message to a developer message with a text block", () => {
		const converted = convertMessageToLlm(
			agentMessage({
				role: "custom",
				customType: "hook",
				content: "hook fired",
				display: true,
				attribution: "user",
				timestamp: 1000,
			}),
		);
		expect(converted).toEqual({
			role: "developer",
			content: [{ type: "text", text: "hook fired" }],
			attribution: "user",
			timestamp: 1000,
		});
	});

	it("passes array content through unchanged for a custom message", () => {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: "look" }, image];
		const converted = convertMessageToLlm(
			agentMessage({ role: "custom", customType: "hook", content, display: true, timestamp: 2000 }),
		);
		expect(converted?.role).toBe("developer");
		expect(converted?.content).toBe(content);
		expect(attributionOf(converted)).toBeUndefined();
	});

	it("maps a legacy hookMessage the same way as a custom message", () => {
		const converted = convertMessageToLlm(
			agentMessage({
				role: "hookMessage",
				customType: "legacy",
				content: "legacy hook",
				display: false,
				timestamp: 3000,
			}),
		);
		expect(converted).toEqual({
			role: "developer",
			content: [{ type: "text", text: "legacy hook" }],
			attribution: undefined,
			timestamp: 3000,
		});
	});

	it("renders a branchSummary into agent-attributed developer context without private delimiters", () => {
		const converted = convertMessageToLlm(
			agentMessage({ role: "branchSummary", summary: "the branch", fromId: "m1", timestamp: 4000 }),
		);
		expect(converted?.role).toBe("developer");
		expect(attributionOf(converted)).toBe("agent");
		expect(converted?.timestamp).toBe(4000);
		const [block] = converted!.content as TextContent[];
		expect(block.type).toBe("text");
		expect(block.text).toContain("the branch");
		expect(block.text).not.toContain("<summary>");
		expect(block.text).not.toContain("</summary>");
	});

	/**
	 * The trust boundary that actually ships is the ROLE, not the wording: a
	 * compaction summary is model-generated history, so it enters as `user`
	 * content attributed to the agent and can never outrank a live developer
	 * message. This landed today; the matching prompt wording did not, because
	 * upstream's wrapper text is pinned verbatim. The earlier
	 * `toContain("non-authoritative")` assertions named that never-written wording
	 * and are replaced with the wrapper that is really emitted.
	 */
	it("renders a blockless compactionSummary as agent-attributed untrusted user history", () => {
		const converted = convertMessageToLlm(
			agentMessage({ role: "compactionSummary", summary: "prior recap", tokensBefore: 10, timestamp: 5000 }),
		);
		expect(converted?.role).toBe("user");
		expect(attributionOf(converted)).toBe("agent");
		const content = converted?.content as Array<TextContent | ImageContent>;
		expect(content).toHaveLength(1);
		expect((content[0] as TextContent).text).toBe(renderCompactionSummaryContext("prior recap"));
	});

	/** Old image-archive sessions use the blocks branch and need the same trust boundary. */
	it("keeps legacy blocks in untrusted user history while stripping persisted summary wrappers", () => {
		const blocks: Array<TextContent | ImageContent> = [
			{ type: "text", text: "<SUMMARY data-old>old region</SUMMARY>" },
			image,
		];
		const converted = convertMessageToLlm(
			agentMessage({
				role: "compactionSummary",
				summary: "<summary>legacy recap</summary>",
				tokensBefore: 10,
				blocks,
				timestamp: 5001,
			}),
		);
		expect(converted?.role).toBe("user");
		expect(attributionOf(converted)).toBe("agent");
		const content = converted?.content as Array<TextContent | ImageContent>;
		expect(content).toHaveLength(3);
		expect((content[0] as TextContent).text).toBe(renderCompactionSummaryContext("legacy recap"));
		expect(content.slice(1)).toEqual([{ type: "text", text: "old region" }, image]);
		// Every persisted wrapper is gone; the only delimiters left are the one
		// pair the template itself writes around the summary body.
		expect(JSON.stringify(content)).not.toContain("data-old");
		expect(JSON.stringify(content).match(/<summary>/gi)).toHaveLength(1);
		expect(JSON.stringify(content).match(/<\/summary>/gi)).toHaveLength(1);
	});
});

describe("compaction summary provider trust boundary", () => {
	it("keeps current Cargo developer policy above a conflicting historical summary claim", () => {
		const cargoClaim = "Build with CARGO_TARGET_DIR=/tmp/<name>-target";
		const currentDeveloperPolicy = "Never override Cargo env and use the persistent shared `/srv/cargo-target`.";
		const serialized = defaultConvertToLlm([
			agentMessage({ role: "developer", content: currentDeveloperPolicy, timestamp: 6000 }),
			agentMessage({
				role: "compactionSummary",
				summary: `## Constraints & Preferences\n- ${cargoClaim}`,
				tokensBefore: 10,
				timestamp: 6001,
			}),
		]);

		expect(serialized.map(message => message.role)).toEqual(["developer", "user"]);
		expect(serialized[0]).toMatchObject({ role: "developer", content: currentDeveloperPolicy });
		const historicalText = (serialized[1]!.content as TextContent[])[0]!.text;
		expect(historicalText).toBe(renderCompactionSummaryContext(`## Constraints & Preferences\n- ${cargoClaim}`));
		expect(historicalText).toContain(cargoClaim);
	});
});

describe("convertMessageToLlm: core roles", () => {
	it("defaults a developer message attribution to agent and preserves an explicit one", () => {
		const defaulted = convertMessageToLlm(
			agentMessage({ role: "developer", content: [{ type: "text", text: "dev" }], timestamp: 10 }),
		);
		expect(defaulted).toEqual({
			role: "developer",
			content: [{ type: "text", text: "dev" }],
			timestamp: 10,
			attribution: "agent",
		});

		const explicit = convertMessageToLlm(
			agentMessage({
				role: "developer",
				content: [{ type: "text", text: "dev" }],
				attribution: "user",
				timestamp: 11,
			}),
		);
		expect(attributionOf(explicit)).toBe("user");
	});

	it("defaults a user message attribution to user", () => {
		const converted = convertMessageToLlm(
			agentMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 20 }),
		);
		expect(converted?.role).toBe("user");
		expect(attributionOf(converted)).toBe("user");
	});

	it("returns an assistant message untouched", () => {
		const assistant = agentMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 30 });
		expect(convertMessageToLlm(assistant)).toBe(assistant as unknown as Message);
	});

	it("drops an unknown role by returning undefined", () => {
		expect(convertMessageToLlm(agentMessage({ role: "appOnly", content: "x", timestamp: 40 }))).toBeUndefined();
	});
});

describe("convertMessageToLlm: pruned tool results", () => {
	function toolResult(fields: Partial<ToolResultMessage>): AgentMessage {
		return {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			isError: false,
			content: [],
			timestamp: 100,
			...fields,
		} as unknown as AgentMessage;
	}

	it("passes an unpruned tool result content through unchanged", () => {
		const content: TextContent[] = [{ type: "text", text: "full output" }];
		const converted = convertMessageToLlm(toolResult({ content }));
		expect(converted?.content).toBe(content);
		expect(attributionOf(converted)).toBe("agent");
	});

	it("collapses a pruned tool result to a single joined text block", () => {
		const converted = convertMessageToLlm(
			toolResult({
				prunedAt: 12345,
				content: [{ type: "text", text: "part one " }, image, { type: "text", text: "part two" }],
			}),
		);
		expect(converted?.content).toEqual([{ type: "text", text: "part one part two" }]);
	});

	it("substitutes the truncation marker when a pruned result has no text blocks", () => {
		const converted = convertMessageToLlm(toolResult({ prunedAt: 12345, content: [image] }));
		expect(converted?.content).toEqual([{ type: "text", text: "[Output truncated]" }]);
	});
});

describe("defaultConvertToLlm", () => {
	it("maps every convertible message and drops the undefined ones", () => {
		const messages: AgentMessage[] = [
			agentMessage({ role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 }),
			agentMessage({ role: "appOnly", content: "drop me", timestamp: 2 }),
			agentMessage({ role: "branchSummary", summary: "recap", fromId: "m", timestamp: 3 }),
		];
		const converted = defaultConvertToLlm(messages);
		expect(converted).toHaveLength(2);
		expect(converted[0]!.role).toBe("user");
		expect(converted[1]!.role).toBe("developer");
		expect(attributionOf(converted[1])).toBe("agent");
	});
});
