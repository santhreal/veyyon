import { matchesKittySequence as nativeMatchesKittySequence } from "@veyyon/natives";
import { parseKittySequence } from "@veyyon/utils/keys";
import { makeBench } from "./_harness";

const ITERATIONS = 2000;
const LOCK_MASK = 64 + 128;

const samples = [
	{ name: "ctrl+a", data: "\x1b[97;5u", codepoint: 97, modifier: 4 },
	{ name: "shift+tab", data: "\x1b[9;2u", codepoint: 9, modifier: 1 },
	{ name: "alt+enter", data: "\x1b[13;3u", codepoint: 13, modifier: 2 },
	{ name: "ctrl+right", data: "\x1b[1;5C", codepoint: -3, modifier: 4 },
	{ name: "shift+delete", data: "\x1b[3;2~", codepoint: -10, modifier: 1 },
	{ name: "base-layout", data: "\x1b[108::97;5u", codepoint: 97, modifier: 4 },
];

function matchesKittySequenceJs(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
	const parsed = parseKittySequence(data);
	if (!parsed) return false;
	const actualMod = parsed.modifier & ~LOCK_MASK;
	const expectedMod = expectedModifier & ~LOCK_MASK;
	if (actualMod !== expectedMod) return false;
	return (
		parsed.codepoint === expectedCodepoint ||
		(parsed.baseLayoutKey !== undefined && parsed.baseLayoutKey === expectedCodepoint)
	);
}

const bench = makeBench(ITERATIONS);
console.log(`Kitty sequence match benchmark (${ITERATIONS} iterations)\n`);

const ARMS = [
	{
		name: "js/parse+match",
		fn: () => {
			for (const s of samples) matchesKittySequenceJs(s.data, s.codepoint, s.modifier);
		},
	},
	{
		name: "native/match",
		fn: () => {
			for (const s of samples) nativeMatchesKittySequence(s.data, s.codepoint, s.modifier);
		},
	},
] as const;

for (const { name, fn } of ARMS) {
	bench(name, fn);
}
