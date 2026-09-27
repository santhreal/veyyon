/**
 * WHY: a session records eight kinds of message that are neither a prompt nor a model reply — a
 * background job that finished, diagnostics that arrived after a turn, a guest's prompt, a skill
 * invocation, agent-to-agent traffic, an advisor note, a dispatched tangent and a handoff summary.
 * What separates them is carried in `customType` and `details`, beside the text rather than inside
 * it. The desktop host sent the text alone, so all eight reached the window as undifferentiated
 * paragraphs: an IRC message named neither agent, a finished job read as prose, and a guest's
 * prompt was indistinguishable from the model's own words.
 *
 * CLASS CLOSED: a custom message whose kind is dropped on the way to the desktop. The variant space
 * is `CUSTOM_BLOCK_DISPLAY_VARIANTS`, swept at run time and held equal to the `CustomBlockDisplay`
 * union by the type check in the contract, so a ninth kind turns this red until it is projected and
 * its identity recorded here. Each variant is driven through both production paths — the stored
 * entry a reload reads and the live message a turn emits — and each is asserted to state the fact
 * that identifies it, so a projection that produces a block with the right label and none of the
 * message's own facts fails.
 *
 * NOT CAUGHT: how the window draws the view it is handed, which is the desktop's own rendering, and
 * the wording of a card, which is presentation rather than identity.
 */

import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { CUSTOM_BLOCK_DISPLAY_VARIANTS, type CustomBlockDisplay } from "@veyyon/wire/presentation";
import { agentMessageToTranscriptEntry, sessionEntryToTranscriptEntry } from "../../src/gui-host/transcript-conversion";
import type { ContentBlock } from "../../src/gui-host/wire";
import { customDisplayToView } from "../../src/presentation/custom-view";

type Variant = CustomBlockDisplay["variant"];

/** A recorded message, as the runtime writes one. */
interface Recorded {
	customType: string;
	details: unknown;
	content: string;
}

const TIMESTAMP = 1_700_000_000_000;

/**
 * One recorded message per variant, keyed by the variant it projects to, with the facts a reader
 * needs from it. The text is what the runtime persists for the model, which for several of these
 * kinds is not what a reader is shown: the tangent breadcrumb persists a system notice and shows
 * one line, and the IRC card persists the delivery and shows the message.
 */
const RECORDED: Record<Variant, { message: Recorded; states: readonly string[] }> = {
	"async-result": {
		message: {
			customType: "async-result",
			details: { jobs: [{ jobId: "bg_7", type: "bash", label: "cargo check", durationMs: 92_000 }] },
			content: "<system-notice>background job bg_7 finished</system-notice>",
		},
		states: ["Background job completed", "bg_7", "bash"],
	},
	"late-diagnostics": {
		message: {
			customType: "lsp-late-diagnostic",
			details: {
				files: [
					{
						path: "src/session/agent-session.ts",
						summary: "1 error",
						errored: true,
						messages: ["src/session/agent-session.ts:12:3: error TS2322: Type 'string' is not assignable"],
					},
				],
			},
			content: "diagnostics arrived after the turn",
		},
		states: ["agent-session.ts", "TS2322"],
	},
	"collab-prompt": {
		message: {
			customType: "collab-prompt",
			details: { from: "ada" },
			content: "restart the relay before you measure again",
		},
		states: ["ada", "restart the relay"],
	},
	"skill-prompt": {
		message: {
			customType: "skill-prompt",
			details: { name: "release-cut", path: "skills/release-cut/SKILL.md", args: "--dry", lineCount: 64 },
			content: "Cut a release only from a green commit on the default branch.",
		},
		states: ["release-cut", "skills/release-cut/SKILL.md", "--dry"],
	},
	irc: {
		message: {
			customType: "irc:incoming",
			details: { from: "Scout", to: "Main", message: "holding src/lib.rs until the rename lands" },
			content: "<system-notice>irc message from Scout</system-notice>",
		},
		states: ["Scout", "holding src/lib.rs"],
	},
	advisor: {
		message: {
			customType: "advisor",
			details: {
				notes: [
					{ note: "the retry loop has no ceiling", severity: "blocker", advisor: "reviewer" },
					{ note: "the fixture duplicates the one above it", severity: "nit" },
				],
			},
			content: "advisor notes",
		},
		states: ["Advisor", "the retry loop has no ceiling", "blocker"],
	},
	"background-tan": {
		message: {
			customType: "background-tan-dispatch",
			details: { jobId: "tan_3", work: "check whether the installer still resolves arm64" },
			content: "<system-notice>tangent dispatched</system-notice>",
		},
		states: ["Tangent dispatched", "tan_3", "installer still resolves"],
	},
	handoff: {
		message: {
			customType: "handoff",
			details: {},
			content: "prelude\n<handoff-context>the queue drains before the socket closes</handoff-context>",
		},
		states: ["Handoff summary", "the queue drains before the socket closes"],
	},
};

