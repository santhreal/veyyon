import { errorMessage } from "@veyyon/utils";

const MAX_PATTERN_LENGTH = 4096;
const MAX_GROUP_DEPTH = 64;
const MAX_FLAG_LENGTH = 16;

interface PatternAnalysis {
	/** Whether this expression can succeed without consuming a character. */
	nullable: boolean;
	/** Whether this expression contains a variable-width quantifier. */
	hasVariableQuantifier: boolean;
	/** Whether this expression contains an alternation. */
	hasAlternation: boolean;
}

/**
 * Add global scanning while preserving user-provided flags.
 *
 * A sticky expression is deliberately refused rather than combined with `g`: `y` requires the
 * next match to begin exactly at `lastIndex`, so the first piece of ordinary text before a secret
 * stops the scan and leaves every later match exposed.
 */
function enforceGlobalFlag(flags: string): string {
	if (flags.includes("y")) {
		throw new Error('the sticky "y" flag is incompatible with global secret scanning');
	}
	return flags.includes("g") ? flags : `${flags}g`;
}

/**
 * Split documented `/pattern/flags` syntax without maintaining a stale allow-list of flags.
 *
 * The suffix is intentionally allowed to contain any ASCII letters here. The runtime validates it
 * below, which makes `/secret/z` an actionable typo instead of silently treating the whole literal
 * as a raw pattern that will never match `secret`.
 */
function splitRegexLiteral(pattern: string): { pattern: string; flags: string } | undefined {
	if (!pattern.startsWith("/")) return undefined;

	for (let index = pattern.length - 1; index > 0; index--) {
		if (pattern[index] !== "/") continue;
		let precedingBackslashes = 0;
		for (let cursor = index - 1; cursor >= 0 && pattern[cursor] === "\\"; cursor--) precedingBackslashes++;
		if (precedingBackslashes % 2 !== 0) continue;

		const flags = pattern.slice(index + 1);
		if (!/^[A-Za-z]*$/.test(flags)) return undefined;
		return { pattern: pattern.slice(1, index), flags };
	}
	return undefined;
}

/** Ask the active JavaScript runtime which flags it supports, while adding security semantics. */
function validateFlags(flags: string, source: string): void {
	if (flags.length > MAX_FLAG_LENGTH) {
		throw new Error(`${source} regex flags are too long to be valid`);
	}
	if (flags.includes("y")) {
		throw new Error(`the sticky "y" flag in ${source} is incompatible with global secret scanning`);
	}
	try {
		// The empty pattern isolates flag validation from pattern validation. In particular this
		// accepts newer runtime flags such as `d` and `v` without a hard-coded list going stale.
		new RegExp("", flags);
	} catch (error) {
		const message = errorMessage(error);
		throw new Error(`${source} has invalid or incompatible regex flags ${JSON.stringify(flags)} (${message})`);
	}
}

/**
 * A small, bounded structural parser for the two regex properties that matter at this boundary.
 *
 * JavaScript offers no match timeout. Running an operator-supplied expression against a probe is
 * therefore not a safety check: the check itself can hang. This parser instead walks the source
 * once, caps both source length and nesting, and conservatively refuses the high-risk structures:
 * variable quantifiers nested inside another repetition, repeated alternations, and backreferences
 * whose consumption cannot be established locally. It also computes nullability so assertions and
 * other zero-width-only patterns cannot be accepted as if they protected a value.
 */
class PatternSafetyParser {
	#index = 0;
	#depth = 0;

	constructor(
		private readonly pattern: string,
		private readonly unicodeSets: boolean,
	) {}

	parse(): PatternAnalysis {
		const analysis = this.#parseDisjunction();
		if (this.#index !== this.pattern.length) {
			throw new Error("the pattern has an unexpected closing group");
		}
		return analysis;
	}

