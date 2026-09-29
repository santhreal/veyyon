/**
 * How `tab.select` sets a `<select>` with a person's input instead of script.
 *
 * A value a script assigns fires no event, and an `input` or `change` event a script dispatches has
 * `isTrusted` false, which a page that watches its form reads as automation. Chromium's type-ahead
 * (`HTMLSelectElement::TypeAheadFind`, `TypeAhead::HandleEvent`) selects an option from printable keys
 * typed at a focused `<select>` on every platform, closed drop-down or list box alike, and dispatches
 * both events itself. The keys are planned here by replaying that algorithm over the select's list
 * items. Arrow keys are not used: on macOS they open the drop-down's popup instead of moving the
 * selection.
 */

/** An option as the page holds it. */
export interface SelectOptionState {
	readonly value: string;
	/** `option.label`: the `label` attribute, or the option's text. */
	readonly label: string;
	/** `:disabled`, an option in a disabled `<optgroup>` included. */
	readonly disabled: boolean;
	readonly selected: boolean;
	/** Its place among the select's list items: its options, groups and separators in order. */
	readonly listIndex: number;
}

/** A `<select>` as the page holds it when `tab.select` starts. */
export interface SelectState {
	readonly isSelect: boolean;
	readonly multiple: boolean;
	readonly disabled: boolean;
	/** `appearance: base-select`, whose type-ahead moves focus between options instead of selecting. */
	readonly customizable: boolean;
	/** The drop-down's popup is open, where keys move a highlight instead of the selection. */
	readonly open: boolean;
	readonly focused: boolean;
	/** The browser runs on macOS, where a list box adds to its selection with Command, not Control. */
	readonly mac: boolean;
	readonly selectedIndex: number;
	/** How many list items the select has: options, `<optgroup>`s and `<hr>`s. */
	readonly listCount: number;
	readonly options: readonly SelectOptionState[];
}

/** The part of a {@link SelectState} type-ahead reads. */
export type TypeAheadState = Pick<SelectState, "options" | "selectedIndex" | "listCount">;

/** Read a `<select>`'s {@link SelectState}. Runs in the page; self-contained. */
export function readSelectState(element: unknown): SelectState {
	const select = element as {
		tagName?: string;
		multiple: boolean;
		disabled: boolean;
		selectedIndex: number;
		options: ArrayLike<{ value: string; label: string; selected: boolean; matches(selector: string): boolean }>;
		matches(selector: string): boolean;
		querySelectorAll(selector: string): ArrayLike<unknown>;
		getRootNode(): { activeElement?: unknown };
		ownerDocument: { defaultView: { getComputedStyle(el: unknown): { appearance?: string } } | null };
	};
	const nav = (globalThis as unknown as { navigator: { platform: string } }).navigator;
	if (select?.tagName !== "SELECT") {
		return {
			isSelect: false,
			multiple: false,
			disabled: false,
			customizable: false,
			open: false,
			focused: false,
			mac: false,
			selectedIndex: -1,
			listCount: 0,
			options: [],
		};
	}
	let open = false;
	try {
		open = select.matches(":open");
	} catch {
		// A browser without `:open` cannot say; a key the popup takes shows in the verification.
	}
	// Chromium's type-ahead counts list items, groups and separators among them, from the one selected.
	const items = Array.from(select.querySelectorAll("option, optgroup, hr"));
	const options: SelectOptionState[] = [];
	for (let index = 0; index < select.options.length; index++) {
		const option = select.options[index]!;
		options.push({
			value: option.value,
			label: option.label,
			disabled: option.matches(":disabled"),
			selected: option.selected,
			listIndex: items.indexOf(option),
		});
	}
	return {
		isSelect: true,
		multiple: select.multiple,
		disabled: select.disabled,
		customizable: select.ownerDocument.defaultView?.getComputedStyle(select).appearance === "base-select",
		open,
		focused: select.getRootNode().activeElement === select,
		mac: /^Mac/.test(nav.platform),
		selectedIndex: select.selectedIndex,
		listCount: items.length,
		options,
	};
}

/**
 * The options `values` selects: every option whose value is one of them in a multiple select, and the
 * last such option in a single one, as assigning `selected` to each in order leaves it.
 */
export function selectTargets(state: SelectState, values: readonly string[]): number[] {
	const wanted = new Set(values);
	const matching: number[] = [];
	state.options.forEach((option, index) => {
		if (wanted.has(option.value)) matching.push(index);
	});
	if (state.multiple || matching.length === 0) return matching;
	return [matching[matching.length - 1]!];
}

/** Case and accents folded, as `StartsWithIgnoringCaseAndAccents` compares. */
function fold(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** An option's type-ahead text: empty for a disabled one, which `OptionAtIndex` reports as empty. */
function typeAheadText(option: SelectOptionState): string {
	return option.disabled ? "" : fold(option.label.replace(/^[\s\u00a0]+/u, ""));
}

/** A character a key sends as a `keypress`: one UTF-16 unit, not a control character. */
function isKeyChar(char: string): boolean {
	if (char.length !== 1) return false;
	const code = char.charCodeAt(0);
	return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0) && !(code >= 0xd800 && code <= 0xdfff);
}

/**
 * The option `keys`, typed at once from a fresh session, leaves selected, by its index in
 * `state.options`: `TypeAhead::HandleEvent` replayed over the list items.
 */
