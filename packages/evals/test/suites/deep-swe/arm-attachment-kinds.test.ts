/**
 * WHY: An arm attachment (`.sections.yml`, `.statements.yml`, `.prompts.yml`, `.rule.md`) is a
 * prompt variant delivered per arm, and never through a config key. Each kind has to be wired
 * in five ways — recognised as an attachment rather than an arm, refused as an `--arms` name,
 * staged next to the binary, folded into the arm fingerprint, and delivered inside the
 * container — and a kind missing any one of them fails silently in the worst direction: the
 * attachment is either read as a config overlay (a phantom arm) or ignored (a treatment
 * benched as its control while the results table names it a treatment).
 *
 * The kinds are one table, `ARM_ATTACHMENT_KINDS`, which owns each kind's suffix, staged
 * directory, delivery and value rules. This suite sweeps that table at run time rather than a
 * list somebody remembered to update, so a new row must satisfy every guard or turn red — and
 * the last of those guards runs the real Python reader, because the container side is the half
 * that used to drift.
 *
 * What it does not catch: Pier container execution and Docker volume mounts, and whether the
 * agent inside the container honours a delivered payload (the utils and coding-agent suites
 * cover the prompt-registry half of that).
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { armsDir, pierAgentDir } from "../../../src/paths";
import {
	ARM_ATTACHMENT_KINDS,
	ARM_ATTACHMENT_MANIFEST_FILE,
	ARM_ATTACHMENT_MANIFEST_VERSION,
	type ArmAttachmentKind,
	type ArmAttachmentManifest,
	type ArmAttachmentPayload,
	attachmentKindOf,
	type FileAttachmentKind,
	isArmAttachmentError,
	type MappingAttachmentKind,
	readArmAttachment,
	stageArmAttachment,
	writeArmAttachmentManifest,
} from "../../../src/suites/deep-swe/arm-attachments";
import {
	ARM_ATTACHMENT_SUFFIXES,
	armNamesIn,
	armSelectionError,
	computeArmFingerprint,
	findZeroIvCollisions,
	isArmConfigFile,
} from "../../../src/suites/deep-swe/arm-fingerprint";

const ARMS_DIR = armsDir();

/**
 * The table split by delivery, so a case that only makes sense for one shape says so.
 *
 * Derived, never listed: a kind added with a new delivery lands in neither list and the
 * exact-equality guard below turns red, which is the point.
 */
const MAPPING_KINDS: readonly MappingAttachmentKind[] = ARM_ATTACHMENT_KINDS.filter(
	(kind): kind is MappingAttachmentKind => kind.delivery === "env-json",
);
const FILE_KINDS: readonly FileAttachmentKind[] = ARM_ATTACHMENT_KINDS.filter(
	(kind): kind is FileAttachmentKind => kind.delivery === "rules-dir",
);

/** A payload of the shape a kind's delivery carries, for a case that does not care what is in it. */
function samplePayloadFor(kind: ArmAttachmentKind): ArmAttachmentPayload {
	return kind.delivery === "env-json"
		? { mapping: { "some/id": "replacement text" } }
		: { bytes: new TextEncoder().encode("# rule\n") };
}

/** The same payload as the fingerprint sees it: the mapping or the bytes, unwrapped. */
function sampleValueFor(kind: ArmAttachmentKind): Record<string, string | null> | Uint8Array {
	const payload = samplePayloadFor(kind);
	return "mapping" in payload ? payload.mapping : payload.bytes;
}

const PY_DIR = pierAgentDir();

