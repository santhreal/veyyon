/**
 * WHY: `PresentationContext` is the seam a renderer implements. A session
 * calls it and reaches past it for nothing else, so a member silently removed
 * or renamed here breaks every renderer at once, and one silently ADDED breaks
 * every renderer that does not learn about it — including the ones outside this
 * repository, which is the whole reason the contract lives in a
 * dependency-free package.
 *
 * The class this suite defends: a drift between the contract and its
 * implementors, in either direction. `#reference` below is a complete
 * implementation, so ADDING a member fails to compile here; the pinned key set
 * makes REMOVING or renaming one fail the assertion.
 *
 * What it does not catch: a member whose signature changed compatibly (a
 * widened parameter type), and any behavioral promise a type cannot state — an
 * implementor that accepts `appendTranscriptBlock` and draws nothing still
 * satisfies this suite. It also says nothing about whether the terminal driver
 * is wired to a session; that is the driver's own integration test.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as composerModule from "../src/presentation/composer";
import * as contextModule from "../src/presentation/context";
import * as eventsModule from "../src/presentation/events";
import * as barrel from "../src/presentation/index";
import {
	type ComposerState,
	DIALOG_KINDS,
	type DialogResult,
	type DialogViewModel,
	type OverlayHandle,
	type OverlayViewModel,
	type PresentationCapabilities,
	type PresentationContext,
	type PresentationTheme,
	type StatusLineState,
	TRANSCRIPT_BLOCK_KINDS,
	type TranscriptBlock,
	UI_EVENT_TYPES,
	type UIEvent,
} from "../src/presentation/index";
import * as overlayModule from "../src/presentation/overlay";
import * as statusModule from "../src/presentation/status";
import * as themeModule from "../src/presentation/theme";
import * as transcriptModule from "../src/presentation/transcript";
import * as viewModelsModule from "../src/presentation/view-models";

/**
 * Every module in the layer, by its path under `packages/wire/src`. The package
 * publishes one entry point (`./presentation`), so a module the barrel does not
 * re-export is unreachable for a consumer no matter what it declares.
 */
const PRESENTATION_MODULES: Record<string, Record<string, unknown>> = {
	"presentation/composer.ts": composerModule,
	"presentation/context.ts": contextModule,
	"presentation/events.ts": eventsModule,
	"presentation/overlay.ts": overlayModule,
	"presentation/status.ts": statusModule,
	"presentation/theme.ts": themeModule,
	"presentation/transcript.ts": transcriptModule,
	"presentation/view-models.ts": viewModelsModule,
};

/**
 * A complete `PresentationContext`. It records nothing and draws nothing: its
 * only job is to fail compilation the moment the contract grows a member.
 */
class ReferenceContext implements PresentationContext {
	running = false;
	scrollPosition = 0;
	scrollable = false;
	width = 80;
	height = 24;
	capabilities: PresentationCapabilities = {
		images: false,
		trueColor: false,
		mouse: false,
		hyperlinks: false,
		nativeScrollback: false,
		textStyles: false,
	};

	#handlers = new Set<(event: UIEvent) => void>();
	blocks: TranscriptBlock[] = [];

	start(): void {
		this.running = true;
	}

	stop(): void {
		this.running = false;
	}

	setTranscriptBlocks(blocks: readonly TranscriptBlock[]): void {
		this.blocks = [...blocks];
	}

	appendTranscriptBlock(block: TranscriptBlock): void {
		this.blocks.push(block);
	}

	updateTranscriptBlock(id: string, patch: Partial<TranscriptBlock>): void {
		const index = this.blocks.findIndex(block => block.id === id);
		if (index === -1) return;
		// A patch never changes `kind`, so the merge stays within the member's own shape.
		const merged = { ...this.blocks[index]!, ...patch } as TranscriptBlock;
		this.blocks[index] = merged;
	}

	removeTranscriptBlock(id: string): void {
		this.blocks = this.blocks.filter(block => block.id !== id);
	}

	clearTranscript(): void {
		this.blocks = [];
	}

	setStatusLine(_state: StatusLineState): void {}
	setComposerState(_state: ComposerState): void {}
	focusComposer(): void {}

	async showDialog(_dialog: DialogViewModel): Promise<DialogResult> {
		return { outcome: "cancelled" };
	}

	showOverlay(overlay: OverlayViewModel): OverlayHandle {
		return { id: overlay.id, close: () => {}, update: () => {} };
	}

