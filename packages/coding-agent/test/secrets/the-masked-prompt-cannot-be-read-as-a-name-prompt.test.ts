/**
 * The verbless `/secret` grammar and its two fields, driven the way an operator drives them:
 * real keystrokes into real components.
 *
 * WHY THIS SUITE EXISTS. Every other `/secret` test stubs `showHookInput` and returns a string,
 * so the whole interactive seam (real `ExtensionUiController` dialog -> real `HookInputComponent`
 * -> real `Input` -> real vault write) was never exercised end to end. The bug that motivated it
 * lived exactly there: `/secret add` with no name opened a field titled "Paste the secret", an
 * operator read that as "name the secret", typed `GITHUB_TOKEN`, and veyyon stored the NAME as
 * the credential under an invented `SECRET_1`.
 *
 * Nothing downstream can catch that mistake. A name is a perfectly well-formed secret value, and a
 * shape heuristic that refused name-looking input would refuse real credentials: an AWS key id
 * such as `AKIAIOSFODNN7EXAMPLE` is uppercase, underscore-free, and indistinguishable from a name.
 *
 * THE GRAMMAR IS NOW THE PRIMARY DEFENCE, and the wording is the second. In a terminal there is no
 * leading name to mistype a credential into: the argument line IS the value unless its first word
 * is one of the management verbs, and the name is asked afterwards where declining it costs
 * nothing. So the suite asserts three separable things, because any one alone would let the bug
 * back:
 *   1. the terminal grammar reads the whole line as a credential and reserves nothing but the verbs,
 *   2. the wording of the masked field cannot be read as a request for a name, and
 *   3. whatever the operator actually types or pastes is the exact byte sequence stored.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HookInputComponent } from "@veyyon/coding-agent/modes/components/hook-input";
import { ExtensionUiController } from "@veyyon/coding-agent/modes/controllers/extension-ui-controller";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { resolveVaultLocations, SecretVault } from "@veyyon/coding-agent/secrets/vault";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import {
	maskedPromptHint,
	maskedPromptTitle,
	namePromptTitle,
	runSecretCommandForSurface,
	type SecretCommandOutcome,
} from "@veyyon/coding-agent/slash-commands/helpers/secret";
import { DEFAULT_MASK_CHAR } from "@veyyon/tui";
import { PASTE_END, PASTE_START } from "@veyyon/tui/bracketed-paste";
import { stripAnsi } from "@veyyon/utils";

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

/** Drives one real field: `feed` delivers bytes to the live component. */
type Drive = (feed: (bytes: string) => void) => void;

/**
 * Refuse to answer a field, and say which one opened.
 *
 * Used wherever a test's contract is that a field must NOT open. A silently unused driver would
 * let the field open and be answered by nothing, which reads as a pass.
 */
function mustNotOpen(field: string): Drive {
	return () => {
		throw new Error(`The ${field} field must not open here.`);
	};
}

/**
 * The host the controller presents a field INTO.
 *
 * The hook input is a floating card on the overlay stack, not a child of the editor slot, so
 * `showOverlay` is the seam the field has to cross to be on screen at all. The stack is kept
 * here and read by the callers below: a field the controller built but never handed to an
 * overlay is a field the operator cannot see, and a host missing the call would otherwise make
 * every case in this suite fail for the host rather than for the grammar or the wording.
 */
function hookHost(): {
	overlays: unknown[];
	ctx: { hookInput: HookInputComponent | undefined };
} {
	const overlays: unknown[] = [];
	const ctx = {
		ui: {
			setFocus() {},
			requestRender() {},
			requestComponentRender() {},
			showOverlay(component: unknown) {
				overlays.push(component);
				return {
					hide() {
						const at = overlays.indexOf(component);
						if (at >= 0) overlays.splice(at, 1);
					},
					setHidden() {},
				};
			},
			terminal: { columns: 100, rows: 40 },
		},
		editorContainer: { clear() {}, addChild() {} },
		editor: {},
		focusActiveEditorArea() {},
		hookInput: undefined as HookInputComponent | undefined,
	};
	return { overlays, ctx };
}

