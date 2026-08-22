/**
 * WHY: An arm attachment (`.sections.yml`, `.statements.yml`, `.prompts.yml`) is a prompt
 * variant delivered per arm through an eval-only env var. Each kind has to be wired in four
 * ways — recognised as an attachment rather than an arm, refused as an `--arms` name, staged
 * as JSON next to the binary, and folded into the arm fingerprint — and a kind missing any
 * one of them fails silently in the worst direction: the attachment is either read as a
 * config overlay (a phantom arm) or ignored (a treatment benched as its control while the
 * results table names it a treatment).
 *
 * The kinds are now one table, `ARM_ATTACHMENT_KINDS`, which owns each kind's suffix, staged
 * directory, env var and value rules. This suite sweeps that table at run time rather than a
 * list somebody remembered to update, so a new row must satisfy every guard or turn red.
 *
 * What it does not catch: Pier container execution, Docker volume mounts, and whether the
 * agent inside the container honours a delivered payload (the utils and coding-agent suites
 * cover the prompt-registry half of that).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ARM_ATTACHMENT_KINDS,
	type ArmAttachmentKind,
	attachmentKindOf,
	isArmAttachmentError,
	readArmAttachment,
	stageArmAttachment,
} from "./arm-attachments";
import {
	ARM_ATTACHMENT_SUFFIXES,
	type ArmInputs,
	armNamesIn,
	armSelectionError,
	computeArmFingerprint,
	findZeroIvCollisions,
	isArmConfigFile,
} from "./arm-fingerprint";

const ARMS_DIR = path.join(import.meta.dir, "arms");

describe("attachment kinds enumerated from ARM_ATTACHMENT_SUFFIXES at run time", () => {
	it("contains all expected attachment kinds (.sections.yml, .statements.yml, .prompts.yml)", () => {
		expect(ARM_ATTACHMENT_SUFFIXES).toContain(".sections.yml");
		expect(ARM_ATTACHMENT_SUFFIXES).toContain(".statements.yml");
		expect(ARM_ATTACHMENT_SUFFIXES).toContain(".prompts.yml");
		expect(ARM_ATTACHMENT_SUFFIXES.length).toBeGreaterThanOrEqual(3);
	});

	it("every disk file in arms/ with a composite suffix belongs to ARM_ATTACHMENT_SUFFIXES or is .rule.md", () => {
		const files = fs.readdirSync(ARMS_DIR);
		for (const file of files) {
			if (file.endsWith(".rule.md")) continue;
			if (file.endsWith(".yml")) {
				const parts = file.split(".");
				if (parts.length > 2) {
					// e.g. "candidate-delivery-terse.sections.yml"
					const suffix = `.${parts.slice(1).join(".")}`;
					expect(
						ARM_ATTACHMENT_SUFFIXES,
						`File ${file} has suffix ${suffix} not declared in ARM_ATTACHMENT_SUFFIXES`,
					).toContain(suffix);
				}
			}
		}
	});

	it.each([...ARM_ATTACHMENT_SUFFIXES])(
		"refuses attachment %s in armSelectionError and names the bare arm",
		(suffix: string) => {
			const bareSuffix = suffix.slice(0, -".yml".length);
			const requestedArm = `candidate-foo${bareSuffix}`;
			const available = ["candidate-foo", "baseline"];

			const problem = armSelectionError(requestedArm, available);
			expect(problem).not.toBeNull();
			expect(problem).toContain(`"${requestedArm}" is not an arm`);
			expect(problem).toContain(`it is the ${suffix} attachment of arm "candidate-foo"`);
			expect(problem).toContain(`--arms candidate-foo`);
		},
	);

	it.each([...ARM_ATTACHMENT_SUFFIXES])("treats %s as an attachment in isArmConfigFile", (suffix: string) => {
		expect(isArmConfigFile(`my-arm${suffix}`)).toBe(false);
		expect(isArmConfigFile("my-arm.yml")).toBe(true);
	});

	it.each([...ARM_ATTACHMENT_SUFFIXES])("excludes %s from armNamesIn directory listings", (suffix: string) => {
		const listing = ["baseline.yml", `candidate-a${suffix}`, "candidate-a.yml"];
		const arms = armNamesIn(listing);
		expect(arms).toEqual(["baseline", "candidate-a"]);
	});
});

describe("prompt attachment (.prompts.yml) single-IV fingerprint behavior", () => {
	const baselineConfig = { argot: { enabled: false } };

	it("fingerprint of an arm with .prompts.yml differs from the same arm without it", () => {
		const withoutAttachment: ArmInputs = { config: baselineConfig };
		const withAttachment: ArmInputs = {
			config: baselineConfig,
			prompts: { "tools/bash": "trimmed bash description" },
		};

		const fpWithout = computeArmFingerprint(withoutAttachment);
		const fpWith = computeArmFingerprint(withAttachment);

		expect(fpWith).not.toBe(fpWithout);
	});

	it("two arms differing only by .prompts.yml are NOT reported as a zero-IV collision", () => {
		const fpBaseline = computeArmFingerprint({ config: baselineConfig });
		const fpCandidate = computeArmFingerprint({
			config: baselineConfig,
			prompts: { "tools/bash": "custom instructions" },
		});

		const fingerprints = new Map([
			["baseline", fpBaseline],
			["candidate-bash-trim", fpCandidate],
		]);

		const collisions = findZeroIvCollisions(fingerprints);
		expect(collisions).toEqual([]);
	});

	it("two arms with identical .prompts.yml and config DO collide as zero-IV", () => {
		const promptMap = { "tools/bash": "custom instructions" };
		const fp1 = computeArmFingerprint({ config: baselineConfig, prompts: promptMap });
		const fp2 = computeArmFingerprint({ config: baselineConfig, prompts: promptMap });

		const fingerprints = new Map([
			["candidate-1", fp1],
			["candidate-2", fp2],
		]);

		const collisions = findZeroIvCollisions(fingerprints);
		expect(collisions).toEqual([["candidate-1", "candidate-2"]]);
	});
});

/**
 * The table itself: every row wired, no row wired twice, and each row's payload reaching the
 * fingerprint and the staged assets. A row that fails any of these is the silent case.
 */
