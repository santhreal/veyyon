/**
 * The state machine behind storing a NEW credential from inside the Secret Manager card.
 *
 * The card could list, rename, extend and revoke credentials, and could not store one. An
 * operator who wanted a new secret had to close the card and type `/secret add`, which teaches
 * people that the card is not the real surface. This holds the questions adding takes, in the order
 * that keeps the answers honest, and hands the container a plan for `vault.add`.
 *
 * IT NEVER TOUCHES THE VAULT, the audit log, or the filesystem. It collects, refuses, and
 * yields a plan; the container performs the mutation. That separation is what lets the flow be
 * tested for exact prompts and exact refusals with no key, no temp directory, and no bytes
 * written anywhere.
 *
 * IT ALSO NEVER RENDERS THE VALUE. The credential is held in private state and leaves through
 * exactly one door, {@link SecretAddFlow.plan}. No title, hint, refusal, or other accessor
 * carries it, so a future prompt cannot accidentally paint a live credential onto the screen.
 */
import { errorMessage } from "@veyyon/utils";
import { canObfuscatePlainValue, MIN_OBFUSCATABLE_LENGTH } from "../../secrets/policy";
import { normaliseSecretName, VAULT_SCOPES, type VaultScope } from "../../secrets/vault";
import type { AddFlowState, AddFlowStep } from "./secret-manager-types";

/**
 * Where a new credential lands when the operator does not choose.
 *
 * The profile vault is the one that follows the operator between projects without being visible
 * to every project at once, so it is the answer that surprises the fewest people.
 */
export const DEFAULT_ADD_SCOPE: VaultScope = "profile";

/** The scopes named in prose, derived from {@link VAULT_SCOPES} so a hint cannot drift from reality. */
const SCOPE_LIST = VAULT_SCOPES.join(", ");

/**
 * Why an empty credential is refused rather than stored.
 *
 * Exported so the container and its tests can name the exact sentence the operator sees instead
 * of matching a fragment of it.
 */
export const EMPTY_VALUE_REFUSAL =
	"Enter the credential itself. An empty secret would store nothing and expand to nothing, so it is never what you meant.";

/**
 * Why a credential the obfuscator could not protect is refused at the field that holds it.
 *
 * THE VAULT ALREADY REFUSES THIS, and that was the problem. The refusal arrived from `vault.add`
 * after all three questions had been answered, by which point the container has torn the flow
 * down: the operator was returned to the roster having lost the credential, the name and the
 * scope, and had to retype all three to be told the same thing. The value step is where the rule
 * can still be acted on, so it is enforced here, exactly as the name step already runs the
 * vault's own normaliser rather than letting a bad name reach the write.
 *
 * The rule itself is not restated: {@link canObfuscatePlainValue} decides, and the threshold is
 * read from {@link MIN_OBFUSCATABLE_LENGTH}, so a change to the policy cannot leave this field
 * accepting values the vault will reject.
 */
export const SHORT_VALUE_REFUSAL =
	`A credential has to be at least ${MIN_OBFUSCATABLE_LENGTH} characters. Anything shorter cannot be swapped ` +
	`for a placeholder without cutting into ordinary words, so the vault will not store it.`;

/**
 * Why a scope the vault does not have is refused.
 *
 * The offending input is deliberately not echoed. It is arbitrary typed text, and a refusal is
 * not worth the escaping question.
 */
export const UNKNOWN_SCOPE_REFUSAL = `That is not a scope a vault has. Choose ${SCOPE_LIST}.`;

/** Why a blank answer at the environment step is refused: there is no variable to read. */
export const EMPTY_ENV_NAME_REFUSAL =
	"Name the environment variable to read the credential out of, such as GITHUB_TOKEN.";

/**
 * Why a variable that is not in the environment is refused.
 *
 * The NAME is echoed, unlike every other refusal in this file, and the difference is deliberate: a
 * variable name is not a credential, it is the one thing the operator typed that they can see, and
 * a refusal that hides it cannot be told apart from a typo in it. This is also why the field is
 * unmasked.
 */