/**
 * Run `/secret <args>` through the REAL dialogs, with `typeValue`/`typeName` driving the real
 * components.
 *
 * Both prompts are wired exactly as `builtin-registry.ts` wires them, including which one gets a
 * mask, so the fields under test are the fields the operator sees.
 */
async function secretThroughRealDialog(
	args: string,
	options: { typeValue?: Drive; typeName?: Drive } = {},
): Promise<{ fields: PresentedField[]; outcome: SecretCommandOutcome }> {
	const { typeName } = options;
	const fields: PresentedField[] = [];
	const { overlays, ctx: uiCtx } = hookHost();
	const controller = new ExtensionUiController(uiCtx as never);

	const present = (title: string, mask: string | undefined, drive: Drive): Promise<string | undefined> => {
		fields.push({ title, masked: mask !== undefined });
		const pending = controller.showHookInput(title, undefined, undefined, mask ? { mask } : undefined);
		const component = uiCtx.hookInput;
		if (component === undefined) throw new Error("The field was never presented.");
		if (!overlays.includes(component)) throw new Error("The field was built but never put on screen.");
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
		// Always supplied, because its presence is what selects the TUI surface. A test whose
		// contract is that the masked field stays shut passes `mustNotOpen`.
		promptForValue: () =>
			present(maskedPromptTitle(), DEFAULT_MASK_CHAR, options.typeValue ?? mustNotOpen("masked value")),
		...(typeName === undefined ? {} : { promptForName: () => present(namePromptTitle(), undefined, typeName) }),
	};

	const outcome = await runSecretCommandForSurface(args, port as never);
	return { fields, outcome };
}

/** Every live entry, so a test can assert the stored bytes rather than a success message. */
async function stored(): Promise<Array<{ name: string; value: string }>> {
	return (await new SecretVault(locations()).load()).map(entry => ({ name: entry.name, value: entry.value }));
}

/** Type `text` into a field and accept it. The keystroke path a credential actually takes. */
function type(text: string): Drive {
	return feed => {
		for (const character of text) feed(character);
		feed("\r");
	};
}

/**
 * The terminal grammar: the argument line is the credential, and only the verbs are reserved.
 *
 * This is the layer that makes the original bug unreachable rather than merely discouraged. There
 * is no longer a position in the command where a name is expected, so a pasted token cannot land
 * in one.
 */
