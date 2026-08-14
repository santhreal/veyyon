/**
 * Drive a TTSR rule the number of times its own declaration requires before it speaks.
 *
 * A rule may carry `warmupMatches`: it matches, stays silent, and only fires once it has
 * matched in that many distinct streams. Every suite that asks "does this rule fire for
 * X" has to get past that warm-up first, and each one hardcoding the count is how the
 * count and the rule drift apart. The number is read off the rule, so raising or dropping
 * a warm-up moves every suite with it.
 */
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import type { TtsrManager, TtsrMatchContext } from "@veyyon/coding-agent/export/ttsr";

/**
 * Feed `delta` through `manager` on synthetic stream keys until one more matching stream
 * would clear `rule`'s warm-up, and report how many streams that took.
 *
 * The keys are distinct and none of them is the caller's, so the warm-up is cleared
 * without the caller's own probe being counted twice. A rule with no warm-up is left
 * alone entirely: nothing is fed through, so a suite that adds this call keeps testing
 * the same first-match behavior it did before.
 */
export function warmUpRule(
	manager: TtsrManager,
	rule: Rule,
	delta: string,
	context: TtsrMatchContext,
	keyPrefix = "warmup",
): number {
	const required = rule.warmupMatches ?? 1;
	for (let stream = 0; stream < required - 1; stream++) {
		manager.resetBuffer();
		manager.checkDelta(delta, { ...context, streamKey: `${keyPrefix}:${rule.name}:${stream}` });
	}
	manager.resetBuffer();
	return required - 1;
}