export function missingEnvRefusal(variable: string): string {
	return (
		`${variable} is not set in this process's environment, so there is nothing to read. veyyon sees the ` +
		`environment it was launched with, so a variable exported in your shell afterwards is not visible here.`
	);
}

/** Why a variable that exists but holds nothing usable is refused, named so the two cannot be confused. */
export function emptyEnvRefusal(variable: string): string {
	return `${variable} is set but holds nothing, so there is no credential in it to store.`;
}

/**
 * One question the flow is asking, in the form a prompt needs in order to draw it.
 *
 * Grouped into a single value so the container reads one object per step rather than three
 * getters it could pair up wrongly, and so the masking decision travels beside the field it
 * applies to instead of being recomputed at the show site.
 */
export interface AddFlowField {
	readonly step: AddFlowStep;
	readonly title: string;
	readonly hint: string;
	/**
	 * True only for the credential itself.
	 *
	 * Masking the name would hide a typo in a label that has to be read back later, and a masked
	 * field asking for a name is the exact illusion that made `/secret add` store `GITHUB_TOKEN`
	 * as a live credential.
	 */
	readonly masked: boolean;
}

/**
 * What the container hands to `vault.add` once every question is answered.
 *
 * The only place the collected value is readable. Kept separate from {@link AddFlowState} so
 * the "generate a name for me" answer arrives as `undefined` rather than as an empty string the
 * caller has to remember to interpret.
 */
export interface AddFlowPlan {
	/** `undefined` when the name field was left blank, which asks the vault to invent one. */
	readonly name: string | undefined;
	readonly value: string;
	readonly scope: VaultScope;
	/**
	 * The environment variable the credential was read out of, when it was.
	 *
	 * Safe to render, and the confirmation does: an operator who names the wrong variable has stored
	 * the wrong credential, and the only moment that is cheap to notice is the moment it is stored.
	 */
	readonly fromEnv?: string;
}

/**
 * The question asked at each step, written once.
 *
 * A table rather than a switch because these are data, and because the value step's wording is
 * the load-bearing part of this module: it has to read as a request for a credential, so that a
 * masked field can never be mistaken for a request for a name.
 */
const FIELDS: Readonly<Record<Exclude<AddFlowStep, "done">, AddFlowField>> = {
	value: {
		step: "value",
		title: "New secret: paste the value",
		hint: "The credential itself, such as the token or the password. It stays masked, and the manager never shows it again.",
		masked: true,
	},
	env: {
		step: "env",
		title: "New secret: name the environment variable",
		hint: "The variable's NAME, not its value: veyyon reads the credential out of its own environment, so nothing secret is typed or drawn. This field is not masked, because a variable name is not a credential.",
		masked: false,
	},
	name: {
		step: "name",
		title: "New secret: name it",
		hint: "Letters, digits, spaces, dashes and underscores. Leave it blank to have a name generated for you.",
		masked: false,
	},
	scope: {
		step: "scope",
		title: "New secret: choose a scope",
		hint: `Who can see it: ${SCOPE_LIST}. Leave it blank to keep ${DEFAULT_ADD_SCOPE}.`,
		masked: false,
	},
};

/**
 * Where the credential itself comes from, enumerable at run time.
 *
 * A list rather than a bare union so a suite can drive EVERY source instead of the one whoever
 * wrote the test had in mind. Adding a third source here without giving it a first step below fails
 * to compile, and without giving it a row in the flow's own suite fails that suite.
 */
export const ADD_FLOW_SOURCES = ["paste", "env"] as const;

/** One of {@link ADD_FLOW_SOURCES}. */
export type AddFlowSource = (typeof ADD_FLOW_SOURCES)[number];

/**
 * The question each source opens at.
 *
 * Exhaustive over {@link AddFlowSource} on purpose: a source with no first step is a flow that opens
 * on a field nobody chose, and this is the cheapest place for that to be a compile error.
 */
const FIRST_STEP: Readonly<Record<AddFlowSource, "value" | "env">> = {
	paste: "value",
	env: "env",
};

