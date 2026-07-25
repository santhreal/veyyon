import { parseKey as nativeParseKey } from "@veyyon/natives";
import * as native from "../src/keys";
import { makeBench } from "./_harness";
import * as js from "./_jskey";
import { samples } from "./_key-samples";

const ITERATIONS = 2000;

const bench = makeBench(ITERATIONS);

// Kitty protocol on, since half the samples are Kitty sequences. Both parsers read this from
// their own module state, so both have to be set, and the correctness check below has to run in
// the SAME mode as the timed calls or it compares two different parsers.
const KITTY_ACTIVE = true;
js.setKittyProtocolActive(KITTY_ACTIVE);
native.setKittyProtocolActive(KITTY_ACTIVE);

console.log(`parseKey benchmark (${ITERATIONS} iterations, ${samples.length} samples each)\n`);

// A speedup against a baseline that answers differently is not a speedup, so every sample is
// checked against BOTH parsers and against the key it is supposed to produce. Checking the two
// parsers against each other alone would call a sample correct when both are wrong about it.
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
	// Exit non-zero: a bench that prints a failure and succeeds anyway is a bench nothing gates on.
	console.log(`\n${mismatches} of ${samples.length} samples disagree; the timings below would be meaningless.\n`);
	process.exit(1);
}
// Say how many samples the two parsers deliberately disagree on: a timing comparison across a
// behaviour change is only honest if the change is stated, not averaged into a speedup.
console.log(`All results match. ${superseded} of ${samples.length} samples measure superseded baseline behaviour.\n`);

const jsTime = bench("js/parseKey", () => {
	for (const sample of samples) {
		js.parseKey(sample.data);
	}
});

const nativeTime = bench("native/parseKey", () => {
	for (const sample of samples) {
		native.parseKey(sample.data);
	}
});

console.log(`\nSpeedup: ${(jsTime / nativeTime).toFixed(2)}x`);

bench("js/parse+match", () => {
	for (const sample of samples) {
		js.matchesKey(sample.data, sample.expected as any);
	}
});

bench("native/match", () => {
	for (const sample of samples) {
		native.matchesKey(sample.data, sample.expected as any);
	}
});
