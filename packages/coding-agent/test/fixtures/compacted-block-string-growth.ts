/**
 * What a transcript block keeps alive once its rows leave the frame, measured in the process that
 * runs this file.
 *
 * Builds every kind of transcript block the terminal draws: two groups per message role, drawn through
 * the transcript builder a resumed session uses with its blocks collapsed and expanded; two per
 * specialized custom display, which the builder draws in place of a custom message's generic block;
 * two per setting that adds a block of its own to a role's transcript; and one group per gallery tool
 * holding that tool's card in each resting state, collapsed and expanded. A group
 * repeats its blocks until its first draw holds at least `argv[2]` characters, so a group of short
 * blocks is as visible as one of long blocks.
 * The container draws them, is told every row is in native scrollback, and draws again, which drops
 * the blocks from its frame. The string bytes live after the drop, less the bytes live before the
 * first draw, are what the dropped blocks kept of the rows they drew. A replay then draws every block
 * again from its source.
 *
 * `argv[3]` names the groups to measure, comma-separated: a role, `display:<variant>`,
 * `<role>:<setting group>`, each with an optional `:expanded`, or `card:<tool>`.
 * Prints, as JSON, one {@link CompactedBlockReport}. `list` in place of the character count prints
 * the groups instead, as one {@link CompactedBlockGroups}, and measures nothing.
 *
 * Run in a fresh process: the snapshot reads the whole heap, and a test runner's heap holds whatever
 * the files before it left behind.
 */
import { setSystemTime } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { ImageContent } from "@veyyon/ai";
import {
	buildGalleryCard,
	GALLERY_STATES,
	galleryToolNames,
	resolveFixture,
} from "@veyyon/coding-agent/cli/gallery-cli";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import type { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import { UiHelpers, type UiHelpersContext } from "@veyyon/coding-agent/modes/terminal/utils/ui-helpers";
import { toTranscriptBlock } from "@veyyon/coding-agent/presentation/transcript-builder";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
} from "@veyyon/coding-agent/session/messages";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import { TUI } from "@veyyon/tui";
import { postmortem } from "@veyyon/utils";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@veyyon/wire";
import type { CustomBlockDisplay } from "@veyyon/wire/presentation";
import { settleFrames } from "../../../../hosts/terminal/engine/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../hosts/terminal/engine/test/virtual-terminal";
import { liveStringBytes } from "../../../utils/test/helpers/live-string-bytes";

export interface CompactedBlockGrowth {
	/** A message role, `display:<variant>`, `<role>:<setting group>` (each optionally `:expanded`), or `card:<tool>`. */
	group: string;
	/** Root blocks the container held. */
	blocks: number;
	/** Constructor names of the root blocks, each once, in first-seen order. */
	kinds: string[];
	/** Characters of the rows the first draw returned. */
	rowChars: number;
	/** Rows the container still returned after it was told every row is in scrollback. */
	keptRows: number;
	/** String bytes live after the drop, less the bytes live before the first draw. */
	grown: number;
	/** Whether a replay drew the same rows the first draw did. */
	replayMatches: boolean;
	/** Rows of the engine's screen in the resumed paint. */
	screenRows: number;
	/** Rows the resumed paint drew: every block, with its separator. */
	paintedRows: number;
	/** Rows of the group's tallest block, drawn alone. */
	tallestRows: number;
	/** Rows of the engine's composed frame once the resumed paint settled. */
	framedRows: number;
}

export interface CompactedBlockReport {
	groups: CompactedBlockGrowth[];
}

export interface CompactedBlockGroups {
	/**
	 * Every group, in declaration order: each role, each custom display and each setting group,
	 * collapsed and expanded, then one per carded tool.
	 */
	groups: string[];
	/** Gallery tools whose fixture draws no card, so no card group measures them. */
	cardless: string[];
}

const WIDTH = 100;
/** Rows of the terminal the resumed paint draws on. */
const SCREEN_ROWS = 16;

const BODY = [
	"The session reader walks the file once and keeps each entry's offset.",
	"",
	"```ts",
	"export function summarize(input: string): string {",
	"\treturn input.trim().split(/\\s+/).slice(0, 40).join(' ');",
	"}",
	"```",
	"",
	"- **first**: the offset index",
	"- **second**: the cold payload store",
	"",
	"| column | meaning |",
	"| --- | --- |",
	"| offset | byte position of the entry |",
	"| size | encoded length |",
].join("\n");

const OUTPUT = Array.from({ length: 24 }, (_, i) => `line ${i}: ${"x".repeat(40 + (i % 7) * 5)}`).join("\n");

const IMAGE: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };

const USAGE = { input: 713, output: 127, cacheRead: 0, cacheWrite: 0, totalTokens: 840 };
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistant(content: unknown[], stopReason: "stop" | "toolUse"): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: { ...USAGE, cost: COST },
		stopReason,
		timestamp: 1,
	} as AgentMessage;
}

/**
 * One transcript's worth of each role. A `Record` over the role union, so a role added to the
 * session vocabulary fails the type check until it has a sample here.
 */
const ROLE_SAMPLES: Record<AgentMessage["role"], AgentMessage[]> = {
	user: [{ role: "user", content: BODY, timestamp: 1 }],
	developer: [{ role: "developer", content: BODY, timestamp: 1 }],
	assistant: [
		assistant(
			[
				{ type: "thinking", thinking: BODY },
				{ type: "text", text: BODY },
			],
			"stop",
		),
	],
	toolResult: [
		assistant(
			[
				{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/session.ts" } },
				{ type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "rg summarize" } },
			],
			"toolUse",
		),
		{
			role: "toolResult",
			toolCallId: "call-read",
			toolName: "read",
			content: [{ type: "text", text: OUTPUT }],
			isError: false,
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "call-bash",
			toolName: "bash",
			content: [{ type: "text", text: OUTPUT }],
			isError: false,
			timestamp: 1,
		},
	],
	custom: [{ role: "custom", customType: "note", content: BODY, display: true, timestamp: 1 }],
	hookMessage: [{ role: "hookMessage", customType: "note", content: BODY, display: true, timestamp: 1 }],
	branchSummary: [{ role: "branchSummary", summary: BODY, fromId: "entry-1", timestamp: 1 }],
	compactionSummary: [{ role: "compactionSummary", summary: BODY, tokensBefore: 10_000, timestamp: 1 }],
	bashExecution: [
		{
			role: "bashExecution",
			command: "rg summarize",
			output: OUTPUT,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		},
	],
	pythonExecution: [
		{
			role: "pythonExecution",
			code: "print(summarize(text))",
			output: OUTPUT,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		},
	],
	fileMention: [
		{
			role: "fileMention",
			files: [
				{ path: "notes.md", content: BODY, lineCount: 15 },
				{ path: "shot.png", content: "", image: IMAGE },
			],
			timestamp: 1,
		},
	],
};

function custom(customType: string, details: unknown, content: string = BODY): AgentMessage {
	return { role: "custom", customType, content, details, display: true, timestamp: 1 } as AgentMessage;
}

/**
 * One custom message per specialized display the transcript builder draws in place of a custom
 * message's generic block, keyed by the variant it projects to. A `Record` over the variant union, so
 * a variant added to the wire vocabulary fails the type check until it has a sample here; a sample
 * that projects to another variant, or to none, fails the run.
 */
const DISPLAY_SAMPLES: Record<CustomBlockDisplay["variant"], AgentMessage> = {
	"async-result": custom("async-result", {
		jobs: Array.from({ length: 6 }, (_, i) => ({
			jobId: `job-${i}`,
			type: "bash",
			label: `rg summarize ${i}`,
			durationMs: 1_200 + i,
		})),
	}),
	"late-diagnostics": custom(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, {
		files: [
			{ path: "src/session.ts", summary: "2 errors", errored: true, messages: OUTPUT.split("\n").slice(0, 6) },
			{ path: "src/reader.ts", summary: "1 warning", errored: false, messages: OUTPUT.split("\n").slice(6, 9) },
		],
	}),
	"collab-prompt": custom(COLLAB_PROMPT_MESSAGE_TYPE, { from: "guest" }),
	"skill-prompt": custom(SKILL_PROMPT_MESSAGE_TYPE, {
		name: "review",
		path: "skills/review/SKILL.md",
		args: "src/session.ts",
		lineCount: 15,
		promptBytes: BODY.length,
	}),
	irc: custom("irc:incoming", { from: "Reviewer", to: "Main", message: BODY }),
	advisor: custom("advisor", {
		notes: [
			{ note: BODY, severity: "concern" },
			{ note: OUTPUT, severity: "blocker", advisor: "security" },
			{ note: BODY, severity: "nit" },
			{ note: BODY },
		],
	}),
	"background-tan": custom(BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE, {
		jobId: "tan-1",
		work: BODY,
		sessionFile: "sessions/tan.jsonl",
	}),
	handoff: custom("handoff", {}, `<handoff-context>\n${BODY}\n</handoff-context>`),
};

const DISPLAY_GROUP = "display:";

/** The display variant `message` projects to, as the transcript builder reads it. */
function projectedVariant(message: AgentMessage): string | undefined {
	const block = toTranscriptBlock(message, { index: 0 });
	return block.kind === "custom" || block.kind === "hook" ? block.display?.variant : undefined;
}