describe("the verbless /secret grammar in a terminal", () => {
	/**
	 * LOCKS OUT the whole class of "which positional was that" mistakes: a token pasted straight
	 * after `/secret` is the VALUE, byte for byte, and no field opens to ask for it. If a verb or a
	 * leading name is ever reintroduced, this token would be parsed as a name and the test fails.
	 */
	it("stores a pasted token as the value without opening the masked field", async () => {
		const { fields } = await secretThroughRealDialog("ghp_inlineCredential4242", { typeName: type("") });

		expect(fields).toEqual([{ title: namePromptTitle(), masked: false }]);
		const entries = await stored();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.value).toBe("ghp_inlineCredential4242");
	});

	/**
	 * THE EXACT INVERSE OF THE ORIGINAL BUG, driven through the real dialogs: `/secret add <value>`
	 * stores the VALUE and asks for a name afterwards, so `GITHUB_TOKEN` here is the credential and
	 * never becomes a name with no value attached. `add` is a synonym for the bare form in a
	 * terminal, and a regression that restored positional-name parsing would store nothing under
	 * that value and fail.
	 */
	it("reads add as a synonym for the bare value form", async () => {
		await secretThroughRealDialog("add GITHUB_TOKEN", { typeName: type("") });

		const entries = await stored();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.value).toBe("GITHUB_TOKEN");
		expect(entries[0]?.name).not.toBe("GITHUB_TOKEN");
	});

	/**
	 * A passphrase is allowed to contain spaces, so the value is the span from the first token to
	 * the last, not a single word and not a re-joined token list. Splitting on whitespace here
	 * would store a truncated credential that fails to authenticate with nothing on screen to say
	 * so, which is the worst available failure.
	 */
	it("keeps whitespace inside the credential and drops only what surrounds it", async () => {
		await secretThroughRealDialog("   correct horse  battery staple   ", { typeName: type("") });

		const entries = await stored();
		expect(entries[0]?.value).toBe("correct horse  battery staple");
	});

	/**
	 * A VERB RUNS AND STORES NOTHING, through the real dialogs and the real vault. `list` is the one
	 * an operator types within seconds of storing their first credential, so if a reserved word ever
	 * fell through to the store path this is where it would show up: the word itself saved as a
	 * secret, protection switched on, and the answer to "what do I have" being "the word list".
	 */
	it("runs a reserved word without opening a field or writing anything", async () => {
		const { fields, outcome } = await secretThroughRealDialog("list", {
			typeName: mustNotOpen("name"),
		});

		expect(outcome.message).not.toBe("");
		expect(fields).toEqual([]);
		expect(await stored()).toEqual([]);
	});

	/**
	 * A reserved word is a command however much follows it, so a malformed one stores NOTHING and
	 * refuses. Falling back to storage when a verb does not fit its shape is what would turn
	 * `/secret log 50` into a credential named after the command the operator was trying to run.
	 */
	it("refuses a malformed reserved line rather than storing it", async () => {
		await expect(secretThroughRealDialog("log 50", { typeName: type("") })).rejects.toThrow(/\/secret -- <value>/u);

		expect(await stored()).toEqual([]);
	});

	/**
	 * And the escape stores that same line, so an operator whose credential really does begin with a
	 * reserved word is not locked out. This is the row that makes the refusal above defensible. The
	 * credential is long because the vault refuses anything under the obfuscatable-length floor, and
	 * a six-character escape would have failed here for a reason that has nothing to do with the
	 * escape.
	 */
	it("stores an escaped line whose first word is reserved", async () => {
		await secretThroughRealDialog("-- log ghp_startsWithAReservedWord", { typeName: type("") });

		const entries = await stored();
		expect(entries[0]?.value).toBe("log ghp_startsWithAReservedWord");
	});

	/**
	 * `--from-env` survives the grammar change, in leading position only. It is the single entry
	 * form that never puts the credential on screen at all, so losing it from the terminal would
	 * have left the safest path available to ACP clients and not to the operator.
	 */
	it("still reads a credential out of the environment without a field", async () => {
		process.env.VEYYON_TEST_FROM_ENV_TOKEN = "ghp_fromEnvCredential77";
		try {
			await secretThroughRealDialog("--from-env VEYYON_TEST_FROM_ENV_TOKEN", { typeName: type("") });
		} finally {
			delete process.env.VEYYON_TEST_FROM_ENV_TOKEN;
		}

		const entries = await stored();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.value).toBe("ghp_fromEnvCredential77");
	});

	/**
	 * A `--from-env` that names nothing is refused rather than stored as the literal text
	 * `--from-env`. The flag reading and the credential reading of that word are mutually
	 * exclusive, so the ambiguous case must fail loudly instead of picking one.
	 */
	it("refuses a --from-env with no variable rather than storing the flag", async () => {
		await expect(secretThroughRealDialog("--from-env")).rejects.toThrow(/needs the name of an environment variable/);
		expect(await stored()).toEqual([]);
	});
});