describe("every kind in ARM_ATTACHMENT_KINDS", () => {
	/** A scratch tree per case, since staging writes files. */
	function tempDir(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), "arm-attachments-"));
	}

	it("declares a distinct suffix, staged directory and env var", () => {
		const suffixes = ARM_ATTACHMENT_KINDS.map(kind => kind.suffix);
		const dirs = ARM_ATTACHMENT_KINDS.map(kind => kind.stagedDir);
		const envVars = ARM_ATTACHMENT_KINDS.map(kind => kind.envVar);

		expect(new Set(suffixes).size).toBe(suffixes.length);
		expect(new Set(dirs).size).toBe(dirs.length);
		expect(new Set(envVars).size).toBe(envVars.length);
		// An override that a config key could reach would contaminate a production session,
		// so every vehicle is an env var, and its name says it is an eval instrument.
		for (const envVar of envVars) expect(envVar.startsWith("VEYYON_EVAL")).toBe(true);
	});

	it.each([...ARM_ATTACHMENT_KINDS])("$suffix is matched by attachmentKindOf and not by a plain arm", kind => {
		expect(attachmentKindOf(`candidate-a${kind.suffix}`)).toBe(kind);
		expect(attachmentKindOf("candidate-a.yml")).toBeUndefined();
	});

	it.each([...ARM_ATTACHMENT_KINDS])("$suffix changes the arm fingerprint it rides on", kind => {
		const config = { argot: { enabled: false } };
		const bare = computeArmFingerprint({ config });
		const carrying = computeArmFingerprint({ config, [kind.field]: { "some/id": "replacement text" } });

		// A kind whose field the fingerprint does not hash is the zero-IV hole: two arms that
		// really differ collide, and the runner drops one as a duplicate of the other.
		expect(carrying).not.toBe(bare);
		expect(
			findZeroIvCollisions(
				new Map([
					["baseline", bare],
					["candidate", carrying],
				]),
			),
		).toEqual([]);
	});

	it.each([...ARM_ATTACHMENT_KINDS])("$suffix reads back the mapping an arm declares", kind => {
		const armsDir = tempDir();
		fs.writeFileSync(path.join(armsDir, `candidate${kind.suffix}`), 'some/id: "replacement text"\n');

		const read = readArmAttachment(kind, armsDir, "candidate", "candidate");

		expect(isArmAttachmentError(read)).toBe(false);
		expect(read).toEqual({ present: true, value: { "some/id": "replacement text" } });
	});

	it.each([...ARM_ATTACHMENT_KINDS])("$suffix is absent, not empty, when the arm has no such file", kind => {
		const read = readArmAttachment(kind, tempDir(), "candidate", "candidate");

		expect(read).toEqual({ present: false });
	});

	it.each([...ARM_ATTACHMENT_KINDS])("$suffix refuses a sequence, naming the arm and the file", kind => {
		const armsDir = tempDir();
		fs.writeFileSync(path.join(armsDir, `candidate${kind.suffix}`), "- one\n- two\n");

		const read = readArmAttachment(kind, armsDir, "candidate", "candidate");

		expect(isArmAttachmentError(read)).toBe(true);
		if (!isArmAttachmentError(read)) throw new Error("unreachable");
		expect(read.error).toContain(`candidate${kind.suffix}`);
		expect(read.error).toContain("got a sequence");
	});

	it.each([...ARM_ATTACHMENT_KINDS])("$suffix refuses a value that is not text", kind => {
		const armsDir = tempDir();
		fs.writeFileSync(path.join(armsDir, `candidate${kind.suffix}`), "some/id: 42\n");

		const read = readArmAttachment(kind, armsDir, "candidate", "candidate");

		expect(isArmAttachmentError(read)).toBe(true);
	});

	it.each([...ARM_ATTACHMENT_KINDS])("$suffix treats null as ablation only where the kind allows it", kind => {
		const armsDir = tempDir();
		fs.writeFileSync(path.join(armsDir, `candidate${kind.suffix}`), "some/id: null\n");

		const read = readArmAttachment(kind, armsDir, "candidate", "candidate");

		// `null` removes a statement, which no other kind can express: an empty string would
		// mean "this rule says nothing but is still here", a different prompt.
		expect(isArmAttachmentError(read)).toBe(!kind.allowsNull);
	});

	it.each([...ARM_ATTACHMENT_KINDS])("$suffix stages exactly the bytes the env var carries", kind => {
		const assetsDir = tempDir();
		const value = { "some/id": "replacement text" };

		stageArmAttachment(kind, assetsDir, "candidate", value);

		const staged = path.join(assetsDir, kind.stagedDir, "candidate.json");
		expect(fs.readFileSync(staged, "utf8")).toBe(JSON.stringify(value));
	});

	it("has a kind for every attachment file shipped in arms/", () => {
		const shipped = fs.readdirSync(ARMS_DIR).filter(name => name.endsWith(".yml") && name.split(".").length > 2);

		// Fails when an arm ships an attachment kind the table does not know: the file would
		// otherwise be read as an arm config named `candidate-x.newkind`.
		const orphans = shipped.filter(name => attachmentKindOf(name) === undefined);
		expect(orphans).toEqual([]);
		expect(shipped.length).toBeGreaterThan(0);
	});

	it("declares a kind for each attachment field the fingerprint hashes", () => {
		// Pinned by exact equality, not counted: a field added to ArmInputs without a kind is
		// an override nothing stages, and a kind without a field is an override nothing hashes.
		const fields: ArmAttachmentKind["field"][] = ARM_ATTACHMENT_KINDS.map(kind => kind.field);
		expect(fields).toEqual(["sections", "statements", "prompts"]);
	});

	it("keeps the fingerprint of an arm that carries nothing", () => {
		const config = { argot: { enabled: false } };
		const inputs: ArmInputs = { config };

		expect(computeArmFingerprint(inputs)).toBe(computeArmFingerprint({ config }));
	});
});