type SettingOverrides = Partial<Record<SettingPath, unknown>>;

/**
 * Settings that add a block of their own to a role's transcript, each drawing one more pair of groups
 * for its role, `<role>:<name>` collapsed and expanded. The read result preview draws a code cell
 * under each read in the group the builder folds consecutive reads into.
 */
const SETTING_GROUPS: readonly { name: string; role: AgentMessage["role"]; settings: SettingOverrides }[] = [
	{ name: "preview", role: "toolResult", settings: { "read.toolResultPreview": true } },
];

/** Every role, in the order the table declares them. */
const ROLES = Object.keys(ROLE_SAMPLES) as AgentMessage["role"][];

/** A transcript builder that draws into `chat`, as the interactive mode's does, expanded or not. */
function helpersFor(chat: TranscriptContainer, expanded: boolean, settings: SettingOverrides): UiHelpers {
	const ctx = {
		chatContainer: chat,
		pendingTools: new Map<string, ToolExecutionComponent>(),
		settledToolCalls: new Set<string>(),
		ui: { requestRender() {}, requestComponentRender() {} },
		settings: Settings.isolated({ "display.showTokenUsage": false, ...settings }),
		toolOutputExpanded: expanded,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: false,
		lastAssistantUsage: undefined,
		editor: { seedHistory() {} },
		viewSession: {
			sessionManager: { getCwd: () => "/repo", putBlobSync: () => "fixture-blob" },
			getToolByName: () => undefined,
			extensionRunner: undefined,
			isStreaming: false,
			retryAttempt: 0,
		},
	};
	return new UiHelpers(ctx as unknown as UiHelpersContext);
}

/** A container holding `copies` of `sample`, drawn by the transcript builder. */
function transcriptContainer(
	sample: readonly AgentMessage[],
	copies: number,
	expanded: boolean,
	settings: SettingOverrides,
): TranscriptContainer {
	const chat = new TranscriptContainer();
	const messages: AgentMessage[] = [];
	for (let copy = 0; copy < copies; copy++) messages.push(...sample);
	helpersFor(chat, expanded, settings).renderSessionContext({ messages } as SessionContext);
	return chat;
}

/** The suffix naming a role group drawn with every block expanded. */
const EXPANDED = ":expanded";

/** The gallery states a finished card can rest in: the ones a transcript compacts. */
const RESTING_STATES = GALLERY_STATES.filter(state => state === "success" || state === "error");

const CARD_GROUP = "card:";

/** A container holding `copies` of every resting state of `tool`'s card, collapsed and expanded. */
async function cardContainer(tool: string, copies: number): Promise<TranscriptContainer> {
	const chat = new TranscriptContainer();
	const fixture = resolveFixture(tool);
	for (let copy = 0; copy < copies; copy++) {
		for (const state of RESTING_STATES) {
			for (const expanded of [false, true]) {
				const card = await buildGalleryCard(tool, fixture, state, expanded);
				card.stopAnimation();
				// A displaceable card (the todo board) stays live until its rows reach the
				// scrollback, where the container seals it. Sealed here, so the first draw is
				// the one the scrollback holds.
				if (card.isDisplaceableBlock()) card.seal();
				chat.addChild(card);
			}
		}
	}
	return chat;
}

/** A hash of `rows` in order, chained row by row so no joined copy of them is built. */
function digestOf(rows: readonly string[]): number | bigint {
	let digest: number | bigint = rows.length;
	for (const row of rows) digest = Bun.hash(row, digest);
	return digest;
}

/** Characters of the rows `chat` draws. */
function drawnChars(chat: TranscriptContainer): number {
	let chars = 0;
	for (const row of chat.render(WIDTH)) chars += row.length;
	return chars;
}

async function measure(
	group: string,
	build: (copies: number) => Promise<TranscriptContainer>,
	targetChars: number,
): Promise<CompactedBlockGrowth> {
	const probe = await build(1);
	const copies = Math.max(1, Math.ceil(targetChars / Math.max(1, drawnChars(probe))));
	probe.dispose();

	// A first pass through every step loads the group's renderers, highlighters and theme tables, so
	// the measured pass counts only what its own blocks keep.
	const warm = await build(copies);
	const warmRows = warm.render(WIDTH).length;
	warm.setNativeScrollbackRetainRows(0);
	warm.setNativeScrollbackCommittedRows(warmRows);
	warm.render(WIDTH);
	warm.prepareNativeScrollbackReplay();
	warm.render(WIDTH);
	warm.dispose();

	const chat = await build(copies);
	const before = await liveStringBytes();
	const first = chat.render(WIDTH);
	let rowChars = 0;
	for (const row of first) rowChars += row.length;
	const digest = digestOf(first);
	chat.setNativeScrollbackRetainRows(0);
	chat.setNativeScrollbackCommittedRows(first.length);
	const keptRows = chat.render(WIDTH).length;
	const grown = (await liveStringBytes()) - before;

	chat.prepareNativeScrollbackReplay();
	const replayMatches = digestOf(chat.render(WIDTH)) === digest;
	const blocks = chat.children.length;
	const kinds = [...new Set(chat.children.map(child => child.constructor.name))];
	chat.dispose();
	return { group, blocks, kinds, rowChars, keptRows, grown, replayMatches, ...(await paintResumed(build, copies)) };
}

