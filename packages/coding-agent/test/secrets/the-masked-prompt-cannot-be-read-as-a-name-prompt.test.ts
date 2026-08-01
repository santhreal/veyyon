/**
 * The masked credential field, driven the way an operator drives it: real keystrokes.
 *
 * WHY THIS SUITE EXISTS. Every other `/secret` test stubs `showHookInput` and returns a string,
 * so the whole interactive seam (real `ExtensionUiController` dialog -> real `HookInputComponent`
 * -> real `Input` -> real vault write) was never exercised end to end. The bug that motivated this
 * lived exactly there in spirit: `/secret add` with no name opened a field titled "Paste the
 * secret", an operator read that as "name the secret", typed `GITHUB_TOKEN`, and veyyon stored the
 * NAME as the credential under an invented `SECRET_1`.
 *
 * Nothing downstream can catch that mistake. A name is a perfectly well-formed secret value, and a
 * shape heuristic that refused name-looking input would refuse real credentials: an AWS key id
 * such as `AKIAIOSFODNN7EXAMPLE` is uppercase, underscore-free, and indistinguishable from a name.
 * The prompt wording is therefore the ONLY defence, which is why it is pinned here as a contract
 * rather than left as prose someone can soften later.
 *
 * The suite asserts two separable things, because either alone would let the bug back:
 *   1. the wording cannot be read as a request for a name, and
 *   2. whatever the operator actually types or pastes is the exact byte sequence stored.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ExtensionUiController } from "@veyyon/coding-agent/modes/controllers/extension-ui-controller";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { resolveVaultLocations, SecretVault } from "@veyyon/coding-agent/secrets/vault";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import {
	maskedPromptTitle,
	namePromptTitle,
	runSecretCommandForSurface,
} from "@veyyon/coding-agent/slash-commands/helpers/secret";
import { DEFAULT_MASK_CHAR } from "@veyyon/tui";
import { PASTE_END, PASTE_START } from "@veyyon/tui/bracketed-paste";

let home: string;
let project: string;

beforeAll(async () => {
	// The dialog builds real themed components, so the theme has to be installed first.
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(theme);
});

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-prompt-home-"));
	project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-prompt-proj-"));
});

afterEach(async () => {
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(project, { recursive: true, force: true });
});

function agentDir(): string {
	return path.join(home, "profiles", "default");
}

function locations() {
	return resolveVaultLocations({ globalConfigRoot: home, agentDir: agentDir(), cwd: project });
}

/** One presented dialog: its title and whether the field hid what was typed. */
interface PresentedField {
	title: string;
	masked: boolean;
}

/**
 * Run `/secret <args>` through the REAL dialogs, with `typeValue`/`typeName` driving the real
 * components.
 *
 * Both prompts are wired exactly as `builtin-registry.ts` wires them, including which one gets a
 * mask, so the fields under test are the fields the operator sees.
 */
async function addThroughRealDialog(
	args: string,
	typeValue: (feed: (bytes: string) => void) => void,
	typeName?: (feed: (bytes: string) => void) => void,
): Promise<{ fields: PresentedField[] }> {
	const fields: PresentedField[] = [];
	const uiCtx = {
		ui: { setFocus() {}, requestRender() {}, requestComponentRender() {}, terminal: { rows: 40 } },
		editorContainer: { clear() {}, addChild() {} },
		editor: {},
		hookInput: undefined as { handleInput(bytes: string): void } | undefined,
	};
	const controller = new ExtensionUiController(uiCtx as never);

	const present = (
		title: string,
		mask: string | undefined,
		drive: (feed: (bytes: string) => void) => void,
	): Promise<string | undefined> => {
		fields.push({ title, masked: mask !== undefined });
		const pending = controller.showHookInput(title, undefined, undefined, mask ? { mask } : undefined);
		const component = uiCtx.hookInput;
		if (component === undefined) throw new Error("The field was never presented.");
		drive(bytes => component.handleInput(bytes));
		return pending;
	};

	const port = {
		session: {
			obfuscator: undefined,
			secretsEnabled: true,
			operatorNotices: new OperatorNotices(),
			agent: { appendMessage: () => {} },
			refreshSecrets: async () => {},
		},
		sessionManager: { appendMessage: () => {} },
		settings: {
			get: (key: string) =>
				({ "secrets.enabled": true, "secrets.auditLog": false, "secrets.defaultTtl": "1d" })[key],
			set: () => {},
			flush: async () => {},
		},
		cwd: project,
		globalConfigRoot: home,
		agentDir: agentDir(),
		promptForValue: (name: string | undefined) => present(maskedPromptTitle(name), DEFAULT_MASK_CHAR, typeValue),
		...(typeName === undefined ? {} : { promptForName: () => present(namePromptTitle(), undefined, typeName) }),
	};

	await runSecretCommandForSurface(args, port as never);
	return { fields };
}