	closeOverlay(_id: string): void {}
	scrollToLive(): void {}
	scrollBy(_rows: number): void {}
	setTheme(_theme: PresentationTheme): void {}

	onInput(handler: (event: UIEvent) => void): () => void {
		this.#handlers.add(handler);
		return () => {
			this.#handlers.delete(handler);
		};
	}

	/** Test-only: deliver an event as a renderer would. */
	emit(event: UIEvent): void {
		for (const handler of this.#handlers) handler(event);
	}
}

/** Every member of the contract, pinned by exact equality. */
const CONTRACT_MEMBERS = [
	"appendTranscriptBlock",
	"capabilities",
	"clearTranscript",
	"closeOverlay",
	"focusComposer",
	"height",
	"onInput",
	"removeTranscriptBlock",
	"running",
	"scrollBy",
	"scrollPosition",
	"scrollToLive",
	"scrollable",
	"setComposerState",
	"setStatusLine",
	"setTheme",
	"setTranscriptBlocks",
	"showDialog",
	"showOverlay",
	"start",
	"stop",
	"updateTranscriptBlock",
	"width",
] as const satisfies readonly (keyof PresentationContext)[];

function memberNames(instance: ReferenceContext): string[] {
	const own = Object.keys(instance);
	const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).filter(
		name => name !== "constructor" && name !== "emit" && name !== "blocks",
	);
	return [...new Set([...own, ...proto])].filter(name => name !== "blocks" && name !== "emit").sort();
}

describe("the presentation contract is locked", () => {
	test("declares exactly the pinned member set", () => {
		expect(memberNames(new ReferenceContext())).toEqual([...CONTRACT_MEMBERS]);
	});

	test("a renderer receives every event it subscribed to and stops on unsubscribe", () => {
		const context = new ReferenceContext();
		const seen: UIEvent[] = [];
		const unsubscribe = context.onInput(event => seen.push(event));
		context.emit({ type: "interrupt" });
		unsubscribe();
		context.emit({ type: "scroll", delta: -3 });
		expect(seen).toEqual([{ type: "interrupt" }]);
	});

	test("transcript mutation is by id and unknown ids are ignored rather than throwing", () => {
		const context = new ReferenceContext();
		context.appendTranscriptBlock({
			kind: "user-message",
			id: "a",
			text: "first",
			attachments: [],
			timestamp: 1,
		});
		context.updateTranscriptBlock("a", { text: "edited" });
		context.updateTranscriptBlock("missing", { text: "ignored" });
		context.removeTranscriptBlock("missing");
		expect(context.blocks).toEqual([
			{ kind: "user-message", id: "a", text: "edited", attachments: [], timestamp: 1 },
		]);
		context.removeTranscriptBlock("a");
		expect(context.blocks).toEqual([]);
	});

	test("union tables enumerate their members once, with no duplicates", () => {
		for (const table of [TRANSCRIPT_BLOCK_KINDS, UI_EVENT_TYPES, DIALOG_KINDS]) {
			expect(new Set(table).size).toBe(table.length);
		}
	});

	test("the transcript covers every AgentMessage variant the session can hold", () => {
		// Sourced from the union itself, not from a copy: the exhaustiveness lock in
		// `transcript.ts` fails the build when a member is missing from the table, so
		// this pins WHICH members exist and refuses a silent removal.
		expect([...TRANSCRIPT_BLOCK_KINDS].sort()).toEqual([
			"assistant-message",
			"bash-execution",
			"branch-summary",
			"compaction-summary",
			"custom",
			"developer-message",
			"error",
			"file-mention",
			"hook",
			"python-execution",
			"tool-execution",
			"user-message",
		]);
	});
});

describe("the presentation barrel reaches every module in the layer", () => {
	test("the module table names exactly the files that exist", () => {
		// Read from the directory rather than a list in someone's head: a module
		// added without a line in the table above fails here.
		const directory = fileURLToPath(new URL("../src/presentation", import.meta.url));
		const present = readdirSync(directory)
			.filter(name => name.endsWith(".ts") && name !== "index.ts")
			.map(name => `presentation/${name}`)
			.sort();
		expect(present).toEqual(Object.keys(PRESENTATION_MODULES).sort());
	});

	test.each(Object.entries(PRESENTATION_MODULES))("%s is re-exported by the barrel", (_key, module) => {
		const exported = Object.entries(module).filter(([name]) => name !== "default");
		for (const [name, value] of exported) {
			expect(barrel).toHaveProperty(name);
			expect((barrel as Record<string, unknown>)[name]).toBe(value);
		}
	});
});
