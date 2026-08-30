import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SERVER_COMPACTION_WIRE_APIS } from "@veyyon/ai/providers/openai-compaction";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	COMPACTION_KIND_LABEL,
	type CompactionKind,
	CompactionSummaryMessageComponent,
	compactionActionLabel,
	createHandoffSummaryMessageComponent,
	HandoffSummaryMessageComponent,
	REMOTE_COMPACTION_KIND_BY_API,
	resolveCompactionKind,
} from "@veyyon/coding-agent/modes/terminal/components/transcript/compaction-summary-message";
import type { CustomMessage } from "@veyyon/coding-agent/session/messages";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { getKeybindings, setKeybindings } from "@veyyon/utils/keybindings";

const originalKeybindings = getKeybindings();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	resetSettingsForTest();
	setKeybindings(originalKeybindings);
});

function makeHandoffMessage(content: CustomMessage<unknown>["content"]): CustomMessage<unknown> {
	return {
		role: "custom",
		customType: "handoff",
		content,
		display: true,
		attribution: "agent",
		timestamp: Date.now(),
	};
}

describe("compaction summary divider", () => {
	/** Stored compaction summaries stay collapsed behind the transcript's Ctrl+O affordance. */
	it("renders a collapsed compaction divider instead of a user or assistant response", () => {
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "The parser fix is complete.",
			tokensBefore: 12_345,
			timestamp: Date.now(),
		});
		const collapsed = Bun.stripANSI(component.render(80).join("\n"));

		expect(collapsed).toContain("compacted");
		expect(collapsed).toContain("ctrl+o");
		expect(collapsed).not.toContain("The parser fix is complete.");
	});

	/**
	 * The divider names the chord currently bound to the same expand action its
	 * host handles. Rebinding after the component exists also invalidates the
	 * cached divider text on the next render.
	 */
	it("follows the live expand keybinding", () => {
		const previous = getKeybindings();
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "Summary",
			tokensBefore: 1,
			timestamp: Date.now(),
		});
		try {
			setKeybindings(new KeybindingsManager({ "app.tools.expand": "alt+e" }));
			expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("alt+e");
			setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+x" }));
			const rebound = Bun.stripANSI(component.render(80).join("\n"));
			expect(rebound).toContain("ctrl+x");
			expect(rebound).not.toContain("alt+e");
		} finally {
			setKeybindings(previous);
		}
	});

	/**
	 * An unbound expand action cannot be invoked, so the divider keeps its
	 * semantic label but drops both the nonexistent chord and its separator.
	 */
	it("omits the expand hint when the action is unbound", () => {
		const previous = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
			const component = new CompactionSummaryMessageComponent({
				role: "compactionSummary",
				summary: "Summary",
				tokensBefore: 1,
				timestamp: Date.now(),
			});
			const collapsed = Bun.stripANSI(component.render(80).join("\n"));
			expect(collapsed).toContain("compacted");
			expect(collapsed).not.toContain("ctrl+o");
			expect(collapsed).not.toContain("·");
		} finally {
			setKeybindings(previous);
		}
	});

	/** Expanding the divider reveals summary prose but never its private provider delimiter. */
	it("expands summary prose without rendering summary tags", () => {
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "<summary>\nThe parser fix is complete.\n</summary>",
			tokensBefore: 12_345,
			timestamp: Date.now(),
		});
		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(80).join("\n"));

		expect(expanded).toContain("Compacted from 12,345 tokens");
		expect(expanded).toContain("The parser fix is complete.");
		expect(expanded).not.toContain("<summary>");
		expect(expanded).not.toContain("</summary>");
	});
});

describe("handoff summary divider", () => {
	it("renders handoff custom messages with the compact divider instead of a framed block", () => {
		const component = createHandoffSummaryMessageComponent(
			makeHandoffMessage(
				`<handoff-context>\n# Goal\nContinue the resize fix.\n</handoff-context>\n\nThe above is a handoff document.`,
			),
			false,
		);

		expect(component).toBeInstanceOf(HandoffSummaryMessageComponent);
		const collapsed = Bun.stripANSI(component!.render(80).join("\n"));
		expect(collapsed).toContain("handoff");
		expect(collapsed).toContain("ctrl+o");
		expect(collapsed).not.toContain("[handoff]");
		expect(collapsed).not.toContain("Continue the resize fix");
	});

	it("expands to the handoff document without the provider-only XML wrapper", () => {
		const component = createHandoffSummaryMessageComponent(
			makeHandoffMessage([
				{
					type: "text",
					text: "<handoff-context>\n# Goal\nContinue the resize fix.\n</handoff-context>",
				},
			]),
			true,
		);

		expect(component).toBeInstanceOf(HandoffSummaryMessageComponent);
		const expanded = Bun.stripANSI(component!.render(80).join("\n"));
		expect(expanded).toContain("Handoff context");
		expect(expanded).toContain("Continue the resize fix");
		expect(expanded).not.toContain("<handoff-context>");
		expect(expanded).not.toContain("</handoff-context>");
	});

	it("leaves unrelated custom messages on the generic renderer path", () => {
		const message = makeHandoffMessage("Not a handoff.");
		message.customType = "extension-note";

		expect(createHandoffSummaryMessageComponent(message, false)).toBeUndefined();
	});
});

