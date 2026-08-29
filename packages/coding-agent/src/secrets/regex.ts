import { errorMessage } from "@veyyon/utils/type-guards";
import type { PatternAnalysis } from "./regex-helpers";
import {
	enforceGlobalFlag,
	MAX_GROUP_DEPTH,
	MAX_PATTERN_LENGTH,
	splitRegexLiteral,
	validateFlags,
} from "./regex-helpers";

class PatternSafetyParser {
	#index = 0;
	#depth = 0;

	constructor(
		private readonly pattern: string,
		private readonly unicodeSets: boolean,
		private readonly ignoreCase: boolean,
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
		const first = branches[0];
		const branchWidthsDiffer = branches.some(
			branch => branch.minimumWidth !== first.minimumWidth || branch.maximumWidth !== first.maximumWidth,
		);
		const hasVariableWidthBranch = branches.some(branch => branch.minimumWidth !== branch.maximumWidth);
		const currentVariableWidthAlternation =
			branches.length > 1 && (branchWidthsDiffer || hasVariableWidthBranch) ? 1 : 0;
		return {
			nullable: branches.some(branch => branch.nullable),
			minimumWidth: Math.min(...branches.map(branch => branch.minimumWidth)),
			maximumWidth: Math.max(...branches.map(branch => branch.maximumWidth)),
			variableWidthAlternations:
				currentVariableWidthAlternation + Math.max(...branches.map(branch => branch.variableWidthAlternations)),
			hasVariableQuantifier: branches.some(branch => branch.hasVariableQuantifier),
			hasAlternation: branches.length > 1 || branches.some(branch => branch.hasAlternation),
			startsWithVariableAtom: mergeBoundaryAtoms(branches.map(branch => branch.startsWithVariableAtom)),
			endsWithVariableAtom: mergeBoundaryAtoms(branches.map(branch => branch.endsWithVariableAtom)),
		};
	}

	#parseSequence(): PatternAnalysis {
		let nullable = true;
		let minimumWidth = 0;
		let maximumWidth = 0;
		let variableWidthAlternations = 0;
		let hasVariableQuantifier = false;
		let hasAlternation = false;
		let startsWithVariableAtom: string | undefined;
		let endsWithVariableAtom: string | undefined;
		let hasConsumingAtom = false;
		while (this.#index < this.pattern.length) {
			const current = this.pattern[this.#index];
			if (current === "|" || current === ")") break;
			const atom = this.#parseQuantifiedAtom();
			if (
				hasConsumingAtom &&
				endsWithVariableAtom !== undefined &&
				atom.startsWithVariableAtom !== undefined &&
				variableAtomsMayOverlap(endsWithVariableAtom, atom.startsWithVariableAtom, this.ignoreCase)
			) {
				throw new Error("concatenated variable quantifiers cannot be proven safe from catastrophic backtracking");
			}
			nullable &&= atom.nullable;
			minimumWidth += atom.minimumWidth;
			maximumWidth += atom.maximumWidth;
			variableWidthAlternations += atom.variableWidthAlternations;
			hasVariableQuantifier ||= atom.hasVariableQuantifier;
			hasAlternation ||= atom.hasAlternation;
			if (atom.maximumWidth > 0) {
				if (!hasConsumingAtom) startsWithVariableAtom = atom.startsWithVariableAtom;
				endsWithVariableAtom = atom.endsWithVariableAtom;
				hasConsumingAtom = true;
			}
		}
		return {
			nullable,
			minimumWidth,
			maximumWidth,
			variableWidthAlternations,
			hasVariableQuantifier,
			hasAlternation,
			startsWithVariableAtom,
			endsWithVariableAtom,
		};
	}

