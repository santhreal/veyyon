/**
 * How `tab.fill` sets a date or time input with a person's keys instead of script.
 *
 * Chromium draws such an input as a row of fields in its user-agent shadow tree, one per part of the
 * value, in the order the browser's locale writes them. A field takes digits (`DateTimeNumericField
 * Element`), and a month-name or AM/PM field takes the option's number through type-ahead's
 * `kMatchIndex` (`DateTimeSymbolicFieldElement`): "12" is December and "2" is PM in every locale. A
 * press on a field focuses it, and leaving a field keeps what was typed, so each field is pressed and
 * typed in turn, whatever its locale's order. Each digit dispatches the input's own trusted `input`.
 */

/** A node as `DOM.describeNode` with `pierce` returns it, the parts read here. */
export interface CdpNode {
	readonly backendNodeId: number;
	readonly attributes?: readonly string[];
	readonly children?: readonly CdpNode[];
	readonly shadowRoots?: readonly CdpNode[];
}

/** A field of a date or time input's editor. */
export interface DateField {
	/** What part of the value it holds: `year`, `month`, `day`, `hour`, `minute`, `second`, `millisecond`, `ampm`, `week`. */
	readonly part: string;
	/** `aria-valuemin` and `aria-valuemax`: an hour field's range tells its clock. */
	readonly min: number;
	readonly max: number;
	readonly backendNodeId: number;
}

const FIELD_PSEUDO = /^-webkit-datetime-edit-([a-z]+)-field$/;

/** The editor's fields in the order it shows them. */
export function collectDateFields(root: CdpNode): DateField[] {
	const fields: DateField[] = [];
	const walk = (node: CdpNode): void => {
		const attributes = new Map<string, string>();
		const list = node.attributes ?? [];
		for (let index = 0; index + 1 < list.length; index += 2) attributes.set(list[index]!, list[index + 1]!);
		const part = FIELD_PSEUDO.exec(attributes.get("pseudo") ?? "")?.[1];
		if (part !== undefined) {
			fields.push({
				part,
				min: Number(attributes.get("aria-valuemin")),
				max: Number(attributes.get("aria-valuemax")),
				backendNodeId: node.backendNodeId,
			});
		}
		for (const shadow of node.shadowRoots ?? []) walk(shadow);
		for (const child of node.children ?? []) walk(child);
	};
	walk(root);
	return fields;
}

/** The parts of an input's value, as numbers. */
interface ValueParts {
	year?: number;
	month?: number;
	day?: number;
	week?: number;
	hour?: number;
	minute?: number;
	second?: number;
	millisecond?: number;
}

const DATE = "(\\d{4,})-(\\d{2})-(\\d{2})";
const TIME = "(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,3}))?)?";

function timeParts(match: RegExpExecArray, from: number): ValueParts {
	const fraction = match[from + 3];
	return {
		hour: Number(match[from]),
		minute: Number(match[from + 1]),
		second: Number(match[from + 2] ?? 0),
		millisecond: fraction === undefined ? 0 : Number(fraction.padEnd(3, "0")),
	};
}

/** Split a value in the form the input's `value` holds it; undefined when it is not that form. */
function parseValue(type: string, value: string): ValueParts | undefined {
	let match: RegExpExecArray | null;
	switch (type) {
		case "date":
			match = new RegExp(`^${DATE}$`).exec(value);
			return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : undefined;
		case "month":
			match = /^(\d{4,})-(\d{2})$/.exec(value);
			return match ? { year: Number(match[1]), month: Number(match[2]) } : undefined;
		case "week":
			match = /^(\d{4,})-W(\d{2})$/.exec(value);
			return match ? { year: Number(match[1]), week: Number(match[2]) } : undefined;
		case "time":
			match = new RegExp(`^${TIME}$`).exec(value);
			return match ? timeParts(match, 1) : undefined;
		case "datetime-local":
			match = new RegExp(`^${DATE}T${TIME}$`).exec(value);
			return match
				? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), ...timeParts(match, 4) }
				: undefined;
		default:
			return undefined;
	}
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

/** The digits an hour field takes for `hour` (0 to 23), by the clock its range shows. */
function hourDigits(hour: number, field: DateField): string | undefined {
	if (field.min === 1 && field.max === 12) return pad(hour % 12 === 0 ? 12 : hour % 12, 2);
	if (field.min === 0 && field.max === 11) return pad(hour % 12, 2);
	if (field.min === 0 && field.max === 23) return pad(hour, 2);
	if (field.min === 1 && field.max === 24) return pad(hour === 0 ? 24 : hour, 2);
	return undefined;
}

/**
 * What to type in each field, in the fields' order, for `value`: the digits of its part, or an empty
 * string for a field to clear with Backspace when `value` is empty. Undefined for a field this does not
 * know or a value not in the input's form, which the script sets.
 */
export function planDateKeys(type: string, value: string, fields: readonly DateField[]): string[] | undefined {
	if (fields.length === 0) return undefined;
	if (value === "") return fields.map(() => "");
	const parts = parseValue(type, value);
	if (!parts) return undefined;
	const keys: string[] = [];
	for (const field of fields) {
		let digits: string | undefined;
		switch (field.part) {
			case "year":
				digits = parts.year === undefined ? undefined : String(parts.year);
				break;
			case "month":
				digits = parts.month === undefined ? undefined : pad(parts.month, 2);
				break;
			case "day":
				digits = parts.day === undefined ? undefined : pad(parts.day, 2);
				break;
			case "week":
				digits = parts.week === undefined ? undefined : pad(parts.week, 2);
				break;
			case "hour":
				digits = parts.hour === undefined ? undefined : hourDigits(parts.hour, field);
				break;
			case "minute":
				digits = parts.minute === undefined ? undefined : pad(parts.minute, 2);
				break;
			case "second":
				digits = parts.second === undefined ? undefined : pad(parts.second, 2);
				break;
			case "millisecond":
				digits = parts.millisecond === undefined ? undefined : pad(parts.millisecond, 3);
				break;
			case "ampm":
				digits = parts.hour === undefined ? undefined : parts.hour < 12 ? "1" : "2";
				break;
		}
		if (digits === undefined) return undefined;
		keys.push(digits);
	}
	return keys;
}