/**
 * WHY: the compaction loader used to name only a remote pass, and only ever as
 * "openai", so a local summarizer ran under a bare label and a codex or azure
 * remote pass was announced as openai. The class this closes is "a compaction
 * pass whose engine the operator cannot read off the screen": every member of
 * the kind space must produce a distinct named label, in both the manual and
 * the auto arm, and a new kind must turn this red rather than fall back to a
 * bare label.
 *
 * Not caught here: whether the engine actually took the route the label named.
 * The label reads the admission half of the gate, and a missing api key still
 * demotes a remote pass to local at run time; that fallback is announced by the
 * engine's own warning notice, covered in remote-compaction-write-path.test.ts.
 */
describe("compactionActionLabel", () => {
	const kinds = Object.keys(COMPACTION_KIND_LABEL) as CompactionKind[];

	it("covers exactly the kinds the resolver can produce", () => {
		expect(kinds.sort()).toEqual(["azure-remote", "codex-remote", "local", "openai-remote"]);
		for (const kind of Object.values(REMOTE_COMPACTION_KIND_BY_API)) {
			expect(COMPACTION_KIND_LABEL[kind]).toBeDefined();
		}
	});

	it("names the engine on every kind, in both the manual and the auto arm", () => {
		const seen = new Set<string>();
		for (const kind of kinds) {
			const manual = compactionActionLabel(false, kind);
			const auto = compactionActionLabel(true, kind);
			expect(manual).toBe(`Compacting context... (${COMPACTION_KIND_LABEL[kind]})`);
			expect(auto).toBe(`Auto-compacting context (${COMPACTION_KIND_LABEL[kind]})`);
			seen.add(COMPACTION_KIND_LABEL[kind]);
		}
		// Distinct names, or two engines read as one on screen.
		expect(seen.size).toBe(kinds.length);
	});

	it("never leaves a pass unnamed", () => {
		for (const kind of kinds) {
			expect(compactionActionLabel(false, kind)).not.toBe("Compacting context...");
			expect(compactionActionLabel(true, kind)).not.toBe("Auto-compacting context");
		}
	});
});

describe("resolveCompactionKind", () => {
	const session = (remote: boolean, api?: string) => ({
		settings: { get: (_key: "compaction.remote") => remote },
		model: api
			? ({
					api,
					provider: "test",
					id: "test-model",
					compat: { supportsServerCompaction: true },
				} as unknown as Parameters<typeof resolveCompactionKind>[0]["model"])
			: undefined,
	});

	it("reads local while the remote setting is off, whatever the model supports", () => {
		expect(resolveCompactionKind(session(false, "openai-responses"))).toBe("local");
	});

	it("reads local when no model is resolved", () => {
		expect(resolveCompactionKind(session(true))).toBe("local");
	});

	it("reads local for a model whose api serves no compact route", () => {
		expect(resolveCompactionKind(session(true, "anthropic-messages"))).toBe("local");
	});

	it("gives every server-compaction wire api a host name of its own", () => {
		// Derived from the transport's own admission table, so a new api that
		// gains a compact route turns this red until it is named here. Pinned by
		// exact equality, not by sweeping the map against itself: a codex model
		// mislabelled "openai remote" satisfies a self-consistent sweep.
		expect(REMOTE_COMPACTION_KIND_BY_API).toEqual({
			"openai-responses": "openai-remote",
			"azure-openai-responses": "azure-remote",
			"openai-codex-responses": "codex-remote",
		});
		expect(Object.keys(REMOTE_COMPACTION_KIND_BY_API).sort()).toEqual(
			Object.keys(SERVER_COMPACTION_WIRE_APIS).sort(),
		);
		// Three hosts, three names: one shared name hides which route ran.
		expect(new Set(Object.values(REMOTE_COMPACTION_KIND_BY_API)).size).toBe(
			Object.keys(REMOTE_COMPACTION_KIND_BY_API).length,
		);
	});

	it("names the host for every api that serves a compact route", () => {
		for (const [api, kind] of Object.entries(REMOTE_COMPACTION_KIND_BY_API)) {
			expect(resolveCompactionKind(session(true, api))).toBe(kind);
		}
	});
});