/** Every live entry, so a test can assert the stored bytes rather than a success message. */
async function stored(): Promise<Array<{ name: string; value: string }>> {
	return (await new SecretVault(locations()).load()).map(entry => ({ name: entry.name, value: entry.value }));
}

describe("the wording of the masked credential field", () => {
	/**
	 * LOCKS OUT the exact defect: an unnamed `/secret add` whose title says "Paste the secret",
	 * which an operator reads as a request for the secret's NAME. The field is masked, so a
	 * misread is unrecoverable and invisible. The title must name what it wants (a value) and
	 * explicitly deny what it does not want (a name).
	 */
	it("tells an unnamed add that it wants a value and not a name", () => {
		const title = maskedPromptTitle(undefined);

		expect(title).toContain("value");
		expect(title).toContain("not a name");
		// The generated name is announced, so `SECRET_1` in the confirmation is not a surprise.
		expect(title).toContain("generated");
	});

	/**
	 * The named form must say "value for <NAME>" rather than merely mentioning the name: a title
	 * that only echoes the name is precisely the ambiguity this suite exists to remove.
	 */
	it("tells a named add whose value it wants", () => {
		const title = maskedPromptTitle("GITHUB_TOKEN");

		expect(title).toContain("value for GITHUB_TOKEN");
	});

	/**
	 * Both forms promise masking. An operator who cannot see what they typed relies on this line
	 * to know the field is safe to paste a live credential into.
	 */
	it("promises masking in both forms", () => {
		expect(maskedPromptTitle(undefined)).toContain("hidden as you type");
		expect(maskedPromptTitle("GITHUB_TOKEN")).toContain("hidden as you type");
	});
});

describe("a credential entered through the real masked dialog", () => {
	/**
	 * The end-to-end contract nothing else covers: keystrokes typed into the REAL component reach
	 * the vault as the exact bytes typed, under the name the operator asked for. A regression
	 * anywhere in dialog settlement, masking, or `request.value` assignment fails here.
	 */
	it("stores exactly the typed bytes under the requested name", async () => {
		await addThroughRealDialog("add GITHUB_TOKEN", feed => {
			for (const character of "ghp_typedCredential12345") feed(character);
			feed("\r");
		});

		expect(await stored()).toEqual([{ name: "GITHUB_TOKEN", value: "ghp_typedCredential12345" }]);
	});

	/**
	 * Pasting is how a real credential is entered, and it travels as one bracketed-paste burst
	 * rather than as keystrokes. Storing the paste framing bytes, or dropping the payload, would
	 * silently persist a credential that does not authenticate.
	 */
	it("stores a bracketed paste as the credential, without its framing", async () => {
		await addThroughRealDialog("add PASTED_TOKEN", feed => {
			feed(`${PASTE_START}ghp_pastedCredential67890${PASTE_END}`);
			feed("\r");
		});

		expect(await stored()).toEqual([{ name: "PASTED_TOKEN", value: "ghp_pastedCredential67890" }]);
	});

	/**
	 * The unnamed path still works and still generates a name. This is the behaviour the wording
	 * fix protects rather than removes: it must keep storing what was typed as the VALUE.
	 */
	it("stores the typed value under a generated name when no name was given", async () => {
		const { fields } = await addThroughRealDialog("add", feed => {
			for (const character of "ghp_unnamedCredential999") feed(character);
			feed("\r");
		});

		// No name field here: this surface supplied only `promptForValue`, which is the fallback
		// path the wording above still has to carry on its own.
		expect(fields).toEqual([{ title: maskedPromptTitle(undefined), masked: true }]);
		const entries = await stored();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.value).toBe("ghp_unnamedCredential999");
	});

	/**
	 * Cancelling stores nothing. A field that persisted a partial credential on escape would leave
	 * a placeholder that spends the wrong bytes, which is worse than storing nothing at all.
	 */
	it("stores nothing when the field is cancelled", async () => {
		const outcome = await (async () => {
			let captured: string | undefined;
			await addThroughRealDialog("add CANCELLED_TOKEN", feed => {
				for (const character of "ghp_halfTypedCredential") feed(character);
				feed("\x1b");
			}).then(() => {
				captured = "completed";
			});
			return captured;
		})();

		expect(outcome).toBe("completed");
		expect(await stored()).toEqual([]);
	});
});

