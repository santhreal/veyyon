/**
 * What a failure family is, and what a stage may do about one.
 *
 * A provider failure used to be handled twice: classified in one file and then re-decided at each
 * of the thirteen retry loops, each of which re-derived from prose whether the thing it caught was
 * worth another attempt. The two halves disagreed — a Devin empty body classified transient while
 * the provider predicate refused it, a dead Kimi grant was retried forever because its prose
 * carried no code — and every disagreement was fixed at one call site, which is why there were
 * thirteen of them.
 *
 * The shape here says both halves once. A domain owns one failure family: the rules that recognise
 * it and, for each stage that can act, what that stage does about it. `registry.ts` is the only
 * place the domains are assembled, so the answer to "what happens when a provider returns this" is
 * one array read in declaration order rather than a search of the call sites.
 */
import type { Api } from "../../types";
import type { Flag } from "../flag";

/**
 * Everything a rule may read about one failure, computed once.
 *
 * `text` is the message with stack frames stripped, because callers arrive with `String(error)` and
 * this codebase's errors embed their cause chain AND their stack: a frame named
 * `…/scoped-timeout.ts` contains the word "timeout", and matching failure keywords against frame
 * names classified a dead credential as transient and retried it to exhaustion. `status` is parsed
 * from the RAW message instead, since a frame name cannot introduce an HTTP status token but can
 * easily introduce a keyword. `http2` is the RFC 7540 §7 verdict, `undefined` when the message names
 * no HTTP/2 error code.
 *
 * `code` is the machine-readable error code the provider sent, from `error.code` or the SDK's nested
 * `error.error.code`, and it exists because reading one from wording alone splits a rule in two. The
 * Copilot routing flap arrived both ways — `model_not_supported` in the body text and in a `code`
 * field — and the text spelling was a classification rule while the field was a separate exported
 * predicate the Copilot ladder called. One failure, two homes, two answers: a 400 whose message was
 * `x` and whose code said `model_not_supported` was retried by the ladder and refused by everything
 * that reads flags.
 */
export interface Signal {
	readonly text: string;
	readonly status: number | undefined;
	readonly api: Api | undefined;
	readonly http2: boolean | undefined;
	readonly code: string | undefined;
}

/**
 * One classification rule: the flags it sets, and the condition that sets them.
 *
 * A rule is SELF-CONTAINED. Its condition states every fact it depends on, including the facts that
 * used to be expressed as position in an if-chain, so the rules can be applied in any order and a
 * reader can decide one rule without holding the other twenty in mind. That is why this is a table:
 * the file it replaced classified by prose in a chain whose branches were the history of what had
 * broken, and adding a rule meant guessing where in the chain it belonged.
 *
 * `structural` reads status, api or transport verdict — facts a provider states rather than writes.
 * `text` reads the message. A rule with a `text` condition and no `structural` one decides on prose
 * alone, which is a last resort: it is the shape that reclassifies itself when a provider rewords a
 * sentence, so the set of such rules is pinned by a test and each states its reason in `why`.
 */
export interface ClassificationRule {
	readonly flags: number;
	/**
	 * What a diagnostic calls this rule, unique across the registry.
	 *
	 * A misclassified failure used to be diagnosed by re-running thirty patterns by hand against the
	 * provider's sentence, because the id states what a failure IS and nothing states which rule said
	 * so. `explain` returns these names, and the sweep pins the whole inventory by exact equality, so
	 * a new rule is a decision someone records rather than one more condition in the pile.
	 */
	readonly name: string;
	/** The failure this rule was added for, and why prose decides it when it does. */
	readonly why: string;
	readonly structural?: (signal: Signal) => boolean;
	readonly text?: (text: string) => boolean;
}

/**
 * One classification rule keyed on the error's IDENTITY rather than its wording.
 *
 * An error that states its own kind in its type is the strongest signal there is, and it is not
 * spoofable by a provider rewording a sentence. These are applied first-match-wins over the cause
 * chain, in registry order, because that is what the `else if` chain they replaced did.
 */
