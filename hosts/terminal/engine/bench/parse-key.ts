import { parseKey as nativeParseKey } from "@veyyon/natives";
import * as native from "@veyyon/utils/keys";
import { makeBench } from "./_harness";
import * as js from "./_jskey";
import { samples } from "./_key-samples";

const ITERATIONS = 2000;
const KITTY_ACTIVE = true;
js.setKittyProtocolActive(KITTY_ACTIVE);
native.setKittyProtocolActive(KITTY_ACTIVE);

console.log(`parseKey benchmark (${ITERATIONS} iterations, ${samples.length} samples each)\n`);

let mismatches = 0;
let superseded = 0;
for (const sample of samples) {
	const jsResult = js.parseKey(sample.data);
	const nativeResult = nativeParseKey(sample.data, KITTY_ACTIVE) ?? undefined;
	const jsExpected = sample.legacyJs ?? sample.expected;
	if (nativeResult !== sample.expected || jsResult !== jsExpected) {
		console.log(
			`MISMATCH ${sample.name}: native="${nativeResult}" (want "${sample.expected}") js="${jsResult}" (want "${jsExpected}")`,
		);
		mismatches++;
	}
	if (sample.legacyJs !== undefined) superseded++;
}
if (mismatches > 0) {
	console.log(`\n${mismatches} of ${samples.length} samples disagree; the timings below would be meaningless.\n`);
	process.exit(1);
}
console.log(`All results match. ${superseded} of ${samples.length} samples measure superseded baseline behaviour.\n`);

const bench = makeBench(ITERATIONS);
const jsTime = bench("js/parseKey", () => {
	for (const s of samples) js.parseKey(s.data);
});
const nativeTime = bench("native/parseKey", () => {
	for (const s of samples) native.parseKey(s.data);
});
console.log(`\nSpeedup: ${(jsTime / nativeTime).toFixed(2)}x`);

const MATCH_BENCHES = [
	{
		name: "js/parse+match",
		fn: () => {
			for (const s of samples) js.matchesKey(s.data, s.expected);
		},
	},
	{
		name: "native/match",
		fn: () => {
			for (const s of samples) native.matchesKey(s.data, s.expected);
		},
	},
] as const;

for (const { name, fn } of MATCH_BENCHES) {
	bench(name, fn);
}