/** The rows a projected view states, flattened the way the window flattens one for copy and search. */
function viewRows(view: ContentBlock): string[] {
	if (!("Custom" in view)) return [];
	const rows: string[] = [];
	const push = (line: readonly { text: string }[] | undefined): void => {
		if (line) rows.push(line.map(span => span.text).join(" "));
	};
	const shape = view.Custom.view;
	if (shape.kind === "statusRow") {
		rows.push([shape.title, shape.description, shape.badge?.label].filter(Boolean).join(" "));
		for (const meta of shape.meta ?? []) push(meta);
	}
	if (shape.kind === "textBlock") push(shape.spans);
	if (shape.kind === "notice") {
		push(shape.headline);
		for (const line of shape.body ?? []) push(line);
	}
	if (shape.kind === "headedBlock" || shape.kind === "framedBlock") {
		const header = shape.header;
		if (header) {
			rows.push([header.title, header.description, header.badge?.label].filter(Boolean).join(" "));
			for (const meta of header.meta ?? []) push(meta);
		}
	}
	if (shape.kind === "headedBlock") for (const line of shape.lines) push(line);
	if (shape.kind === "framedBlock") {
		for (const section of shape.sections) {
			if (section.label) rows.push(section.label);
			for (const line of section.lines) push(line);
		}
	}
	return rows;
}

/** The stored entry a reload reads, for one recorded message. */
function storedEntry(message: Recorded): SessionEntry {
	return {
		type: "custom_message",
		id: `entry-${message.customType}`,
		timestamp: new Date(TIMESTAMP).toISOString(),
		customType: message.customType,
		content: message.content,
		details: message.details,
		display: true,
	} as SessionEntry;
}

/** The live message a turn emits, for one recorded message. */
function liveMessage(message: Recorded): Parameters<typeof agentMessageToTranscriptEntry>[0] {
	return {
		role: "custom",
		customType: message.customType,
		content: message.content,
		details: message.details,
		timestamp: TIMESTAMP,
		display: true,
	} as Parameters<typeof agentMessageToTranscriptEntry>[0];
}

describe("a message that is not the conversation says what it is", () => {
	test.each([...CUSTOM_BLOCK_DISPLAY_VARIANTS])("a stored %s message reaches the desktop as its kind", variant => {
		const { message, states } = RECORDED[variant];
		const entry = sessionEntryToTranscriptEntry(storedEntry(message), 1);
		expect(entry.content).toHaveLength(1);
		const block = entry.content[0];
		expect(block).toHaveProperty("Custom");
		if (!("Custom" in block)) throw new Error("not a custom block");
		expect(block.Custom.variant).toBe(variant);
		const rows = viewRows(block).join("\n");
		for (const fact of states) expect(rows).toContain(fact);
	});

	test.each([...CUSTOM_BLOCK_DISPLAY_VARIANTS])("a live %s message reaches the desktop as its kind", variant => {
		const { message, states } = RECORDED[variant];
		const entry = agentMessageToTranscriptEntry(liveMessage(message), 1, "live-1");
		expect(entry.content).toHaveLength(1);
		const block = entry.content[0];
		if (!("Custom" in block)) throw new Error("not a custom block");
		expect(block.Custom.variant).toBe(variant);
		const rows = viewRows(block).join("\n");
		for (const fact of states) expect(rows).toContain(fact);
	});

	test("a message of no recorded kind keeps its text", () => {
		const entry = sessionEntryToTranscriptEntry(
			storedEntry({ customType: "extension-notice", details: {}, content: "the extension reloaded" }),
			1,
		);
		expect(entry.content).toEqual([{ Text: { text: "the extension reloaded" } }]);
	});

	test("a message the session recorded as hidden draws nothing", () => {
		const hidden = { ...storedEntry(RECORDED.irc.message), display: false } as SessionEntry;
		expect(sessionEntryToTranscriptEntry(hidden, 1).content).toEqual([]);
	});

	/**
	 * Late diagnostics is the one kind whose card states nothing when the message carries no
	 * diagnostic, and the terminal draws nothing for it either. Pinned by exact equality, so a second
	 * kind that starts returning nothing has to be recorded here rather than silently losing its
	 * message.
	 */
	test("only an empty diagnostics message falls back to its text", () => {
		const empty = CUSTOM_BLOCK_DISPLAY_VARIANTS.filter(variant => {
			const display = emptyDisplay(variant);
			return display !== undefined && customDisplayToView(display) === undefined;
		});
		expect(empty).toEqual(["late-diagnostics"]);
	});
});

/** The same kind of display with nothing in it, for the kinds that can carry nothing. */
function emptyDisplay(variant: Variant): CustomBlockDisplay | undefined {
	switch (variant) {
		case "async-result":
			return { variant, jobs: [] };
		case "late-diagnostics":
			return { variant, files: [] };
		case "collab-prompt":
			return { variant, from: "", text: "" };
		case "skill-prompt":
			return { variant, name: "", text: "" };
		case "irc":
			return { variant, kind: "incoming" };
		case "advisor":
			return { variant, notes: [] };
		case "background-tan":
			return { variant, jobId: "" };
		case "handoff":
			return { variant, summary: "" };
	}
}