/**
 * The group as a resumed session paints it: every block exists before the engine's first frame,
 * which draws them all at once and commits every row above its screen. What the engine composes
 * once that paint settles, with no frame requested after it, is what the resumed session holds
 * while it sits at rest.
 */
async function paintResumed(
	build: (copies: number) => Promise<TranscriptContainer>,
	copies: number,
): Promise<Pick<CompactedBlockGrowth, "screenRows" | "paintedRows" | "tallestRows" | "framedRows">> {
	const chat = await build(copies);
	const paintedRows = chat.render(WIDTH).length;
	let tallestRows = 0;
	for (const child of chat.children) tallestRows = Math.max(tallestRows, child.render(WIDTH).length);
	chat.dispose();

	const resumed = await build(copies);
	const term = new VirtualTerminal(WIDTH, SCREEN_ROWS, paintedRows + SCREEN_ROWS);
	const tui = new TUI(term);
	tui.addChild(resumed);
	tui.start();
	try {
		await settleFrames(term, tui);
		return { screenRows: SCREEN_ROWS, paintedRows, tallestRows, framedRows: tui.composedFrameRows };
	} finally {
		tui.stop();
		resumed.dispose();
	}
}

/** Every group, by name, with what builds it at a given copy count. */
function declaredGroups(cardless: readonly string[]): Map<string, (copies: number) => Promise<TranscriptContainer>> {
	const groups = new Map<string, (copies: number) => Promise<TranscriptContainer>>();
	const drawn = (name: string, sample: readonly AgentMessage[], settings: SettingOverrides = {}) => {
		groups.set(name, async copies => transcriptContainer(sample, copies, false, settings));
		groups.set(`${name}${EXPANDED}`, async copies => transcriptContainer(sample, copies, true, settings));
	};
	for (const role of ROLES) drawn(role, ROLE_SAMPLES[role]);
	for (const [variant, sample] of Object.entries(DISPLAY_SAMPLES)) {
		const projected = projectedVariant(sample);
		if (projected !== variant)
			throw new Error(`the ${variant} display sample projects to ${projected ?? "no display"}`);
		drawn(`${DISPLAY_GROUP}${variant}`, [sample]);
	}
	for (const { name, role, settings } of SETTING_GROUPS) drawn(`${role}:${name}`, ROLE_SAMPLES[role], settings);
	for (const tool of galleryToolNames()) {
		if (!cardless.includes(tool)) groups.set(`${CARD_GROUP}${tool}`, copies => cardContainer(tool, copies));
	}
	return groups;
}

if (import.meta.main) {
	try {
		// Cards draw elapsed times against the clock; a fixed one draws the replay's rows at the same
		// instant as the first draw's.
		setSystemTime(new Date("2026-01-15T12:00:00Z"));
		await Settings.init({ inMemory: true });
		await initTheme();
		const cardless = galleryToolNames().filter(tool => resolveFixture(tool).renderState !== undefined);
		const groups = declaredGroups(cardless);
		if (process.argv[2] === "list") {
			const listing: CompactedBlockGroups = { groups: [...groups.keys()], cardless };
			process.stdout.write(`${JSON.stringify(listing)}\n`);
		} else {
			const targetChars = Number(process.argv[2]);
			const selection = (process.argv[3] ?? "").split(",").filter(name => name !== "");
			if (!Number.isInteger(targetChars) || targetChars < 1 || selection.length === 0) {
				throw new Error("usage: compacted-block-string-growth.ts list | <target-chars> <group>[,<group>...]");
			}
			// The first heap snapshot of a process leaves strings of its own behind; this one is not counted.
			await liveStringBytes();
			const report: CompactedBlockReport = { groups: [] };
			for (const name of selection) {
				const build = groups.get(name);
				if (build === undefined) throw new Error(`no group named ${name}`);
				report.groups.push(await measure(name, build, targetChars));
			}
			process.stdout.write(`${JSON.stringify(report)}\n`);
		}
	} finally {
		await postmortem.cleanup();
	}
}
