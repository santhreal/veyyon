/**
 * WHY: the same Claude model is one model no matter which host serves it, so
 * its effort ladder on Bedrock has to match the ladder on Anthropic direct.
 * Nothing in the resolver enforces that today; the two rows arrive by
 * different routes and happen to agree.
 *
 * The narrow route is the one at risk. `getAnthropicAdaptiveEfforts` asks
 * `anthropicModelHasRealXHighEffort`, which requires `api ===
 * "anthropic-messages"`, so a Bedrock row can never earn its fifth tier from
 * identity: `bedrock-converse-stream` gets four. Bedrock ships five only
 * because the models.dev declaration outranks that answer in
 * `resolveModelThinking`. Two plausible edits silently drop `xhigh` from every
 * Bedrock Claude 4.7+ row while Anthropic direct keeps it — moving the curated
 * lookup above the declaration (measured: 26 rows lose a tier), or a regen
 * that drops `reasoning_options`. Both are invisible in review and show up as
 * a capability the user simply cannot select on Bedrock.
 *
 * Pinning agreement rather than the literal tiers keeps this true as Anthropic
 * adds ladders: a new model lands in both catalogs, and the test only cares
 * that Bedrock is not the narrower of the two.
 */
import { describe, expect, test } from "bun:test";
import { getBundledModels } from "../src/models";

/** `eu.anthropic.claude-opus-5` and `anthropic.claude-opus-5` are one model. */
const BEDROCK_ROW = /^(?:[a-z]{2}\.|global\.)?anthropic\.(.+)$/;

function ladders(): { bedrock: string; model: string; onBedrock: string; onAnthropic: string }[] {
	const direct = new Map<string, string>();
	for (const model of getBundledModels("anthropic")) {
		direct.set(model.id, model.thinking?.efforts?.join(",") ?? "(none)");
	}
	const paired: { bedrock: string; model: string; onBedrock: string; onAnthropic: string }[] = [];
	for (const model of getBundledModels("amazon-bedrock")) {
		const bare = BEDROCK_ROW.exec(model.id)?.[1];
		const onAnthropic = bare === undefined ? undefined : direct.get(bare);
		if (bare === undefined || onAnthropic === undefined) continue;
		paired.push({
			bedrock: model.id,
			model: bare,
			onBedrock: model.thinking?.efforts?.join(",") ?? "(none)",
			onAnthropic,
		});
	}
	return paired;
}

describe("a Claude model on Bedrock", () => {
	test("offers the same effort ladder as the same model on Anthropic direct", () => {
		const disagreeing = ladders()
			.filter(row => row.onBedrock !== row.onAnthropic)
			.map(row => `${row.bedrock}: bedrock=[${row.onBedrock}] anthropic=[${row.onAnthropic}]`);
		expect(disagreeing).toEqual([]);
	});

	test("covers the adaptive models whose fifth tier only the declaration supplies", () => {
		// Without this the agreement above passes by pairing nothing, and the
		// `xhigh` case is the entire reason the pairing is worth asserting.
		const paired = ladders();
		const fiveTier = paired.filter(row => row.onBedrock.split(",").includes("xhigh"));
		expect(paired.length).toBeGreaterThanOrEqual(20);
		expect(fiveTier.length).toBeGreaterThanOrEqual(10);
		expect(new Set(fiveTier.map(row => row.model)).size).toBeGreaterThanOrEqual(3);
	});
});
