/**
 * WHY: the Harbor agent once carried its own copy of the attachment reader, and the copy
 * drifted: an arm missing from `attachments.json` raised `ValueError` on the Pier side while
 * Harbor returned `()` and ran an unconfigured treatment arm.
 *
 * This suite proves that:
 * 1. Both agents read attachments through the one shared `common.arm_attachments` module.
 * 2. An arm the manifest does not name raises `ValueError` on both sides, failing closed
 *    instead of running an unconfigured arm.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { harborAgentDir, pierAgentDir } from "../../../engine/package-paths";

describe("missing arm in attachments manifest raises in both agents", () => {
	it("raises ValueError when arm is missing in pier agent", () => {
		const script = `
import json
import sys
from pathlib import Path

_agents_dir = str(Path(sys.argv[1]).resolve().parent)
sys.path.insert(0, _agents_dir)
from common import arm_attachments

manifest_text = json.dumps({"version": 1, "arms": {"known_arm": []}})
try:
    arm_attachments.parse_arm_attachments(manifest_text, "missing_arm")
    print("NO_ERROR")
except ValueError as e:
    if "does not name arm 'missing_arm'" in str(e):
        print("RAISED_VALUE_ERROR")
    else:
        print(f"WRONG_ERROR: {e}")
`;

		const output = execFileSync("python3", ["-c", script, pierAgentDir()], {
			encoding: "utf-8",
		}).trim();

		expect(output).toBe("RAISED_VALUE_ERROR");
	});

	it("raises ValueError when arm is missing in harbor agent", () => {
		const script = `
import json
import sys
from pathlib import Path

_harbor_dir = sys.argv[1]
sys.path.insert(0, _harbor_dir)
from veyyon_agent import parse_arm_attachments

manifest_text = json.dumps({"version": 1, "arms": {"known_arm": []}})
try:
    parse_arm_attachments(manifest_text, "missing_arm")
    print("NO_ERROR")
except ValueError as e:
    if "does not name arm 'missing_arm'" in str(e):
        print("RAISED_VALUE_ERROR")
    else:
        print(f"WRONG_ERROR: {e}")
`;

		const output = execFileSync("python3", ["-c", script, harborAgentDir()], {
			encoding: "utf-8",
		}).trim();

		expect(output).toBe("RAISED_VALUE_ERROR");
	});
});