/**
 * What the operator actually reads, rendered.
 *
 * These assert the PAINTED FIELD rather than the title string. The four things this field has to
 * communicate used to live in one sentence, which made the string the whole surface and a string
 * assertion sufficient. It read as a paragraph and it did not say what to do, so the two
 * mechanical facts moved to the legend row. Had these stayed string tests they would have failed
 * for a copy improvement while a genuinely broken field, one whose hint never reached the
 * component, would have passed.
 *
 * So the field is presented through the REAL {@link ExtensionUiController}, the same call the
 * registry makes, rather than by constructing the component here. That is the seam the hint has
 * to survive: `showHookInput` receives it in `inputOptions` and has to hand it to the component,
 * and a version that accepted the option and dropped it would render a field missing the only
 * statement that it masks what you type.
 */
describe("the masked credential field as the operator sees it", () => {
	/** Present a masked field through the real controller, and return what it paints at 100 columns. */
	function paintedField(title: string, hint: string): string {
		const { overlays, ctx: uiCtx } = hookHost();
		const controller = new ExtensionUiController(uiCtx as never);
		void controller.showHookInput(title, undefined, undefined, { mask: DEFAULT_MASK_CHAR, hint });
		const field = uiCtx.hookInput;
		if (field === undefined) throw new Error("The field was never presented.");
		if (!overlays.includes(field)) throw new Error("The field was built but never put on screen.");
		return stripAnsi(field.render(100).join("\n"));
	}

	/** The field the way the registry presents it, which is what the wording cases below read. */
	function paintedMaskedField(): string {
		return paintedField(maskedPromptTitle(), maskedPromptHint());
	}

	/**
	 * LOCKS OUT the exact defect: a field titled "Paste the secret", which an operator reads as a
	 * request for the secret's NAME. The field is masked, so a misread is unrecoverable and
	 * invisible. The field must name what it wants (a value) and explicitly deny what it does not.
	 */
	it("says it wants a value and not a name", () => {
		const painted = paintedMaskedField();

		expect(painted).toContain("value");
		expect(painted).toContain("not a name");
	});

	/**
	 * The field must say the naming question is still coming. Without that, an operator who wants
	 * to label the secret has no reason to believe they will get the chance, and the pressure to
	 * answer this field with a name comes straight back.
	 */
	it("promises the name can be given afterwards", () => {
		expect(paintedMaskedField()).toContain("afterwards");
	});

	/**
	 * The field promises masking. An operator who cannot see what they typed relies on this to
	 * know it is safe to paste a live credential. It is now on the legend row rather than in the
	 * title, so this is exactly the assertion that catches the hint being dropped in wiring.
	 */
	it("promises masking and encryption at rest", () => {
		const painted = paintedMaskedField();

		expect(painted).toContain("hidden as you type");
		expect(painted).toContain("stored encrypted");
	});

	/**
	 * The instruction is what the operator must ACT on, so it may not be buried behind the
	 * mechanics. Pinning the order catches a refactor that appends the title to the legend row or
	 * reorders the children: both would render every required word and still bury the imperative.
	 */
	it("puts the instruction above the mechanics", () => {
		const painted = paintedMaskedField();

		expect(painted.indexOf("Paste the secret value")).toBeLessThan(painted.indexOf("hidden as you type"));
	});

	/**
	 * THE CARD IS AS WIDE AS ITS OWN SENTENCES. The field is a floating card sized at a fraction of
	 * the terminal, and a 60% card on a 100-column terminal cut the instruction to "You can name it
	 * afte…" and the promise to "stored encr…". Both sentences are the field's defence against
	 * storing a NAME as a credential, so neither may end in an ellipsis: `HookInputComponent` raises
	 * the card's width floor to fit them. Asserted as "no ellipsis on the title or the hint row"
	 * rather than as a width number, because the contract is legibility and not a column count.
	 */
	it("shows its instruction and its promise whole, with nothing cut off", () => {
		const rows = paintedMaskedField().split("\n");
		const titleRow = rows.find(row => row.includes("Paste the secret value")) ?? "";
		const hintRow = rows.find(row => row.includes("hidden as you type")) ?? "";

		expect(titleRow).toContain("You can name it afterwards.");
		expect(titleRow).not.toContain("…");
		expect(hintRow).toContain("stored encrypted");
		expect(hintRow).not.toContain("…");
	});

	/**
	 * EITHER sentence sets the width, and this is the arm that proves it separately.
	 *
	 * The shipped wording happens to have the longer requirement in the TITLE, so a card that sized
	 * itself to the title alone still painted the shipped hint whole and the case above stayed green
	 * while half the rule was gone. These two fields invert the pair: one whose hint is far longer
	 * than its title, one whose title is far longer than its hint. Each must be readable, so
	 * dropping either term of the width floor fails here even when the shipped strings would not
	 * notice.
	 */
	it("sizes to whichever of the two sentences is longer", () => {
		const longHint = "a hint that is considerably longer than the title above it, and still one line";
		const hintLed = paintedField("Short title", longHint);
		expect(hintLed.split("\n").find(row => row.includes("considerably longer")) ?? "").toContain("still one line");
		expect(hintLed).not.toContain("…");

		const longTitle = "A title that is considerably longer than the hint under it, ending in a period.";
		const titleLed = paintedField(longTitle, "short hint");
		expect(titleLed.split("\n").find(row => row.includes("considerably longer")) ?? "").toContain(
			"ending in a period.",
		);
		expect(titleLed).not.toContain("…");
	});

	/**
	 * The legend keeps its keys, in the same footer band as the hint. A naive implementation that
	 * REPLACED the legend rather than joining it would take the only statement of how to submit or
	 * escape off the screen.
	 *
	 * The keys are asserted by ACTION rather than by one spelling of a binding: `cancel` is bound to
	 * esc and to ctrl+c, the chip names every live binding, and pinning "esc cancel" as a literal
	 * made the suite fail for a card that named one key MORE than it used to.
	 */
	it("keeps the submit and cancel keys in the footer band beside the hint", () => {
		const rows = paintedMaskedField().split("\n");
		const hintRow = rows.findIndex(row => row.includes("hidden as you type"));
		const keyRow = rows.findIndex(row => row.includes("submit"));

		expect(hintRow).toBeGreaterThanOrEqual(0);
		// Same band: the keys sit on the hint's row or the one under it, never elsewhere on screen.
		expect(keyRow - hintRow).toBeGreaterThanOrEqual(0);
		expect(keyRow - hintRow).toBeLessThanOrEqual(1);
		expect(rows[keyRow]).toContain("enter");
		expect(rows[keyRow]).toContain("cancel");
		expect(rows[keyRow]).toContain("esc");
	});
});