/**
 * The structural fix: two fields instead of one overloaded field.
 *
 * Wording alone could only discourage the mistake. Asking the name in its own VISIBLE field, then
 * the value in a hidden one, makes "which question is this" answerable from the screen rather than
 * from a sentence, so an operator answering the name question can no longer land their answer in
 * the credential.
 */
describe("the name field shown before the masked one", () => {
	/**
	 * LOCKS OUT the reported bug at its root. Two fields are presented, in order, and only the
	 * second one masks. If the name step is ever dropped or the mask ever moves to the name field,
	 * the ambiguity that stored `GITHUB_TOKEN` as a credential is back.
	 */
	it("asks for the name first, unmasked, then the value, masked", async () => {
		const { fields } = await addThroughRealDialog(
			"add",
			feed => {
				for (const character of "ghp_twoStepCredential11") feed(character);
				feed("\r");
			},
			feed => {
				for (const character of "github token") feed(character);
				feed("\r");
			},
		);

		expect(fields).toEqual([
			{ title: namePromptTitle(), masked: false },
			// The value field names the secret the operator just chose, normalised.
			{ title: maskedPromptTitle("GITHUB_TOKEN"), masked: true },
		]);
		expect(await stored()).toEqual([{ name: "GITHUB_TOKEN", value: "ghp_twoStepCredential11" }]);
	});

	/**
	 * The name field is OPTIONAL. Someone stashing a credential should not have to invent a label,
	 * so an empty name keeps the generated one and the value is still stored.
	 */
	it("generates a name when the field is left empty", async () => {
		await addThroughRealDialog(
			"add",
			feed => {
				for (const character of "ghp_generatedNameCred22") feed(character);
				feed("\r");
			},
			feed => feed("\r"),
		);

		const entries = await stored();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.value).toBe("ghp_generatedNameCred22");
		expect(entries[0]?.name).toMatch(/^SECRET_\d+$/);
	});

	/**
	 * A name given on the command line is not asked for again. Re-asking would be a second chance
	 * to contradict what was already typed, and would make the common `/secret add NAME` slower for
	 * no benefit.
	 */
	it("does not ask for a name the command already carried", async () => {
		const { fields } = await addThroughRealDialog(
			"add PRESET_TOKEN",
			feed => {
				for (const character of "ghp_presetNameCred333") feed(character);
				feed("\r");
			},
			() => {
				throw new Error("The name field must not open when the command already named the secret.");
			},
		);

		expect(fields).toEqual([{ title: maskedPromptTitle("PRESET_TOKEN"), masked: true }]);
		expect(await stored()).toEqual([{ name: "PRESET_TOKEN", value: "ghp_presetNameCred333" }]);
	});

	/**
	 * Escaping the NAME field abandons the whole command before the credential field ever opens.
	 * Continuing to the masked field would ask for a live credential the operator just declined to
	 * name, and storing it under a generated name is not what cancelling means.
	 */
	it("abandons the command when the name field is cancelled", async () => {
		const { fields } = await addThroughRealDialog(
			"add",
			() => {
				throw new Error("The masked field must not open after the name field was cancelled.");
			},
			feed => feed("\x1b"),
		);

		expect(fields).toEqual([{ title: namePromptTitle(), masked: false }]);
		expect(await stored()).toEqual([]);
	});

	/**
	 * An unusable name typed into the field is refused BEFORE the masked field opens, the same rule
	 * that already applied to a name given on the command line. Prompting first would take a live
	 * credential into memory and then throw the request away over a name.
	 */
	it("refuses an unusable typed name without asking for a credential", async () => {
		await expect(
			addThroughRealDialog(
				"add",
				() => {
					throw new Error("The masked field must not open for an unusable name.");
				},
				feed => {
					for (const character of "ab") feed(character);
					feed("\r");
				},
			),
		).rejects.toThrow(/not a usable secret name/);
		expect(await stored()).toEqual([]);
	});
});
