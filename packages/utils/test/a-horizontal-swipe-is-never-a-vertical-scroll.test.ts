import { describe, expect, it } from "bun:test";
import { parseSgrMouse, type SgrMouseEvent } from "@veyyon/utils/mouse";

// WHY. xterm reports the wheel as buttons 4-7 in the SGR button code: 64 up,
// 65 down, 66 left, 67 right, with Shift (4), Meta (8) and Ctrl (16) OR'd in.
// The parser read bit 64 plus the low bit alone, so a trackpad swipe left or
// right (66/67) came out as a vertical notch up or down and every list, pager
// and transcript scrolled vertically on a sideways gesture. The class closed is
// any wheel report whose axis, sign or modifiers decode wrong, and any wheel
// report that also reads as motion or a click: every wheel code crossed with
// every modifier subset, pressed and released, is decoded to the exact event,
// and every non-wheel code under the same modifiers is proven never to be a
// wheel on either axis. The whole event is compared, so a field added to
// `SgrMouseEvent` turns this red until its value is pinned here.
//
// It does not catch a terminal that reports a horizontal swipe some other way
// (legacy X10 encoding, a Shift+wheel the terminal eats for its own scrollback),
// nor what a consumer does with `hwheel` or `shift` once decoded.

type Modifier = "shift" | "meta" | "ctrl";

const MODIFIER_BITS: Record<Modifier, number> = { shift: 4, meta: 8, ctrl: 16 };
const MODIFIERS = Object.keys(MODIFIER_BITS) as Modifier[];

/** Every subset of the modifier keys, the empty one first. */
const MODIFIER_SUBSETS: Modifier[][] = Array.from({ length: 1 << MODIFIERS.length }, (_, mask) =>
	MODIFIERS.filter((_modifier, index) => (mask & (1 << index)) !== 0),
);

/** The four wheel buttons, straight from the xterm table: buttons 4-7 are codes 64-67. */
const WHEEL_BUTTONS: ReadonlyArray<{
	code: number;
	gesture: string;
	wheel: SgrMouseEvent["wheel"];
	hwheel: SgrMouseEvent["hwheel"];
}> = [
	{ code: 64, gesture: "wheel up", wheel: -1, hwheel: null },
	{ code: 65, gesture: "wheel down", wheel: 1, hwheel: null },
	{ code: 66, gesture: "swipe left", wheel: null, hwheel: -1 },
	{ code: 67, gesture: "swipe right", wheel: null, hwheel: 1 },
];

const PHASES = [
	{ phase: "press", suffix: "M", release: false },
	{ phase: "release", suffix: "m", release: true },
] as const;

function codeWith(base: number, modifiers: readonly Modifier[]): number {
	let code = base;
	for (const modifier of modifiers) code |= MODIFIER_BITS[modifier];
	return code;
}

function label(modifiers: readonly Modifier[]): string {
	return modifiers.length === 0 ? "no modifier" : modifiers.join("+");
}

describe("an SGR wheel report", () => {
	it("covers every wheel code, modifier subset and phase", () => {
		// The sweep below is only as good as its space: four buttons, eight
		// modifier subsets (none through all three), two phases.
		expect(WHEEL_BUTTONS.map(button => button.code)).toEqual([64, 65, 66, 67]);
		expect(MODIFIER_SUBSETS.map(label)).toEqual([
			"no modifier",
			"shift",
			"meta",
			"shift+meta",
			"ctrl",
			"shift+ctrl",
			"meta+ctrl",
			"shift+meta+ctrl",
		]);
	});

	for (const button of WHEEL_BUTTONS) {
		for (const modifiers of MODIFIER_SUBSETS) {
			for (const { phase, suffix, release } of PHASES) {
				const code = codeWith(button.code, modifiers);
				it(`decodes ${button.gesture} with ${label(modifiers)} on ${phase} (code ${code}) on its own axis only`, () => {
					expect(parseSgrMouse(`\x1b[<${code};7;3${suffix}`)).toEqual({
						button: code,
						col: 6,
						row: 2,
						release,
						wheel: button.wheel,
						hwheel: button.hwheel,
						shift: modifiers.includes("shift"),
						motion: false,
						leftClick: false,
					});
				});
			}
		}
	}

	// The motion bit (32) never accompanies a wheel button in xterm's own
	// reports, but a terminal that scrolls mid-drag may set it. A wheel is still
	// a wheel on its own axis then, and still never motion.
	for (const button of WHEEL_BUTTONS) {
		const code = button.code | 32;
		it(`keeps ${button.gesture} a wheel report, not motion, when the motion bit is set (code ${code})`, () => {
			const event = parseSgrMouse(`\x1b[<${code};1;1M`);
			expect(event?.wheel).toBe(button.wheel);
			expect(event?.hwheel).toBe(button.hwheel);
			expect(event?.motion).toBe(false);
			expect(event?.leftClick).toBe(false);
		});
	}
});

describe("a non-wheel SGR report", () => {
	// Buttons 1-3 and the no-button release code, pressed and dragged: none of
	// them is a wheel on either axis, whatever modifier is held.
	const POINTER_CODES = [
		{ code: 0, what: "left press", motion: false, leftClickOnPress: true },
		{ code: 1, what: "middle press", motion: false, leftClickOnPress: false },
		{ code: 2, what: "right press", motion: false, leftClickOnPress: false },
		{ code: 3, what: "no-button report", motion: false, leftClickOnPress: false },
		{ code: 32, what: "left drag", motion: true, leftClickOnPress: false },
		{ code: 33, what: "middle drag", motion: true, leftClickOnPress: false },
		{ code: 34, what: "right drag", motion: true, leftClickOnPress: false },
		{ code: 35, what: "hover", motion: true, leftClickOnPress: false },
	];

	for (const pointer of POINTER_CODES) {
		for (const modifiers of MODIFIER_SUBSETS) {
			for (const { phase, suffix, release } of PHASES) {
				const code = codeWith(pointer.code, modifiers);
				it(`decodes ${pointer.what} with ${label(modifiers)} on ${phase} (code ${code}) as no wheel at all`, () => {
					expect(parseSgrMouse(`\x1b[<${code};4;9${suffix}`)).toEqual({
						button: code,
						col: 3,
						row: 8,
						release,
						wheel: null,
						hwheel: null,
						shift: modifiers.includes("shift"),
						motion: pointer.motion,
						leftClick: pointer.leftClickOnPress && !release,
					});
				});
			}
		}
	}
});