describe("a credential entered through the real masked dialog", () => {
	/**
	 * The end-to-end contract nothing else covers: keystrokes typed into the REAL component reach
	 * the vault as the exact bytes typed, under the name given afterwards. A
	 * regression anywhere in dialog settlement, masking, or `request.value` assignment fails here.
	 */
	it("stores exactly the typed bytes under the name given afterwards", async () => {
		await secretThroughRealDialog("", {
			typeValue: type("ghp_typedCredential12345"),
			typeName: type("github token"),
		});

		expect(await stored()).toEqual([{ name: "GITHUB_TOKEN", value: "ghp_typedCredential12345" }]);
	});

	/**
	 * Pasting is how a real credential is entered, and it travels as one bracketed-paste burst
	 * rather than as keystrokes. Storing the paste framing bytes, or dropping the payload, would
	 * silently persist a credential that does not authenticate.
	 */
	it("stores a bracketed paste as the credential, without its framing", async () => {
		await secretThroughRealDialog("", {
			typeValue: feed => {
				feed(`${PASTE_START}ghp_pastedCredential67890${PASTE_END}`);
				feed("\r");
			},
			typeName: type("pasted token"),
		});

		expect(await stored()).toEqual([{ name: "PASTED_TOKEN", value: "ghp_pastedCredential67890" }]);
	});

	/**
	 * A surface that implements only the masked field still works and still generates a name. This
	 * is the fallback the wording above has to carry alone, so it must keep storing what was typed
	 * as the VALUE rather than refusing for want of a name.
	 */
	it("stores the typed value under a generated name when no name field exists", async () => {
		const { fields } = await secretThroughRealDialog("", { typeValue: type("ghp_unnamedCredential999") });

		expect(fields).toEqual([{ title: maskedPromptTitle(), masked: true }]);
		const entries = await stored();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.value).toBe("ghp_unnamedCredential999");
		expect(entries[0]?.name).toMatch(/^SECRET_\d+$/);
	});

	/**
	 * Cancelling the value field stores nothing and never reaches the naming question. A field that
	 * persisted a partial credential on escape would leave a placeholder that spends the wrong
	 * bytes, which is worse than storing nothing at all.
	 */
	it("stores nothing when the value field is cancelled", async () => {
		const { outcome } = await secretThroughRealDialog("", {
			typeValue: feed => {
				for (const character of "ghp_halfTypedCredential") feed(character);
				feed("\x1b");
			},
			typeName: mustNotOpen("name"),
		});

		expect(outcome.cancelled).toBe(true);
		expect(await stored()).toEqual([]);
	});
});

