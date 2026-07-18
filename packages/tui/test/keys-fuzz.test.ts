/**
 * Fuzz tests for the key-parsing entry points. `parseKey`, `parseKittySequence`,
 * `matchesKey`, `decodePrintableKey`, `isKeyRelease`, and `isKeyRepeat` run on
 * every raw byte sequence the terminal delivers — kitty CSI-u, xterm
 * modifyOtherKeys, mouse, garbage from a wedged terminal — and most cross into
 * native (Rust) code. A native panic surfaces as a JS throw and would crash the
 * input loop, so none of these may throw on any input, with the kitty keyboard
 * protocol either active or inactive (they branch on that global).
 *
 * Deterministic LCG so a failing sequence reproduces from the printed seed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	decodePrintableKey,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	parseKey,
	parseKittySequence,
	setKittyProtocolActive,
} from "@veyyon/tui/keys";
import { FRAGMENTS, lcg } from "./helpers/adversarial-strings";

// Key-flavored byte fragments layered on the generic adversarial pool: CSI-u,
// modifyOtherKeys, arrows/finals, modifier params, kitty event/release suffixes.
const KEY_FRAGMENTS: readonly string[] = [
	"\x1b",
	"[",
	"O",
	"<",
	";",
	":",
	"u",
	"~",
	"A",
	"B",
	"C",
	"D",
	"M",
	"m",
	"1",
	"5",
	"27",
	"106",
	"200",
	"3",
	"\x1b[27u", // kitty ESC
	"\x1b[97;5u", // ctrl+a (CSI-u)
	"\x1b[1;5A", // ctrl+up
	"\x1b[3;2~", // shift+delete
	"\x1b[57414;1u", // keypad
	"\x1b[97;1:3u", // release event (eventType 3)
	"\x1b[200~", // paste start (must be ignored by repeat)
	"\x1bOP", // SS3 F1
	"\x7f", // DEL
	"\x08", // BS
];

const POOL = [...KEY_FRAGMENTS, ...FRAGMENTS];

function buildKeySeq(rand: () => number): string {
	const n = Math.floor(rand() * 12);
	let out = "";
	for (let i = 0; i < n; i++) out += POOL[Math.floor(rand() * POOL.length)];
	return out;
}

// A representative spread of KeyId targets matchesKey classifies against.
const KEY_IDS = ["escape", "enter", "tab", "backspace", "up", "ctrl+c", "shift+tab", "alt+enter", "5", "+"] as const;

afterEach(() => setKittyProtocolActive(false));

describe("key-parsing fuzz", () => {
	for (const kittyActive of [false, true]) {
		it(`never throws on adversarial input (kitty ${kittyActive ? "active" : "inactive"})`, () => {
			setKittyProtocolActive(kittyActive);
			const rand = lcg(kittyActive ? 0x6b17_ac01 : 0x6b17_ac00);
			for (let iter = 0; iter < 12000; iter++) {
				const s = buildKeySeq(rand);
				try {
					const key = parseKey(s);
					expect(key === undefined || typeof key === "string").toBe(true);

					const kitty = parseKittySequence(s);
					expect(kitty === null || typeof kitty === "object").toBe(true);

					const printable = decodePrintableKey(s);
					expect(printable === undefined || typeof printable === "string").toBe(true);

					expect(typeof isKeyRelease(s)).toBe("boolean");
					expect(typeof isKeyRepeat(s)).toBe("boolean");

					for (const id of KEY_IDS) {
						expect(typeof matchesKey(s, id)).toBe("boolean");
					}
				} catch (e) {
					throw new Error(`key parsing threw on ${JSON.stringify(s)} (kitty ${kittyActive}): ${e}`);
				}
			}
		});
	}
});
