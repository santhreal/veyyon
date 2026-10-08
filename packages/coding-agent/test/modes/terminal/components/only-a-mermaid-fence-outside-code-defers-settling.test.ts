/**
 * Only a Mermaid fence outside a code block defers native-scrollback settling.
 *
 * WHY THIS SUITE EXISTS. `AssistantMessageComponent` settles no rows while its streamed source holds
 * a ` ```mermaid ` fence, because the diagram renders asynchronously and can re-layout rows that
 * already looked final. The fence check runs on the whole streamed text on every delta and every
 * reveal tick, so it jumps between backtick and tilde runs instead of walking every line. Each jump
 * is a place to get CommonMark fence rules wrong without any existing test noticing: a line start
 * read at the run instead of the line, an indented code line read as a fence, a run in the middle
 * of a sentence read as one, two runs on one line processing that line twice, a backtick run and a
 * tilde run visited out of order, or a closing fence that is too short, has an info string, or uses
 * the other fence character read as a close.
 *
 * THE CLASS. Every fence rule the check applies has a case that opens a Mermaid fence and a case
 * that does not, labelled by hand from the rule rather than from the implementation. A case settles
 * the rows Markdown settles for the same text with the info word renamed, or none when it opens a
 * Mermaid fence outside code. Each case runs at the start of a reply and deep in a long one that
 * already opened and closed both fence kinds, so the scan reaches it by jumping over earlier runs of
 * both characters; and each runs followed by a paragraph and as the streamed tail, where its last
 * line has no newline yet. A case that no placement can observe fails the suite.
 *
 * WHAT THIS SUITE DOES NOT CATCH. Markdown settles no rows after a fence indented one to three
 * spaces, so the check's verdict on such a fence has no effect and is not observed. A CRLF line
 * never matches the fence pattern, so a ` ```mermaid\r ` line settles; no case pins that either
 * way. Thinking segments run the same check on their formatted text and are not driven here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/assistant-message";
import { clearMermaidCache } from "@veyyon/coding-agent/theme/mermaid-cache";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { AssistantMessageView } from "@veyyon/wire/presentation";

/** A fence layout and whether it opens a Mermaid diagram outside every code block. */
const CASES: [name: string, markdown: string, opens: boolean][] = [
	["a backtick mermaid fence", "```mermaid\nflowchart TD\n  A-->B", true],
	["a tilde mermaid fence", "~~~mermaid\nflowchart TD\n  A-->B", true],
	["a closed mermaid fence", "```mermaid\nflowchart TD\n  A-->B\n```", true],
	["a space before the info string", "``` mermaid\nflowchart TD", true],
	["three spaces of indent", "   ```mermaid\nflowchart TD", true],
	["an unterminated last line", "```mermaid", true],
	["a mermaid fence after a closed code block", "```ts\nconst a = 1;\n```\n\n```mermaid\nflowchart TD", true],
	["a mermaid fence after a block a longer fence closed", "```\nplain\n`````\n\n```mermaid\nflowchart TD", true],
	["four spaces of indent", "    ```mermaid\n    flowchart TD", false],
	["a longer info word", "```mermaidjs\nflowchart TD\n```", false],
	["a partial info word", "```mer", false],
	["a fence run inside a sentence", "Write ```mermaid at the start of a line to draw.", false],
	["mermaid inside a backtick block", "```md\n```mermaid\nflowchart TD\n```", false],
	["mermaid inside a tilde block", "~~~md\n```mermaid\nflowchart TD\n~~~", false],
	["mermaid inside a block a tilde line cannot close", "```md\n~~~\n```mermaid\nflowchart TD", false],
	["mermaid inside a block a shorter fence cannot close", "````md\n```\n```mermaid\n````", false],
	["mermaid inside a block a fence with an info string cannot close", "```md\n``` js\n```mermaid\n```", false],
	["mermaid inside a bare six-backtick block", "``````\n```mermaid\nflowchart TD\n``````", false],
	["mermaid after a line opening with a tilde run", "~~~ strike that ~~~\n```mermaid\nflowchart TD", false],
];

const INTRO = "Intro paragraph that is already byte-stable.\n\n";

/** A long reply that opens and closes both fence kinds before the case, between plain prose. */
const LONG_REPLY = [
	INTRO,
	...Array.from({ length: 120 }, (_, i) => `Line ${i} of the reply mentions \`code\` and \`\`pairs\`\` inline.\n`),
	"\n```ts\nconst before = 1;\n```\n\n",
	...Array.from({ length: 120 }, (_, i) => `Line ${i} after the first block.\n`),
	"\n~~~text\nplain block\n~~~\n\n",
].join("");

/** A paragraph that follows the case, so the case's last line ends in a newline. */
const TRAILER = "\n\nA closing paragraph that is still streaming";

function settledRows(text: string): number {
	const view: AssistantMessageView = {
		segments: [{ kind: "text", text }],
		model: "claude-sonnet-4-5",
		stopReason: "complete",
		timestamp: 0,
	};
	const component = new AssistantMessageComponent();
	component.updateContent(view, { transient: true });
	component.render(80);
	return component.getTranscriptBlockSettledRows();
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	clearMermaidCache();
});

afterEach(() => {
	resetSettingsForTest();
	clearMermaidCache();
});

/** Where a case sits in the reply. A streamed tail ends mid-line, while its fence line is arriving. */
const PLACEMENTS: [name: string, lead: string, trailer: string][] = [
	["after an intro paragraph, with a paragraph after it", INTRO, TRAILER],
	["after an intro paragraph, as the streamed tail", INTRO, ""],
	["deep in a long reply, with a paragraph after it", LONG_REPLY, TRAILER],
	["deep in a long reply, as the streamed tail", LONG_REPLY, ""],
];

/** The same text with no Mermaid fence: Markdown's own settled rows, with nothing deferred. */
function renamed(text: string): string {
	return text.replaceAll("mermaid", "diagram");
}

describe("only a mermaid fence outside code defers settling", () => {
	for (const [where, lead, trailer] of PLACEMENTS) {
		it(`every fence rule, ${where}`, () => {
			// Markdown settles fewer rows for some layouts on its own, so a case is read against the
			// same text with the info word renamed: it settles exactly those rows, or none when it
			// opens a Mermaid fence outside code.
			const expected = CASES.map(([name, markdown, opens]) => ({
				name,
				settled: opens ? 0 : settledRows(renamed(lead + markdown + trailer)),
			}));
			const actual = CASES.map(([name, markdown]) => ({ name, settled: settledRows(lead + markdown + trailer) }));
			expect(actual).toEqual(expected);
		});
	}

	it("every fence rule is observable in some placement except an indent Markdown never settles", () => {
		// A case whose renamed text settles no rows anywhere would pass whatever the Mermaid check
		// returned. Markdown settles nothing after a fence indented one to three spaces, so that
		// rule alone cannot be seen through settling.
		const unobservable = CASES.filter(([, markdown]) =>
			PLACEMENTS.every(([, lead, trailer]) => settledRows(renamed(lead + markdown + trailer)) === 0),
		).map(([name]) => name);
		expect(unobservable).toEqual(["three spaces of indent"]);
	});
});
