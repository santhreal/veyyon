/**
 * The state machine behind storing a NEW credential from inside the Secret Manager card.
 *
 * ONE QUESTION, then the credential is stored: what is the value, or which environment variable
 * holds it. The vault invents the name and {@link DEFAULT_ADD_SCOPE} takes the scope, because both
 * are labels on an entry that has to exist before they mean anything, and both are one keystroke
 * away on the row (`n` renames, `m` moves). Asking for them here cost three full-screen prompts per
 * credential, and one of them was a masked field asking for a name, which is exactly the illusion
 * that once stored the literal string `GITHUB_TOKEN` as a live credential.
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
import { canObfuscatePlainValue, MIN_OBFUSCATABLE_LENGTH } from "../../secrets/policy";
import type { VaultScope } from "../../secrets/vault";
import type { AddFlowState, AddFlowStep } from "./secret-manager-types";

/**
 * Where a new credential lands when the operator does not choose.
 *
 * The profile vault is the one that follows the operator between projects without being visible
 * to every project at once, so it is the answer that surprises the fewest people.
 */
export const DEFAULT_ADD_SCOPE: VaultScope = "profile";

/**
 * Why an empty credential is refused rather than stored.
 *
 * Exported so the container and its tests can name the exact sentence the operator sees instead
 * of matching a fragment of it.
 */
export const EMPTY_VALUE_REFUSAL = "Enter the credential itself: an empty secret expands to nothing.";

/**
 * Why a credential the obfuscator could not protect is refused at the field that holds it.
 *
 * THE VAULT ALREADY REFUSES THIS, and that was the problem. The refusal arrived from `vault.add`,
 * by which point the container has torn the flow down: the operator was returned to the roster
 * having lost the credential and had to retype it to be told the same thing. The value step is
 * where the rule can still be acted on, so it is enforced here.
 *
 * The rule itself is not restated: {@link canObfuscatePlainValue} decides, and the threshold is
 * read from {@link MIN_OBFUSCATABLE_LENGTH}, so a change to the policy cannot leave this field
 * accepting values the vault will reject.
 */
export const SHORT_VALUE_REFUSAL = `A credential has to be at least ${MIN_OBFUSCATABLE_LENGTH} characters to be masked at all.`;

/** Why a blank answer at the environment step is refused: there is no variable to read. */
export const EMPTY_ENV_NAME_REFUSAL = "Name the variable to read the credential out of, like GITHUB_TOKEN.";

/**
 * Why a variable that is not in the environment is refused.
 *
 * The NAME is echoed, unlike every other refusal in this file, and the difference is deliberate: a
 * variable name is not a credential, it is the one thing the operator typed that they can see, and
 * a refusal that hides it cannot be told apart from a typo in it. This is also why the field is
 * unmasked.
 */
export function missingEnvRefusal(variable: string): string {
	return `${variable} is not set in the environment veyyon was launched with.`;
}

/** Why a variable that exists but holds nothing usable is refused, named so the two cannot be confused. */
export function emptyEnvRefusal(variable: string): string {
	return `${variable} is set but holds nothing.`;
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
	 * A variable NAME is not a credential, so masking one would hide a typo in something that has to
	 * be read back, and a masked field asking for anything other than the value is the illusion that
	 * made `/secret add` store the literal string `GITHUB_TOKEN` as a live credential.
	 */
	readonly masked: boolean;
}

/**
 * What the container hands to `vault.add` once every question is answered.
 *
 * The only place the collected value is readable. It carries the value and, when there was one, the
 * variable it was read out of. There is nothing else to hand over: the name and the scope are no
 * longer questions, so the container stores at {@link DEFAULT_ADD_SCOPE} under a generated name.
 */
export interface AddFlowPlan {
	readonly value: string;
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
		hint: "The token or password itself. Masked, and stored at once.",
		masked: true,
	},
	env: {
		step: "env",
		title: "New secret: name the environment variable",
		hint: "The variable's NAME, not its value. Nothing secret is typed here.",
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
 * Ask for a credential and produce a plan. One question, one answer, stored.
 *
 * THE VALUE IS THE ONLY THING ASKED. A name and a scope describe an entry that has to exist
 * before either means anything, the row that appears carries `n` to rename and `m` to move, and
 * asking for them here turned one credential into three full-screen prompts. The middle one was a
 * masked field asking for a name, which is how `/secret add` came to hold an entry whose value was
 * the literal string `GITHUB_TOKEN`: the operator answered the question the field appeared to ask.
 * With the question gone, that mistake is no longer expressible.
 *
 * TWO SOURCES FOR THAT ONE ANSWER. `paste` opens the masked field; `env` names a variable and the
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

	constructor(options: { source?: AddFlowSource; readEnv?: (variable: string) => string | undefined } = {}) {
		this.#state = { step: FIRST_STEP[options.source ?? "paste"], value: "" };
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

	/**
	 * The finished plan, or `undefined` before the question is answered.
	 *
	 * The single exit for the collected credential. Everything else this class exposes is safe to
	 * print; this is not.
	 */
	get plan(): AddFlowPlan | undefined {
		const { step, value, fromEnv } = this.#state;
		if (step !== "done") return undefined;
		return { value, ...(fromEnv === undefined ? {} : { fromEnv }) };
	}

	/**
	 * Answer the question and finish, or record a refusal and stay put.
	 *
	 * One entry point for both sources because the container has one prompt: it does not need to know
	 * which of the two it is showing in order to hand over what was typed.
	 */
	submit(input: string): void {
		switch (this.#state.step) {
			case "value":
				this.#submitValue(input);
				return;
			case "env":
				this.#submitEnv(input);
				return;
			case "done":
				// Nothing is being asked, so there is nothing to answer. Ignoring the input keeps a
				// stray keystroke arriving after the answer from rewriting a finished plan.
				return;
		}
	}

	/**
	 * Clear any refusal. There is no earlier question to return to.
	 *
	 * Kept as a method because the container calls it on escape at a field, and reading a back at the
	 * only question as cancel is the container's decision, not this class's. Once the answer is in,
	 * the credential is already stored: there is no `done` state to walk back out of.
	 */
	back(): void {
		this.#refusal = null;
	}

	/**
	 * Read the credential out of the environment, refusing every way that can fail to produce one.
	 *
	 * The value is measured by the same guard the pasted path uses, because a variable holding three
	 * characters is refused by the vault for the same reason a typed one is, and finding that out at
	 * the write would be a refusal after the flow had already been torn down.
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
		this.#state.step = "done";
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
		this.#state.step = "done";
		this.#refusal = null;
	}
}