/**
 * The structural fix: two fields instead of one overloaded field, with the credential asked FIRST.
 *
 * Wording alone could only discourage the mistake. Asking the value in its own hidden field, then
 * the name in a visible one, makes "which question is this" answerable from the screen rather than
 * from a sentence. The order is deliberate: the credential is what the operator came to store, so
 * nothing stands in front of it, and the label is an afterthought with a generated fallback.
 */
describe("the optional name field shown after the credential", () => {
	/**
	 * LOCKS OUT both the ambiguity and a regression to the old order. Two fields are presented, the
	 * masked one FIRST, and only that one masks. If the name step is ever moved back in front, or
	 * the mask ever moves to the name field, the ambiguity that stored `GITHUB_TOKEN` as a
	 * credential is back.
	 */
	it("asks for the value first, masked, then the name, unmasked", async () => {
		const { fields } = await secretThroughRealDialog("", {
			typeValue: type("ghp_twoStepCredential11"),
			typeName: type("github token"),
		});

		expect(fields).toEqual([
			{ title: maskedPromptTitle(), masked: true },
			{ title: namePromptTitle(), masked: false },
		]);
		expect(await stored()).toEqual([{ name: "GITHUB_TOKEN", value: "ghp_twoStepCredential11" }]);
	});

	/**
	 * The name field is OPTIONAL, which is the entire premise of the feature: stashing a token has
	 * to cost one paste. An empty name keeps the generated one and the value is still stored.
	 */
	it("generates a name when the field is left empty", async () => {
		await secretThroughRealDialog("ghp_generatedNameCred22", { typeName: type("") });

		const entries = await stored();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.value).toBe("ghp_generatedNameCred22");
		expect(entries[0]?.name).toMatch(/^SECRET_\d+$/);
	});

	/**
	 * Escaping the NAME field abandons the store rather than falling back to a generated name. The
	 * operator has an unstored credential on screen and pressed escape; keeping it under a name
	 * they never saw is the one reading they did not ask for.
	 */
	it("stores nothing when the name field is cancelled", async () => {
		const { outcome } = await secretThroughRealDialog("ghp_abandonedCredential", {
			typeName: feed => feed("\x1b"),
		});

		expect(outcome.cancelled).toBe(true);
		expect(await stored()).toEqual([]);
	});

	/**
	 * An unusable name is refused, and because it is asked last the operator loses only the label:
	 * the error names the problem while the credential is still in hand to retry with. Nothing
	 * partial is written under a name the vault could not hold.
	 */
	it("refuses an unusable typed name and stores nothing", async () => {
		await expect(secretThroughRealDialog("ghp_unusableNameCred55", { typeName: type("ab") })).rejects.toThrow(
			/not a usable secret name/,
		);
		expect(await stored()).toEqual([]);
	});
});