export function simulateTypeAhead(state: TypeAheadState, keys: string): number {
	const count = state.listCount;
	if (count === 0) return state.selectedIndex;
	const texts: string[] = new Array(count).fill("");
	const optionAt = new Map<number, number>();
	state.options.forEach((option, index) => {
		if (option.listIndex < 0 || option.listIndex >= count) return;
		texts[option.listIndex] = typeAheadText(option);
		optionAt.set(option.listIndex, index);
	});
	let selected = state.selectedIndex < 0 ? -1 : (state.options[state.selectedIndex]?.listIndex ?? -1);
	let buffer = "";
	let repeating = "";
	for (const char of keys) {
		buffer += char;
		let prefix = buffer;
		let startOffset = 1;
		if (char === repeating) {
			prefix = char;
		} else if (buffer.length > 1) {
			repeating = "";
			startOffset = 0;
		} else {
			repeating = char;
		}
		const folded = fold(prefix);
		let index = ((selected < 0 ? 0 : selected) + startOffset) % count;
		for (let step = 0; step < count; step++, index = (index + 1) % count) {
			if (texts[index]!.startsWith(folded)) {
				selected = index;
				break;
			}
		}
	}
	return selected < 0 ? -1 : (optionAt.get(selected) ?? -1);
}

/**
 * The shortest keys that select option `target` by type-ahead: its first character repeated until it
 * cycles there, or the shortest prefix of its text that lands there. Undefined when neither does: an
 * option with no text, a disabled one, or one whose text another option's always wins.
 */
export function typeAheadKeys(state: TypeAheadState, target: number): string | undefined {
	const chars = Array.from(typeAheadText(state.options[target]!));
	if (chars.length === 0 || !isKeyChar(chars[0]!)) return undefined;
	let best: string | undefined;
	for (let presses = 1; presses <= state.options.length; presses++) {
		const keys = chars[0]!.repeat(presses);
		if (simulateTypeAhead(state, keys) === target) {
			best = keys;
			break;
		}
	}
	for (let length = 2; length <= chars.length && (best === undefined || length < best.length); length++) {
		if (!isKeyChar(chars[length - 1]!)) break;
		const keys = chars.slice(0, length).join("");
		if (simulateTypeAhead(state, keys) === target) {
			best = keys;
			break;
		}
	}
	return best;
}

export type SelectPlan =
	/** The options `values` names are the ones selected already: a person changes nothing. */
	| { readonly kind: "done" }
	/** No key or click reaches the state `values` names; the script sets it. */
	| { readonly kind: "script"; readonly reason: string }
	/** Type `keys` at the focused select, then add each option of `extra` by a click with `modifier` held. */
	| {
			readonly kind: "input";
			readonly keys: string;
			readonly extra: readonly number[];
			readonly modifier: "Control" | "Meta";
	  };

/** How `tab.select(values)` sets `state`. */
export function planSelect(state: SelectState, values: readonly string[]): SelectPlan {
	const targets = selectTargets(state, values);
	const selected = state.options.flatMap((option, index) => (option.selected ? [index] : []));
	if (targets.length > 0 && targets.length === selected.length && targets.every((t, i) => t === selected[i])) {
		return { kind: "done" };
	}
	if (targets.length === 0) return { kind: "script", reason: "no option has a value it names" };
	if (state.disabled) return { kind: "script", reason: "the <select> is disabled" };
	if (state.customizable) return { kind: "script", reason: "a customizable <select> focuses options by type-ahead" };
	if (targets.some(index => state.options[index]!.disabled)) {
		return { kind: "script", reason: "an option it names is disabled" };
	}
	const keys = typeAheadKeys(state, targets[0]!);
	if (keys === undefined) return { kind: "script", reason: "no typed text selects the option" };
	return { kind: "input", keys, extra: targets.slice(1), modifier: state.mac ? "Meta" : "Control" };
}

/**
 * Leave `values` selected and return the selected values. A selection input reached stays and no event
 * is sent; otherwise every option is set and `input` and `change` are dispatched. Runs in the page;
 * self-contained.
 */
export function settleSelection(
	element: unknown,
	values: readonly string[],
): { selected: string[]; scripted: boolean } {
	const select = element as {
		multiple: boolean;
		options: ArrayLike<{ value: string; selected: boolean }>;
		dispatchEvent(event: unknown): boolean;
		ownerDocument: { defaultView: { Event: new (type: string, init: { bubbles: boolean }) => unknown } | null };
	};
	const wanted = new Set(values);
	const matching: number[] = [];
	const held: number[] = [];
	for (let index = 0; index < select.options.length; index++) {
		if (wanted.has(select.options[index]!.value)) matching.push(index);
		if (select.options[index]!.selected) held.push(index);
	}
	const targets = select.multiple || matching.length === 0 ? matching : [matching[matching.length - 1]!];
	const reached = targets.length > 0 && targets.length === held.length && targets.every((t, i) => t === held[i]);
	if (!reached) {
		for (let index = 0; index < select.options.length; index++) {
			select.options[index]!.selected = wanted.has(select.options[index]!.value);
		}
		const EventCtor = select.ownerDocument.defaultView?.Event;
		if (EventCtor) {
			select.dispatchEvent(new EventCtor("input", { bubbles: true }));
			select.dispatchEvent(new EventCtor("change", { bubbles: true }));
		}
	}
	const selected: string[] = [];
	for (let index = 0; index < select.options.length; index++) {
		if (select.options[index]!.selected) selected.push(select.options[index]!.value);
	}
	return { selected, scripted: !reached };
}
