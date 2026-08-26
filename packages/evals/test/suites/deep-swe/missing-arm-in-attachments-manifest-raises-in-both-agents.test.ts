/**
 * WHY: `harbor/veyyon_agent.py` previously duplicated `pier/arm_attachments.py` but drifted:
 * when the requested arm was missing from `attachments.json`, pier raised `ValueError` while
 * harbor silently returned `()` and ran an unconfigured treatment arm.
 *
 * This suite proves that:
 * 1. Both Pier and Harbor agents share the deduplicated `common.arm_attachments` module.
 * 2. When a requested arm is missing from `attachments.json`, BOTH agents raise `ValueError`
 *    (failing closed instead of running an unconfigured arm).
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { harborAgentDir, pierAgentDir } from "../../../src/paths";

describe("missing arm in attachments manifest raises in both agents", () => {
	it("raises ValueError when arm is missing in pier agent", () => {
		const script = `
import json
import sys
from pathlib import Path

_pier_dir = sys.argv[1]
sys.path.insert(0, _pier_dir)
import arm_attachments

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
