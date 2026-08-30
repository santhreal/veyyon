/**
 * A permission prompt whose command is long still shows the rows that answer it.
 *
 * WHY THIS SUITE EXISTS. The approval card is built from `formatApprovalCard`,
 * which puts the requested command in the body, and the option list is the LAST
 * child the selector draws. The card clipped its assembled body from the end to
 * fit the modal, so a command that wrapped past the body budget pushed "Approve",
 * "Approve for session", "Deny" and "Deny for session" off the bottom: a prompt
 * with nothing on screen to answer it, on the one surface where the operator has
 * to answer something before the run continues.
 *
 * THE CLASS THIS CLOSES is a fixed-height surface that sheds the wrong region.
 * The options are the reason the card exists and the title has a legible
 * substitute, so the rows come off the title and it says how many it lost. The
 * cases below sweep `APPROVAL_SELECT_OPTIONS` from the module rather than naming
 * the four labels, so a fifth approval row is covered the day it is added, and
 * they assert the pointer still lands on the right option after the elision —
 * the hit map is built from body rows, so a fix that trimmed rows without
 * rebuilding it would answer clicks with the wrong answer.
 *
 * WHAT IT DOES NOT CATCH: one terminal geometry per case, so nothing about how
 * the modal itself resizes between widths, and nothing about the embedded
 * presentation, where the host owns clipping and passes no budget.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { APPROVAL_SELECT_OPTIONS } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { HookSelectorComponent } from "@veyyon/coding-agent/modes/components/hook-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { formatApprovalCard } from "@veyyon/coding-agent/tools/approval";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 110;
const ROWS = 40;

let policy: AnsiPolicy;
let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: ROWS });
});

afterEach(() => {
	setAnsiPolicy(policy);
	geometry.restore();
});

/**
 * The subject an approval card is built from. `formatApprovalDetails` returns the
 * one `Command: …` line `BashTool` returns, which is the shape that overflows;
 * constructing the tool itself would need a whole session for one string.
 */
function bashSubject(command: string): Parameters<typeof formatApprovalCard>[0] {
	return { name: "bash", formatApprovalDetails: () => [`Command: ${command}`] };
}

function cardFor(command: string, onSelect: (label: string) => void = () => {}): HookSelectorComponent {
	return new HookSelectorComponent(
		formatApprovalCard(bashSubject(command), { command }),
		APPROVAL_SELECT_OPTIONS,
		onSelect,
		() => {},
		{ initialIndex: 0, selectionMarker: "radio" },
	);
}

/** An SGR left press at a 1-based screen row, mid-card. */
function clickAt(row1: number): string {
	return `\x1b[<0;40;${row1}M`;
}

/** A command long enough to wrap past the card's body budget at this geometry. */
const LONG_COMMAND = Array.from(
	{ length: 24 },
	(_, index) => `rsync --archive --verbose --compress --partial /srv/data/shard-${index}/ backup:/vol/shard-${index}/`,
).join(" && ");

const SHORT_COMMAND = "ls -la";

describe("an approval card whose command is long", () => {
	it("still draws every option row", () => {
		const plain = cardFor(LONG_COMMAND)
			.render(WIDTH)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		for (const option of APPROVAL_SELECT_OPTIONS) {
			expect(plain).toContain(option.label);
		}
	});

	it("says how much of the command it could not show", () => {
		const plain = cardFor(LONG_COMMAND)
			.render(WIDTH)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(plain).toMatch(/… \d+ more lines?/);
	});

	/**
	 * NON-VACUITY: a card that fits loses nothing and says nothing about losing it.
	 * Without this, dropping the whole title would pass the case above.
	 */
	it("shows the whole command and no elision when it fits", () => {
		const plain = cardFor(SHORT_COMMAND)
			.render(WIDTH)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(plain).toContain(SHORT_COMMAND);
		expect(plain).not.toMatch(/\[…\d+ more lines?…]/);
		for (const option of APPROVAL_SELECT_OPTIONS) {
			expect(plain).toContain(option.label);
		}
	});

	/**
	 * The hit map is keyed by body row, so trimming rows without rebuilding it
	 * would put the pointer's answer one option off — silently picking "Deny"
	 * for a click on "Approve".
	 */
	it("answers a click on an option with that option after the title is elided", () => {
		for (const option of APPROVAL_SELECT_OPTIONS) {
			const picked: string[] = [];
			const component = cardFor(LONG_COMMAND, label => picked.push(label));
			const lines = component.render(WIDTH).map(line => Bun.stripANSI(line));
			const row = lines.findIndex(line => line.includes(option.label));
			expect(row, `row carrying ${JSON.stringify(option.label)}`).toBeGreaterThanOrEqual(0);

			component.handleInput(clickAt(row + 1));
			expect(picked).toEqual([option.label]);
		}
	});
});