/** Run a snippet against the real container-side reader, failing loudly if it cannot run. */
function python(snippet: string, ...args: string[]): string {
	const result = spawnSync("python3", ["-c", snippet, ...args], { cwd: PY_DIR, encoding: "utf8" });
	// A missing interpreter is a hole in the sweep, not a reason to skip: this package's
	// container adapter IS Python, so a tree that cannot run it cannot run a bench either.
	if (result.error !== undefined) throw new Error(`python3 unavailable: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`python3 refused: ${result.stderr.trim()}`);
	return result.stdout;
}

/** What the container-side reader supports, asked of the module itself. */
function pythonReader(): { version: number; deliveries: readonly string[] } {
	return JSON.parse(
		python(
			"import json, arm_attachments as a; " +
				"print(json.dumps({'version': a.SUPPORTED_MANIFEST_VERSION, 'deliveries': list(a.SUPPORTED_DELIVERIES)}))",
		),
	);
}

/** What the container-side reader would upload and run for one arm of a staged manifest. */
function pythonDelivery(manifestFile: string, arm: string): { kinds: readonly string[]; command: string } {
	return JSON.parse(
		python(
			"import json, sys, arm_attachments as a; " +
				"found = a.parse_arm_attachments(open(sys.argv[1]).read(), sys.argv[2]); " +
				"print(json.dumps({'kinds': [x.kind for x in found], " +
				"'command': a.environment_prefix(found, '/opt/veyyon-assets') + a.rules_setup_command(found, '/opt/veyyon-assets')}))",
			manifestFile,
			arm,
		),
	);
}

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

describe("an attachment that says the same thing twice", () => {
	const baselineConfig = { argot: { enabled: false } };

	// The other direction — an attachment CHANGING a fingerprint — is swept over every kind
	// in the table below, so only the collision case is stated here.

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
 * fingerprint, the staged assets and the manifest. A row that fails any of these is the
 * silent case.
 */
describe("every kind in ARM_ATTACHMENT_KINDS", () => {
	/** A scratch tree per case, since staging writes files. */
	function tempDir(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), "arm-attachments-"));
	}

	it("declares a distinct suffix and staged directory, and an eval-only variable per env kind", () => {
		const suffixes = ARM_ATTACHMENT_KINDS.map(kind => kind.suffix);
		const dirs = ARM_ATTACHMENT_KINDS.map(kind => kind.stagedDir);
		const envVars = MAPPING_KINDS.map(kind => kind.envVar);

		expect(new Set(suffixes).size).toBe(suffixes.length);
		expect(new Set(dirs).size).toBe(dirs.length);
		expect(new Set(envVars).size).toBe(envVars.length);
		// An override that a config key could reach would contaminate a production session,
		// so every id-keyed vehicle is an env var, and its name says it is an eval instrument.
		for (const envVar of envVars) expect(envVar.startsWith("VEYYON_EVAL")).toBe(true);
	});

	it("declares only deliveries the container-side reader performs", () => {
		// Pinned by exact equality against the Python reader's own list, not counted: a
		// delivery declared here and unimplemented there stages a file nothing delivers.
		const declared: string[] = [...new Set(ARM_ATTACHMENT_KINDS.map(kind => String(kind.delivery)))].sort();
		expect(declared).toEqual([...pythonReader().deliveries].sort());
	});

	it.each([...ARM_ATTACHMENT_KINDS])("$suffix is matched by attachmentKindOf and not by a plain arm", kind => {
		expect(attachmentKindOf(`candidate-a${kind.suffix}`)).toBe(kind);
		expect(attachmentKindOf("candidate-a.yml")).toBeUndefined();
	});

	it.each([...ARM_ATTACHMENT_KINDS])("$suffix changes the arm fingerprint it rides on", kind => {
		const config = { argot: { enabled: false } };
		const bare = computeArmFingerprint({ config });
		const carrying = computeArmFingerprint({ config, [kind.field]: sampleValueFor(kind) });

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

	it.each([...ARM_ATTACHMENT_KINDS])("$suffix is absent, not empty, when the arm has no such file", kind => {
		const read = readArmAttachment(kind, tempDir(), "candidate", "candidate");

		expect(read).toEqual({ present: false });
	});

	it.each([...MAPPING_KINDS])("$suffix reads back the mapping an arm declares", kind => {
		const armsDir = tempDir();
		fs.writeFileSync(path.join(armsDir, `candidate${kind.suffix}`), 'some/id: "replacement text"\n');

		const read = readArmAttachment(kind, armsDir, "candidate", "candidate");

		expect(read).toEqual({ present: true, payload: { mapping: { "some/id": "replacement text" } } });
	});

	it.each([...MAPPING_KINDS])("$suffix refuses a sequence, naming the arm and the file", kind => {
		const armsDir = tempDir();
		fs.writeFileSync(path.join(armsDir, `candidate${kind.suffix}`), "- one\n- two\n");

		const read = readArmAttachment(kind, armsDir, "candidate", "candidate");

		expect(isArmAttachmentError(read)).toBe(true);
		if (!isArmAttachmentError(read)) throw new Error("unreachable");
		expect(read.error).toContain(`candidate${kind.suffix}`);
		expect(read.error).toContain("got a sequence");
	});

	it.each([...MAPPING_KINDS])("$suffix refuses a value that is not text", kind => {
		const armsDir = tempDir();
		fs.writeFileSync(path.join(armsDir, `candidate${kind.suffix}`), "some/id: 42\n");

		expect(isArmAttachmentError(readArmAttachment(kind, armsDir, "candidate", "candidate"))).toBe(true);
	});

	it.each([...MAPPING_KINDS])("$suffix treats null as ablation only where the kind allows it", kind => {
		const armsDir = tempDir();
		fs.writeFileSync(path.join(armsDir, `candidate${kind.suffix}`), "some/id: null\n");

		const read = readArmAttachment(kind, armsDir, "candidate", "candidate");

		// `null` removes a statement, which no other kind can express: an empty string would
		// mean "this rule says nothing but is still here", a different prompt.
		expect(isArmAttachmentError(read)).toBe(!kind.allowsNull);
	});

	it.each([...FILE_KINDS])("$suffix reads back its bytes exactly, whitespace included", kind => {
		const armsDir = tempDir();
		const body = "# rule\n\n\tindented\ttabs  and trailing spaces   \n";
		fs.writeFileSync(path.join(armsDir, `candidate${kind.suffix}`), body);

		const read = readArmAttachment(kind, armsDir, "candidate", "candidate");

		// Prompt text, so every byte is significant: a normalized read would make two arms
		// that differ only in whitespace fingerprint alike, and one would be dropped.
		expect(read).toEqual({ present: true, payload: { bytes: new TextEncoder().encode(body) } });
	});

	it.each([...ARM_ATTACHMENT_KINDS])("$suffix stages exactly the bytes it declares, and says where", kind => {
		const assetsDir = tempDir();
		const payload = samplePayloadFor(kind);

		const entry = stageArmAttachment(kind, assetsDir, "candidate", payload);

		expect(entry.kind).toBe(kind.field);
		expect(entry.delivery).toBe(kind.delivery);
		expect(entry.envVar).toBe(kind.delivery === "env-json" ? kind.envVar : undefined);
		expect(entry.file.startsWith(`${kind.stagedDir}/`)).toBe(true);
		expect(fs.readFileSync(path.join(assetsDir, entry.file))).toEqual(
			"mapping" in payload ? Buffer.from(JSON.stringify(payload.mapping)) : Buffer.from(payload.bytes),
		);
	});

	it("has a kind for every attachment file shipped in arms/", () => {
		const shipped = fs.readdirSync(ARMS_DIR).filter(name => name.split(".").length > 2 || name.endsWith(".rule.md"));

		// Fails when an arm ships an attachment kind the table does not know: the file would
		// otherwise be read as an arm config named `candidate-x.newkind`.
		expect(shipped.filter(name => attachmentKindOf(name) === undefined)).toEqual([]);
		expect(shipped.length).toBeGreaterThan(0);
	});

	it("declares a kind for each attachment field the fingerprint hashes", () => {
		// Pinned by exact equality, not counted: a field added to ArmInputs without a kind is
		// an override nothing stages, and a kind without a field is an override nothing hashes.
		expect(ARM_ATTACHMENT_KINDS.map(kind => kind.field)).toEqual(["sections", "statements", "prompts", "rule"]);
	});

	it("keeps only the YAML kinds in the suffix list arm selection tests against", () => {
		// `.rule.md` is not a `.yml`, so including it would have `isArmConfigFile` and
		// `armSelectionError` testing a suffix no candidate arm name can carry.
		expect([...ARM_ATTACHMENT_SUFFIXES]).toEqual(MAPPING_KINDS.map(kind => kind.suffix));
		for (const suffix of ARM_ATTACHMENT_SUFFIXES) expect(suffix.endsWith(".yml")).toBe(true);
	});

	it("keeps the fingerprint of an arm that carries nothing", () => {
		const config = { argot: { enabled: false } };

		expect(computeArmFingerprint({ config })).toBe(computeArmFingerprint({ config }));
	});
});

/**
 * The manifest is the whole contract with the container side, and the only place a kind is
 * named across the language boundary. These cases drive the real Python reader: a TypeScript
 * assertion about what Python "would" do is exactly the assumption that let three hardcoded
 * per-kind blocks drift from this table.
 */
describe("the manifest the container side reads", () => {
	function stagedRun(): { assetsDir: string; manifest: ArmAttachmentManifest } {
		const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "arm-manifest-"));
		const entries = ARM_ATTACHMENT_KINDS.map(kind =>
			stageArmAttachment(kind, assetsDir, "candidate", samplePayloadFor(kind)),
		);
		writeArmAttachmentManifest(
			assetsDir,
			new Map([
				["baseline", []],
				["candidate", entries],
			]),
		);
		const manifest = JSON.parse(
			fs.readFileSync(path.join(assetsDir, ARM_ATTACHMENT_MANIFEST_FILE), "utf8"),
		) as ArmAttachmentManifest;
		return { assetsDir, manifest };
	}

	it("names every arm the run staged for, including one that carries nothing", () => {
		const { manifest } = stagedRun();

		// An arm the manifest does not name is refused by the reader, so a baseline needs an
		// entry of its own: "carries nothing" and "was never staged" must stay distinguishable.
		expect(Object.keys(manifest.arms)).toEqual(["baseline", "candidate"]);
		expect(manifest.arms.baseline).toEqual([]);
		expect(manifest.version).toBe(ARM_ATTACHMENT_MANIFEST_VERSION);
	});

	it("lists every kind in the table, once, with the file it staged", () => {
		const { assetsDir, manifest } = stagedRun();

		expect(manifest.arms.candidate?.map(entry => entry.kind)).toEqual(ARM_ATTACHMENT_KINDS.map(kind => kind.field));
		for (const entry of manifest.arms.candidate ?? []) {
			expect(fs.existsSync(path.join(assetsDir, entry.file))).toBe(true);
		}
	});

	it("is the version the container-side reader accepts", () => {
		// A stale assets directory is hashed into a past run's provenance and kept, so the two
		// sides agreeing on the version is what makes a shape change a refusal instead of a
		// misread. Pinned across the language boundary rather than restated on each side.
		expect(pythonReader().version).toBe(ARM_ATTACHMENT_MANIFEST_VERSION);
	});

	it("reaches the container command through the real Python reader, for every kind", () => {
		const { assetsDir, manifest } = stagedRun();
		const delivered = pythonDelivery(path.join(assetsDir, ARM_ATTACHMENT_MANIFEST_FILE), "candidate");

		expect(delivered.kinds).toEqual(ARM_ATTACHMENT_KINDS.map(kind => kind.field));
		for (const entry of manifest.arms.candidate ?? []) {
			// The staged path in the emitted shell fragment is the proof the attachment is
			// delivered: an uploaded file no command mentions is an ignored treatment.
			expect(delivered.command).toContain(entry.file);
			if (entry.envVar !== undefined) expect(delivered.command).toContain(`${entry.envVar}="$(cat`);
		}
	});

	it("is refused by the Python reader when its version is not the one it knows", () => {
		const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "arm-manifest-stale-"));
		const file = path.join(assetsDir, ARM_ATTACHMENT_MANIFEST_FILE);
		fs.writeFileSync(file, JSON.stringify({ version: ARM_ATTACHMENT_MANIFEST_VERSION + 1, arms: { candidate: [] } }));

		expect(() => pythonDelivery(file, "candidate")).toThrow(/version/);
	});
});