export interface ClassRule {
	/** What a diagnostic calls this rule, unique across the registry. See {@link ClassificationRule.name}. */
	readonly name: string;
	readonly why: string;
	readonly matches: (link: unknown) => boolean;
	readonly flags: (link: unknown) => number;
}

/** A capability a request can be re-sent without, when the provider rejected the request for having it. */
export type DegradedCapability = "strict-tools" | "fast-mode" | "server-side-items";

/**
 * What to do about a classified failure.
 *
 * Deliberately small. Every action here is one some layer of this codebase already performs; a
 * ninth action means a new capability was built, not that a provider said something new.
 */
export type Recovery =
	/** Attempt the same request again. The delay is the loop's business: a server hint if one arrived, its own backoff otherwise. */
	| { readonly action: "retry" }
	/** The credential is exhausted rather than the request being wrong: present a sibling account. */
	| { readonly action: "rotate-credential" }
	/** The credential is stale rather than dead: refresh the grant and present it again. */
	| { readonly action: "reauth" }
	/** The request was too big for the window: reduce the context, then send it again. */
	| { readonly action: "compact" }
	/** This model will fail the same way on the same context: send the turn to another one. */
	| { readonly action: "switch-model" }
	/** The request named something the endpoint does not have: send it again without that. */
	| { readonly action: "degrade"; readonly capability: DegradedCapability }
	/** Nothing here recovers it. Report it to the operator with the reason. */
	| { readonly action: "surface" }
	/** The turn ended because somebody asked it to. Not a fault, and never retried. */
	| { readonly action: "abort" };

/**
 * The layers that can act on a failure, from the narrowest to the widest.
 *
 * The same failure means different work at each: a usage limit is a credential to rotate at the
 * gateway and a turn to re-send at the session, and a transport reset is a request to repeat at the
 * socket and nothing at all above it. Naming the stage is what lets one table serve all three
 * without a stage having to guess which of the others already tried.
 */
export type RecoveryStage =
	/** One HTTP request or one stream: it can repeat itself and nothing else. */
	| "transport"
	/** The credential presented with the request: it can rotate, refresh or disable one. */
	| "credential"
	/** The whole turn: it can compact, degrade a capability, switch model, or re-send. */
	| "turn";

/** What each stage does about a failure of this family. */
export type StageRecovery = Readonly<Record<RecoveryStage, Recovery>>;

/**
 * One failure family: how it is recognised, and what each stage does about it.
 *
 * `recovers` is the set of flags whose recovery THIS domain decides, and the registry asserts the
 * sets are disjoint and cover every flag. A domain may recover nothing and still carry rules — a
 * provider that states a status and a code classifies into three families at once, so the rule that
 * reads it cannot live in any one of them — and the empty set is pinned by name in the test rather
 * than allowed by default.
 */
export interface ErrorDomain {
	/** Stable id, used in diagnostics and in the ownership assertions. */
	readonly id: string;
	/** What holds this family together, in one sentence. */
	readonly why: string;
	/** The flags whose recovery this domain decides. */
	readonly recovers: readonly Flag[];
	/** Required when `recovers` is non-empty, absent when it is empty. */
	readonly recovery?: StageRecovery;
	/** Identity rules, applied first-match-wins over the cause chain. */
	readonly classes?: readonly ClassRule[];
	/** Signal rules, all applied, order-independent. */
	readonly rules?: readonly ClassificationRule[];
	/**
	 * Whether a turn-stage retry of this family is safe when the failed turn already emitted a tool
	 * call. Absent means no: a transport fault says the next attempt could differ, never that
	 * repeating the turn is safe.
	 */
	readonly replaySafe?: true;
	/**
	 * Whether this family refuses a retry for the whole failure however the rest of it classified.
	 * A content filter is a verdict on the request, not a fault.
	 */
	readonly vetoesRetry?: true;
}