	#parseDisjunction(): PatternAnalysis {
		const branches: PatternAnalysis[] = [this.#parseSequence()];
		while (this.pattern[this.#index] === "|") {
			this.#index++;
			branches.push(this.#parseSequence());
		}
		return {
			nullable: branches.some(branch => branch.nullable),
			hasVariableQuantifier: branches.some(branch => branch.hasVariableQuantifier),
			hasAlternation: branches.length > 1 || branches.some(branch => branch.hasAlternation),
		};
	}

	#parseSequence(): PatternAnalysis {
		let nullable = true;
		let hasVariableQuantifier = false;
		let hasAlternation = false;
		while (this.#index < this.pattern.length) {
			const current = this.pattern[this.#index];
			if (current === "|" || current === ")") break;
			const atom = this.#parseQuantifiedAtom();
			nullable &&= atom.nullable;
			hasVariableQuantifier ||= atom.hasVariableQuantifier;
			hasAlternation ||= atom.hasAlternation;
		}
		return { nullable, hasVariableQuantifier, hasAlternation };
	}

	#parseQuantifiedAtom(): PatternAnalysis {
		const atom = this.#parseAtom();
		const quantifier = this.#readQuantifier();
		if (!quantifier) return atom;
		if (atom.nullable) {
			throw new Error("a quantified part can match without consuming input");
		}

		const repeats = quantifier.maximum > 1;
		if (repeats && atom.hasVariableQuantifier) {
			throw new Error("nested variable quantifiers can cause catastrophic backtracking");
		}
		if (repeats && atom.hasAlternation) {
			throw new Error("a repeated alternation cannot be proven safe from catastrophic backtracking");
		}

		return {
			nullable: quantifier.minimum === 0,
			hasVariableQuantifier: atom.hasVariableQuantifier || quantifier.minimum !== quantifier.maximum,
			hasAlternation: atom.hasAlternation,
		};
	}

	#parseAtom(): PatternAnalysis {
		const current = this.pattern[this.#index++];
		if (current === "^" || current === "$") return ZERO_WIDTH;
		if (current === "\\") return this.#parseEscape();
		if (current === "[") {
			this.#skipCharacterClass();
			return CONSUMING;
		}
		if (current !== "(") return CONSUMING;

		if (++this.#depth > MAX_GROUP_DEPTH) {
			throw new Error(`pattern nesting exceeds the ${MAX_GROUP_DEPTH}-group safety limit`);
		}

		let assertion = false;
		if (this.pattern[this.#index] === "?") {
			this.#index++;
			const marker = this.pattern[this.#index];
			if (marker === ":" || marker === "=" || marker === "!") {
				assertion = marker !== ":";
				this.#index++;
			} else if (marker === "<") {
				this.#index++;
				const lookbehindMarker = this.pattern[this.#index];
				if (lookbehindMarker === "=" || lookbehindMarker === "!") {
					assertion = true;
					this.#index++;
				} else {
					const close = this.pattern.indexOf(">", this.#index);
					if (close === -1) throw new Error("named capture has no closing angle bracket");
					this.#index = close + 1;
				}
			} else {
				throw new Error("the pattern uses a group construct the safety validator does not support");
			}
		}

		const inner = this.#parseDisjunction();
		if (this.pattern[this.#index] !== ")") throw new Error("group has no closing parenthesis");
		this.#index++;
		this.#depth--;
		return assertion ? { ...inner, nullable: true } : inner;
	}

	#parseEscape(): PatternAnalysis {
		const escaped = this.pattern[this.#index++];
		if (escaped === "b" || escaped === "B") return ZERO_WIDTH;
		if (escaped === "k" || (escaped !== undefined && /[1-9]/.test(escaped))) {
			throw new Error("backreferences cannot be proven safe from catastrophic backtracking");
		}
		if ((escaped === "p" || escaped === "P" || escaped === "u") && this.pattern[this.#index] === "{") {
			const close = this.pattern.indexOf("}", this.#index + 1);
			if (close !== -1) this.#index = close + 1;
		}
		return CONSUMING;
	}

	#skipCharacterClass(): void {
		let nested = 1;
		while (this.#index < this.pattern.length) {
			const current = this.pattern[this.#index++];
			if (current === "\\") {
				this.#index++;
				continue;
			}
			if (this.unicodeSets && current === "[") {
				nested++;
				continue;
			}
			if (current === "]" && --nested === 0) return;
		}
		throw new Error("character class has no closing bracket");
	}

	#readQuantifier(): { minimum: number; maximum: number } | undefined {
		const current = this.pattern[this.#index];
		let minimum: number;
		let maximum: number;
		if (current === "*") {
			minimum = 0;
			maximum = Number.POSITIVE_INFINITY;
			this.#index++;
		} else if (current === "+") {
			minimum = 1;
			maximum = Number.POSITIVE_INFINITY;
			this.#index++;
		} else if (current === "?") {
			minimum = 0;
			maximum = 1;
			this.#index++;
		} else {
			const match = /^\{(\d+)(?:,(\d*))?\}/.exec(this.pattern.slice(this.#index));
			if (!match) return undefined;
			minimum = Number(match[1]);
			maximum = match[2] === undefined ? minimum : match[2] === "" ? Number.POSITIVE_INFINITY : Number(match[2]);
			this.#index += match[0].length;
		}
		// A trailing question mark changes greediness, not the language or its safety analysis.
		if (this.pattern[this.#index] === "?") this.#index++;
		return { minimum, maximum };
	}
}

const ZERO_WIDTH: PatternAnalysis = {
	nullable: true,
	hasVariableQuantifier: false,
	hasAlternation: false,
};

const CONSUMING: PatternAnalysis = {
	nullable: false,
	hasVariableQuantifier: false,
	hasAlternation: false,
};

function validatePatternSafety(pattern: string, flags: string): void {
	if (pattern.length > MAX_PATTERN_LENGTH) {
		throw new Error(`pattern exceeds the ${MAX_PATTERN_LENGTH}-character bounded safety limit`);
	}
	const analysis = new PatternSafetyParser(pattern, flags.includes("v")).parse();
	if (analysis.nullable) {
		throw new Error("the pattern can match without consuming input; a zero-width match protects no secret value");
	}
}

/** Compile a secret regex entry with global scanning enabled and unsafe semantics refused. */
export function compileSecretRegex(pattern: string, flags?: string): RegExp {
	const literal = splitRegexLiteral(pattern);
	const resolvedPattern = literal?.pattern ?? pattern;
	const explicitFlags = flags ?? "";
	const literalFlags = literal?.flags ?? "";

	validateFlags(explicitFlags, 'the explicit "flags" field');
	validateFlags(literalFlags, "the regex literal");

	// Each source is validated before de-duplication so `/secret/ii` remains an error, while a
	// deliberate `g` in both supported flag locations is harmless.
	const mergedFlags = [...new Set([...explicitFlags, ...literalFlags])].join("");
	const resolvedFlags = enforceGlobalFlag(mergedFlags);
	validatePatternSafety(resolvedPattern, resolvedFlags);
	let compiled: RegExp;
	try {
		compiled = new RegExp(resolvedPattern, resolvedFlags);
	} catch (error) {
		const message = errorMessage(error);
		throw new Error(`invalid regex pattern or flag combination (${message})`);
	}
	return compiled;
}
