/**
 * A profile recalls only the Hindsight memories it retained.
 *
 * WHY THIS SUITE EXISTS. The Hindsight bank id defaulted to `veyyon` in every profile, so two
 * profiles pointed at one Hindsight server retained into and recalled from the same bank: a
 * conversation held under one profile surfaced as memory in another.
 *
 * THE CLASS THIS CLOSES is a scoping mode whose bank ignores the profile. Every scoping mode the
 * config accepts is swept through the real `loadHindsightConfig` and `computeBankScope`, from the
 * default profile and two named ones, in one project directory: with no bank id set, no two profiles
 * resolve the same bank. The negative controls: an explicit `hindsight.bankId` or `HINDSIGHT_BANK_ID`
 * is shared across profiles on purpose, and the default profile keeps the `veyyon` bank it always used.
 *
 * WHAT IT DOES NOT CATCH: a bank chosen outside `computeBankScope`; two profiles configured with the
 * same explicit bank id, which is a request to share; and a per-project bank whose `-` joins collide
 * (profile `a` in project `b-c` and profile `a-b` in project `c` both resolve `veyyon-a-b-c`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { computeBankScope } from "@veyyon/coding-agent/memory/hindsight/bank";
import { loadHindsightConfig, VALID_SCOPINGS } from "@veyyon/coding-agent/memory/hindsight/config";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides, setProfile } from "@veyyon/utils/dirs";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

const PROFILES = [undefined, "oss", "work"] as const;
const PROJECT = "/repo/app";

let isolated: IsolatedConfigRoot;
let snapshot: DirOverridesSnapshot;

function bankFrom(profile: string | undefined, settings: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
	setProfile(profile);
	return computeBankScope(loadHindsightConfig(Settings.isolated(settings), env), PROJECT).bankId;
}

describe("the Hindsight bank a profile retains into", () => {
	beforeEach(() => {
		snapshot = captureDirOverrides();
		isolated = enterIsolatedConfigRoot("hindsight-profile-bank", { defaultProfile: true });
	});

	afterEach(() => {
		isolated.restore();
		restoreDirOverrides(snapshot);
	});

	it("differs between profiles under every scoping mode when no bank id is set", () => {
		const shared: string[] = [];
		for (const scoping of VALID_SCOPINGS) {
			const owners = new Map<string, string>();
			for (const profile of PROFILES) {
				const bank = bankFrom(profile, { "hindsight.scoping": scoping }, {});
				const owner = owners.get(bank);
				if (owner !== undefined) shared.push(`${scoping}: ${owner} and ${profile ?? "default"} share ${bank}`);
				owners.set(bank, profile ?? "default");
			}
		}
		expect(shared).toEqual([]);
	});

	it("keeps the default profile on the veyyon bank and names a named profile's bank after it", () => {
		expect(PROFILES.map(profile => bankFrom(profile, { "hindsight.scoping": "global" }, {}))).toEqual([
			"veyyon",
			"veyyon-oss",
			"veyyon-work",
		]);
	});

	it("shares an explicitly configured bank id across profiles", () => {
		for (const scoping of VALID_SCOPINGS) {
			const fromSettings = PROFILES.map(profile =>
				bankFrom(profile, { "hindsight.scoping": scoping, "hindsight.bankId": "team" }, {}),
			);
			const fromEnv = PROFILES.map(profile =>
				bankFrom(profile, { "hindsight.scoping": scoping }, { HINDSIGHT_BANK_ID: "team" }),
			);
			expect(new Set(fromSettings).size, scoping).toBe(1);
			expect(fromEnv, scoping).toEqual(fromSettings);
		}
	});
});