	#parseQuantifiedAtom(): PatternAnalysis {
		const atomStart = this.#index;
		const atom = this.#parseAtom();
		const atomSource = this.pattern.slice(atomStart, this.#index);
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

		const variable = quantifier.minimum !== quantifier.maximum;
		return {
			nullable: quantifier.minimum === 0,
			minimumWidth: multiplyWidth(atom.minimumWidth, quantifier.minimum),
			maximumWidth: multiplyWidth(atom.maximumWidth, quantifier.maximum),
			variableWidthAlternations: atom.variableWidthAlternations,
			hasVariableQuantifier: atom.hasVariableQuantifier || variable,
			hasAlternation: atom.hasAlternation,
			startsWithVariableAtom: variable ? atomSource : atom.startsWithVariableAtom,
			endsWithVariableAtom: variable ? atomSource : atom.endsWithVariableAtom,
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
		return assertion
			? {
					...inner,
					nullable: true,
					minimumWidth: 0,
					maximumWidth: 0,
					startsWithVariableAtom: undefined,
					endsWithVariableAtom: undefined,
				}
			: inner;
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
				const escaped = this.pattern[this.#index++];
				if (this.unicodeSets && escaped === "q" && this.pattern[this.#index] === "{") {
					throw new Error("Unicode-set string atoms cannot be proven safe from catastrophic backtracking");
				}
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
		if (this.pattern[this.#index] === "?") this.#index++;
		return { minimum, maximum };
	}
}

function multiplyWidth(width: number, repetitions: number): number {
	if (width === 0 || repetitions === 0) return 0;
	if (!Number.isFinite(width) || !Number.isFinite(repetitions)) return Number.POSITIVE_INFINITY;
	return width * repetitions;
}

const ZERO_WIDTH: PatternAnalysis = {
	nullable: true,
	minimumWidth: 0,
	maximumWidth: 0,
	variableWidthAlternations: 0,
	hasVariableQuantifier: false,
	hasAlternation: false,
	startsWithVariableAtom: undefined,
	endsWithVariableAtom: undefined,
};

const CONSUMING: PatternAnalysis = {
	nullable: false,
	minimumWidth: 1,
	maximumWidth: 1,
	variableWidthAlternations: 0,
	hasVariableQuantifier: false,
	hasAlternation: false,
	startsWithVariableAtom: undefined,
	endsWithVariableAtom: undefined,
};

function mergeBoundaryAtoms(atoms: Array<string | undefined>): string | undefined {
	const present = atoms.filter((atom): atom is string => atom !== undefined);
	if (present.length === 0) return undefined;
	return present.every(atom => atom === present[0]) ? present[0] : "*";
}

interface SimpleAtomDomain {
	kind: "literal" | "class";
	value: string;
	inverted: boolean;
}

function simpleAtomDomain(atom: string): SimpleAtomDomain | undefined {
	if (atom.length === 1 && atom !== ".") return { kind: "literal", value: atom, inverted: false };
	if (atom.length !== 2 || atom[0] !== "\\") return undefined;
	const escaped = atom[1];
	const category = escaped.toLowerCase();
	if (category === "d" || category === "s" || category === "w") {
		return { kind: "class", value: category, inverted: escaped !== category };
	}
	if (/[^A-Za-z0-9]/.test(escaped)) return { kind: "literal", value: escaped, inverted: false };
	return undefined;
}

function atomDomainMatches(domain: SimpleAtomDomain, character: string, ignoreCase: boolean): boolean {
	if (domain.kind === "literal") {
		return ignoreCase
			? domain.value.toLocaleLowerCase("en-US") === character.toLocaleLowerCase("en-US")
			: domain.value === character;
	}
	let matches: boolean;
	if (domain.value === "d") matches = character >= "0" && character <= "9";
	else if (domain.value === "s") matches = /\s/.test(character);
	else matches = /[A-Za-z0-9_]/.test(character);
	return domain.inverted ? !matches : matches;
}

function variableAtomsMayOverlap(left: string, right: string, ignoreCase: boolean): boolean {
	if (left === "*" || right === "*" || left === "." || right === "." || left === right) return true;
	const leftDomain = simpleAtomDomain(left);
	const rightDomain = simpleAtomDomain(right);
	if (leftDomain === undefined || rightDomain === undefined) return true;
	if (leftDomain.kind === "literal") return atomDomainMatches(rightDomain, leftDomain.value, ignoreCase);
	if (rightDomain.kind === "literal") return atomDomainMatches(leftDomain, rightDomain.value, ignoreCase);
	for (let code = 0; code < 128; code++) {
		const character = String.fromCharCode(code);
		if (
			atomDomainMatches(leftDomain, character, ignoreCase) &&
			atomDomainMatches(rightDomain, character, ignoreCase)
		) {
			return true;
		}
	}
	return false;
}

function validatePatternSafety(pattern: string, flags: string): void {
	if (pattern.length > MAX_PATTERN_LENGTH) {
		throw new Error(`pattern exceeds the ${MAX_PATTERN_LENGTH}-character bounded safety limit`);
	}
	const analysis = new PatternSafetyParser(pattern, flags.includes("v"), flags.includes("i")).parse();
	if (analysis.nullable) {
		throw new Error("the pattern can match without consuming input; a zero-width match protects no secret value");
	}
	if (analysis.variableWidthAlternations > 1) {
		throw new Error("concatenated variable-width alternations cannot be proven safe from catastrophic backtracking");
	}
}

export function compileSecretRegex(pattern: string, flags?: string): RegExp {
	const literal = splitRegexLiteral(pattern);
	const resolvedPattern = literal?.pattern ?? pattern;
	const explicitFlags = flags ?? "";
	const literalFlags = literal?.flags ?? "";

	validateFlags(explicitFlags, 'the explicit "flags" field');
	validateFlags(literalFlags, "the regex literal");

	const mergedFlags = Array.from(new Set(explicitFlags + literalFlags)).join("");
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
