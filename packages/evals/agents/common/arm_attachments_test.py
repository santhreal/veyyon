"""
WHY THIS SUITE EXISTS.

The defect it closes: an arm attachment that the runner staged and the container-side
agent never delivered. Each kind used to be named three times in `veyyon_agent.py` (the
upload, the environment prefix, the setup command), so a kind wired in TypeScript and
missed in one of those three places ran the shipped prompt while the results table
called it a treatment -- a zero-IV comparison the runner's fingerprint guard cannot see,
because the arm files really do differ.

The class, not the incident: this suite does not check "the prompts kind works". It
checks that the reader is generic over the manifest -- every delivery it declares support
for has an observable effect, an entry it cannot deliver is refused rather than dropped,
and a manifest whose shape it does not know is refused rather than guessed at. Adding a
kind in `arm-attachments.ts` therefore needs no change here, and adding a DELIVERY that
nothing implements turns this suite red.

What it does not catch: that the delivered environment variable is the one veyyon reads
(`arm-attachment-kinds.test.ts` pins the names against the shipped consumers), and that
the container's shell interprets the emitted prefix as intended -- these are strings here,
not a running container. It also cannot see a kind declared in TypeScript and never
staged; the TypeScript suite covers that from the table.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from common.arm_attachments import (
    DELIVERY_ENV_JSON,
    DELIVERY_RULES_DIR,
    MANIFEST_FILE,
    SUPPORTED_DELIVERIES,
    SUPPORTED_MANIFEST_VERSION,
    ArmAttachment,
    attachment_directories,
    environment_prefix,
    missing_attachment_files,
    parse_arm_attachments,
    read_arm_attachments,
    rules_setup_command,
)

CONTAINER = "/opt/veyyon-assets"

# One entry per supported delivery, so the sweeps below quantify over
# SUPPORTED_DELIVERIES rather than over a list somebody remembered to extend.
SAMPLE_ENTRY = {
    DELIVERY_ENV_JSON: {
        "kind": "prompts",
        "file": "prompts/candidate.json",
        "delivery": DELIVERY_ENV_JSON,
        "envVar": "VEYYON_EVAL_PROMPTS",
    },
    DELIVERY_RULES_DIR: {
        "kind": "rule",
        "file": "rules/candidate.md",
        "delivery": DELIVERY_RULES_DIR,
    },
}


def manifest(entries: list[dict], arm: str = "candidate", version: object = SUPPORTED_MANIFEST_VERSION) -> str:
    return json.dumps({"version": version, "arms": {arm: entries}})


class EveryDeclaredDeliveryIsDelivered(unittest.TestCase):
    """A delivery this agent claims to support must change the command it builds."""

    maxDiff = None

    def test_every_supported_delivery_has_a_sample(self) -> None:
        # Fail by default on a new delivery: without a sample the sweeps below would
        # silently stop covering it, which is exactly how the original defect survived.
        self.assertEqual(sorted(SAMPLE_ENTRY), sorted(SUPPORTED_DELIVERIES))

    def test_every_supported_delivery_reaches_the_command(self) -> None:
        for delivery in SUPPORTED_DELIVERIES:
            with self.subTest(delivery=delivery):
                attachments = parse_arm_attachments(manifest([SAMPLE_ENTRY[delivery]]), "candidate")
                self.assertEqual(len(attachments), 1)
                effect = environment_prefix(attachments, CONTAINER) + rules_setup_command(
                    attachments, CONTAINER
                )
                self.assertIn(attachments[0].file, effect)

    def test_every_supported_delivery_is_uploaded(self) -> None:
        entries = [SAMPLE_ENTRY[delivery] for delivery in SUPPORTED_DELIVERIES]
        attachments = parse_arm_attachments(manifest(entries), "candidate")
        directories = attachment_directories(attachments, CONTAINER)
        for attachment in attachments:
            with self.subTest(kind=attachment.kind):
                self.assertIn(f"{CONTAINER}/{attachment.file}".rsplit("/", 1)[0], directories)


class TheCommandsBuiltFromAManifest(unittest.TestCase):
    maxDiff = None

    def _all_kinds(self) -> tuple[ArmAttachment, ...]:
        return parse_arm_attachments(
            manifest(
                [
                    {
                        "kind": "sections",
                        "file": "sections/candidate.json",
                        "delivery": DELIVERY_ENV_JSON,
                        "envVar": "VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS",
                    },
                    SAMPLE_ENTRY[DELIVERY_ENV_JSON],
                    SAMPLE_ENTRY[DELIVERY_RULES_DIR],
                ]
            ),
            "candidate",
        )

    def test_env_prefix_scopes_each_variable_to_one_command_in_table_order(self) -> None:
        prefix = environment_prefix(self._all_kinds(), CONTAINER)
        self.assertEqual(
            prefix,
            'VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS="$(cat /opt/veyyon-assets/sections/candidate.json)" '
            'VEYYON_EVAL_PROMPTS="$(cat /opt/veyyon-assets/prompts/candidate.json)" ',
        )
        # A trailing space, so the caller can concatenate the binary path directly, and no
        # `export`: the override exists for the vey process and nothing else.
        self.assertTrue(prefix.endswith(" "))
        self.assertNotIn("export", prefix)

    def test_a_rule_is_copied_by_name_not_by_glob(self) -> None:
        setup = rules_setup_command(self._all_kinds(), CONTAINER)
        self.assertEqual(
            setup,
            " && mkdir -p ~/.veyyon/rules && cp /opt/veyyon-assets/rules/candidate.md ~/.veyyon/rules/",
        )
        # A glob would also copy whatever else was staged there, which is how one arm
        # inherits another arm's treatment.
        self.assertNotIn("*", setup)

    def test_a_rule_contributes_nothing_to_the_environment_prefix(self) -> None:
        rule_only = parse_arm_attachments(manifest([SAMPLE_ENTRY[DELIVERY_RULES_DIR]]), "candidate")
        self.assertEqual(environment_prefix(rule_only, CONTAINER), "")

    def test_an_env_json_attachment_contributes_nothing_to_the_setup_command(self) -> None:
        env_only = parse_arm_attachments(manifest([SAMPLE_ENTRY[DELIVERY_ENV_JSON]]), "candidate")
        self.assertEqual(rules_setup_command(env_only, CONTAINER), "")

    def test_an_arm_that_carries_nothing_builds_no_fragments(self) -> None:
        empty = parse_arm_attachments(manifest([], arm="baseline"), "baseline")
        self.assertEqual(empty, ())
        self.assertEqual(environment_prefix(empty, CONTAINER), "")
        self.assertEqual(rules_setup_command(empty, CONTAINER), "")
        self.assertEqual(attachment_directories(empty, CONTAINER), ())

    def test_a_directory_shared_by_two_attachments_is_created_once(self) -> None:
        attachments = parse_arm_attachments(
            manifest(
                [
                    SAMPLE_ENTRY[DELIVERY_ENV_JSON],
                    {
                        "kind": "extra",
                        "file": "prompts/candidate-extra.json",
                        "delivery": DELIVERY_ENV_JSON,
                        "envVar": "VEYYON_EVAL_EXTRA",
                    },
                ]
            ),
            "candidate",
        )
        self.assertEqual(attachment_directories(attachments, CONTAINER), (f"{CONTAINER}/prompts",))


class AManifestThisAgentCannotHonor(unittest.TestCase):
    """Every one of these is a refusal, because a dropped attachment is silent."""

    maxDiff = None

    def _refusal(self, text: str, arm: str = "candidate") -> str:
        with self.assertRaises(ValueError) as caught:
            parse_arm_attachments(text, arm)
        return str(caught.exception)

    def test_a_version_from_another_runner_is_refused_and_names_both(self) -> None:
        message = self._refusal(manifest([SAMPLE_ENTRY[DELIVERY_ENV_JSON]], version=2))
        self.assertIn("version 2", message)
        self.assertIn(f"version {SUPPORTED_MANIFEST_VERSION}", message)

    def test_a_missing_version_is_refused(self) -> None:
        message = self._refusal(json.dumps({"arms": {"candidate": []}}))
        self.assertIn("version None", message)

    def test_an_unknown_delivery_is_refused_and_lists_what_is_handled(self) -> None:
        entry = {**SAMPLE_ENTRY[DELIVERY_ENV_JSON], "delivery": "bind-mount"}
        message = self._refusal(manifest([entry]))
        self.assertIn("bind-mount", message)
        for delivery in SUPPORTED_DELIVERIES:
            self.assertIn(delivery, message)

    def test_an_arm_the_manifest_does_not_name_is_refused(self) -> None:
        message = self._refusal(manifest([], arm="baseline"), arm="candidate")
        self.assertIn("candidate", message)
        self.assertIn("baseline", message)

    def test_an_env_json_entry_without_a_usable_variable_is_refused(self) -> None:
        for env_var in (None, "", "not lower case", "1LEADING_DIGIT", "HAS-DASH", "A;rm -rf /"):
            with self.subTest(env_var=env_var):
                entry = {**SAMPLE_ENTRY[DELIVERY_ENV_JSON]}
                if env_var is None:
                    entry.pop("envVar")
                else:
                    entry["envVar"] = env_var
                self.assertIn("environment variable", self._refusal(manifest([entry])))

    def test_a_rules_dir_entry_naming_a_variable_is_refused(self) -> None:
        entry = {**SAMPLE_ENTRY[DELIVERY_RULES_DIR], "envVar": "VEYYON_EVAL_PROMPTS"}
        self.assertIn("cannot also name", self._refusal(manifest([entry])))

    def test_a_path_outside_the_assets_directory_is_refused(self) -> None:
        for file in ("/etc/passwd", "../../etc/passwd", "prompts/../../secret.json"):
            with self.subTest(file=file):
                entry = {**SAMPLE_ENTRY[DELIVERY_ENV_JSON], "file": file}
                self.assertIn("outside the assets directory", self._refusal(manifest([entry])))

    def test_an_entry_missing_a_field_is_refused_by_name(self) -> None:
        for field in ("kind", "file", "delivery"):
            with self.subTest(field=field):
                entry = {**SAMPLE_ENTRY[DELIVERY_ENV_JSON]}
                entry.pop(field)
                self.assertIn(field, self._refusal(manifest([entry])))

    def test_a_manifest_that_is_not_json_is_refused(self) -> None:
        self.assertIn("not valid JSON", self._refusal("{"))

    def test_a_manifest_of_the_wrong_shape_is_refused(self) -> None:
        self.assertIn("must be an object", self._refusal(json.dumps([])))
        self.assertIn(
            "'arms' must be an object",
            self._refusal(json.dumps({"version": SUPPORTED_MANIFEST_VERSION, "arms": []})),
        )
        self.assertIn(
            "must hold a list",
            self._refusal(json.dumps({"version": SUPPORTED_MANIFEST_VERSION, "arms": {"candidate": {}}})),
        )


class AStaleAssetsDirectory(unittest.TestCase):
    maxDiff = None

    def test_an_absent_manifest_is_a_refusal_not_an_empty_result(self) -> None:
        with TemporaryDirectory() as root:
            with self.assertRaises(ValueError) as caught:
                read_arm_attachments(Path(root), "candidate")
            self.assertIn(MANIFEST_FILE, str(caught.exception))
            self.assertIn("stale", str(caught.exception))

    def test_a_staged_file_the_manifest_promises_and_the_host_lacks_is_reported(self) -> None:
        with TemporaryDirectory() as root:
            assets = Path(root)
            (assets / MANIFEST_FILE).write_text(
                manifest([SAMPLE_ENTRY[DELIVERY_ENV_JSON], SAMPLE_ENTRY[DELIVERY_RULES_DIR]]),
                encoding="utf-8",
            )
            (assets / "prompts").mkdir()
            (assets / "prompts" / "candidate.json").write_text("{}", encoding="utf-8")
            attachments = read_arm_attachments(assets, "candidate")
            self.assertEqual(missing_attachment_files(attachments, assets), ("rules/candidate.md",))

    def test_a_manifest_the_host_fully_satisfies_reports_nothing_missing(self) -> None:
        with TemporaryDirectory() as root:
            assets = Path(root)
            (assets / MANIFEST_FILE).write_text(
                manifest([SAMPLE_ENTRY[DELIVERY_RULES_DIR]]), encoding="utf-8"
            )
            (assets / "rules").mkdir()
            (assets / "rules" / "candidate.md").write_text("rule\n", encoding="utf-8")
            attachments = read_arm_attachments(assets, "candidate")
            self.assertEqual(missing_attachment_files(attachments, assets), ())


if __name__ == "__main__":
    unittest.main()
