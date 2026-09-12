import { Ellipsis } from "@veyyon/natives";
import { matchesKey } from "@veyyon/utils/keys";
import { extractSegments, sliceWithWidth, truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { wrapTextWithAnsi } from "@veyyon/utils/wrap";
import { makeBench } from "./_harness";

const ITERATIONS = 2000;
const wrapWidth = 40;

const samples = {
	plain: "hello world this is a plain ASCII string with some words",
	ansi: "\x1b[31mred text\x1b[0m and \x1b[4munderlined content\x1b[24m with emoji 😅😅",
	links: "prefix \x1b]8;;https://example.com\x07link\x1b]8;;\x07 suffix",
	wide: "日本語のテキストとemoji 🚀✨ mixed with ascii",
	wrapped:
		"This is a long line that should wrap multiple times when rendered with ANSI \x1b[32mcolors\x1b[0m and tabs\tbetween words.",
};

const BENCH_CASES = [
	{ name: "visibleWidth/plain", fn: () => visibleWidth(samples.plain) },
	{ name: "visibleWidth/ansi", fn: () => visibleWidth(samples.ansi) },
	{ name: "truncateToWidth/ansi", fn: () => truncateToWidth(samples.ansi, 32, Ellipsis.Unicode, true) },
	{ name: "wrapTextWithAnsi/ansi", fn: () => wrapTextWithAnsi(samples.wrapped, wrapWidth) },
	{ name: "sliceWithWidth/ansi", fn: () => sliceWithWidth(samples.ansi, 3, 18, true) },
	{ name: "extractSegments/ansi", fn: () => extractSegments(samples.ansi, 10, 20, 15, true) },
	{
		name: "matchesKey",
		fn: () => {
			matchesKey("\x1b[A", "up");
			matchesKey("\x1b[1;5C", "ctrl+right");
			matchesKey("\x1b[1;2D", "shift+left");
		},
	},
] as const;

const bench = makeBench(ITERATIONS);
console.log(`Text layout benchmark (${ITERATIONS} iterations)\n`);

for (const { name, fn } of BENCH_CASES) {
	bench(name, fn);
}