/**
 * Ask for a credential, then a name, then a scope, and produce a plan.
 *
 * VALUE FIRST is the whole point of the ordering, not a preference. Asking the name first puts a
 * masked field on screen before any credential has been given, and a masked field reads as
 * "type the secret". That is how `/secret add` came to hold an entry whose value was the literal
 * string `GITHUB_TOKEN`: the operator answered the question the field appeared to be asking.
 *
 * TWO SOURCES FOR THAT FIRST ANSWER. `paste` opens the masked field; `env` names a variable and the
 * credential is read out of the environment, which is the only entry form where the value never
 * reaches the screen or the input buffer at all. `/secret --from-env VAR` has always offered that on
 * the command line, and the manager could not, so the safest path was the one the GUI lacked.
 */
export class SecretAddFlow {
	#state: AddFlowState;

	/**
	 * How the environment is read, injected so a test can drive the env source without mutating the
	 * process. Defaults to the real environment, which is the only thing production wants.
	 */
	readonly #readEnv: (variable: string) => string | undefined;

	/** The step this flow opened at, which is where a back out of the name question returns to. */
	readonly #firstStep: "value" | "env";

	constructor(options: { source?: AddFlowSource; readEnv?: (variable: string) => string | undefined } = {}) {
		this.#firstStep = FIRST_STEP[options.source ?? "paste"];
		this.#state = {
			step: this.#firstStep,
			value: "",
			name: "",
			scope: DEFAULT_ADD_SCOPE,
		};
		this.#readEnv = options.readEnv ?? (variable => process.env[variable]);
	}

	#refusal: string | null = null;

	/** Which question is being asked. `done` means {@link plan} is ready to store. */
	get step(): AddFlowStep {
		return this.#state.step;
	}

	/** The question to draw, or `undefined` at `done`, where there is nothing left to ask. */
	get field(): AddFlowField | undefined {
		const { step } = this.#state;
		return step === "done" ? undefined : FIELDS[step];
	}

	/**
	 * Why the last answer was not accepted, or `null` when nothing is being refused.
	 *
	 * Held on the flow rather than returned from {@link submit} so a re-render after the keystroke
	 * still shows the reason, instead of the reason living for one frame in the caller's hands.
	 */
	get refusal(): string | null {
		return this.#refusal;
	}

	/** The scopes the scope step offers, in the vault's own widest-first order. */
	get scopeChoices(): readonly VaultScope[] {
		return VAULT_SCOPES;
	}

	/** The scope currently chosen, so the scope step can show which entry is already selected. */
	get scope(): VaultScope {
		return this.#state.scope;
	}

	/**
	 * The finished plan, or `undefined` before the last question is answered.
	 *
	 * The single exit for the collected credential. Everything else this class exposes is safe to
	 * print; this is not.
	 */
	get plan(): AddFlowPlan | undefined {
		const { step, name, value, scope, fromEnv } = this.#state;
		if (step !== "done") return undefined;
		return { name: name === "" ? undefined : name, value, scope, ...(fromEnv === undefined ? {} : { fromEnv }) };
	}

	/**
	 * Answer the current question and advance, or record a refusal and stay put.
	 *
	 * One entry point for every field because the container has one prompt: it does not need to know
	 * which question it is showing in order to hand over what was typed.
	 */
	submit(input: string): void {
		switch (this.#state.step) {
			case "value":
				this.#submitValue(input);
				return;
			case "env":
				this.#submitEnv(input);
				return;
			case "name":
				this.#submitName(input);
				return;
			case "scope":
				this.#submitScope(input);
				return;
			case "done":
				// Nothing is being asked, so there is nothing to answer. Ignoring the input keeps a
				// stray keystroke arriving after the last step from rewriting a finished plan.
				return;
		}
	}

	/**
	 * Return to the previous question, clearing any refusal on the way.
	 *
	 * Stepping back from `done` is allowed and returns to the scope step, so an operator who reads
	 * the summary and changes their mind can amend the entry rather than store the wrong one and
	 * then fix it.
	 *
	 * A back out of `name` returns to whichever FIRST step this flow started at, so an operator who
	 * named the wrong variable is asked for the variable again rather than handed a masked field they
	 * never chose.
	 */
	back(): void {
		this.#refusal = null;
		switch (this.#state.step) {
			case "value":
			case "env":
				// The first question has nothing behind it. The container reads a back at this step as
				// cancel and closes the flow, so this changes nothing rather than quietly discarding
				// the answer under it.
				return;
			case "name":
				this.#state.step = this.#firstStep;
				return;
			case "scope":
				this.#state.step = "name";
				return;
			case "done":
				this.#state.step = "scope";
				return;
		}
	}

	/**
	 * Read the credential out of the environment, refusing every way that can fail to produce one.
	 *
	 * The value is measured by the same guard the pasted path uses, because a variable holding three
	 * characters is refused by the vault for the same reason a typed one is, and finding that out at
	 * the write would be a refusal two questions after the mistake.
	 */
	#submitEnv(input: string): void {
		const variable = input.trim();
		if (variable.length === 0) {
			this.#refusal = EMPTY_ENV_NAME_REFUSAL;
			return;
		}
		const value = this.#readEnv(variable);
		if (value === undefined) {
			this.#refusal = missingEnvRefusal(variable);
			return;
		}
		if (value.trim().length === 0) {
			this.#refusal = emptyEnvRefusal(variable);
			return;
		}
		if (!canObfuscatePlainValue(value)) {
			this.#refusal = SHORT_VALUE_REFUSAL;
			return;
		}
		// Verbatim, exactly as the pasted path keeps it: a credential may legitimately end in a
		// newline the exporting tool left there, and a trimmed copy authenticates against nothing.
		this.#state.value = value;
		this.#state.fromEnv = variable;
		this.#state.step = "name";
		this.#refusal = null;
	}

	#submitValue(input: string): void {
		if (input.trim().length === 0) {
			this.#refusal = EMPTY_VALUE_REFUSAL;
			return;
		}
		// Measured on the UNTRIMMED input, because that is the string the vault will measure. The
		// emptiness test above trims and this one must not, or a value of eight spaces and one
		// character would pass here and be refused by the write.
		if (!canObfuscatePlainValue(input)) {
			this.#refusal = SHORT_VALUE_REFUSAL;
			return;
		}
		// Kept exactly as typed. A credential can legitimately begin or end in whitespace, and a
		// trimmed one would be stored, expanded, and rejected by whatever it authenticates against,
		// which is a failure the operator has no way to see from here. Only the emptiness test
		// trims, because whitespace alone is never a credential.
		this.#state.value = input;
		this.#state.step = "name";
		this.#refusal = null;
	}

	#submitName(input: string): void {
		if (input.trim().length === 0) {
			// Blank is an answer rather than a mistake: it asks for a generated name, which the vault
			// does at store time, once it can see which names are already taken.
			this.#state.name = "";
			this.#state.step = "scope";
			this.#refusal = null;
			return;
		}
		let normalised: string;
		try {
			// The vault's own normaliser, so a name accepted here cannot be rejected at store time.
			// Validating identically in a second place would be a rule with two definitions, and only
			// one of them would get updated.
			normalised = normaliseSecretName(input);
		} catch (error) {
			// It throws the sentence that spells out the rule. Surface that rather than inventing a
			// second wording, which could describe a rule the vault no longer enforces.
			this.#refusal = errorMessage(error);
			return;
		}
		this.#state.name = normalised;
		this.#state.step = "scope";
		this.#refusal = null;
	}

	#submitScope(input: string): void {
		const wanted = input.trim().toLowerCase();
		if (wanted.length === 0) {
			// Blank keeps whatever is already selected, which starts at DEFAULT_ADD_SCOPE.
			this.#state.step = "done";
			this.#refusal = null;
			return;
		}
		const chosen = VAULT_SCOPES.find(scope => scope === wanted);
		if (chosen === undefined) {
			this.#refusal = UNKNOWN_SCOPE_REFUSAL;
			return;
		}
		this.#state.scope = chosen;
		this.#state.step = "done";
		this.#refusal = null;
	}
}
