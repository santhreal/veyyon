export const Flag = {
	Class: 0x1000,
	ThinkingLoop: 0x0001_0000,
	Transient: 0x0002_0000,
	Timeout: 0x0004_0000,
	UsageLimit: 0x0008_0000,
	StaleResponsesItem: 0x0010_0000,
	MalformedFunctionCall: 0x0020_0000,
	ProviderFinishError: 0x0040_0000,
	ContentBlocked: 0x0000_8000,
	ContextOverflow: 0x0080_0000,
	AuthFailed: 0x0100_0000,
	SilentAbort: 0x0200_0000,
	UserInterrupt: 0x0400_0000,
	Abort: 0x0800_0000,
	Grammar: 0x1000_0000,
	FastModeUnsupported: 0x2000_0000,
	TransportRefused: 0x4000_0000,
} as const;

export type Flag = (typeof Flag)[keyof typeof Flag];

export const KIND_MASK: number = Object.entries(Flag)
	.filter(([name]) => name !== "Class")
	.reduce((bits, [, bit]) => bits | bit, 0);

export const ERROR_KIND_LABELS: readonly [Flag, string][] = Object.entries(Flag)
	.filter(([name]) => name !== "Class")
	.map(([name, bit]) => [bit, name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()] as [Flag, string]);

export function create(...flags: number[]): number {
	let bits = 0;
	for (const f of flags) bits |= f;
	return bits | Flag.Class;
}

export function is(id: number | undefined, flag: Flag): boolean {
	return ((id ?? 0) & flag) !== 0;
}

export function isClassified(id: number | undefined): boolean {
	return ((id ?? 0) & Flag.Class) !== 0;
}

export function statusFromId(id: number | undefined): number | undefined {
	return id && !isClassified(id) ? id : undefined;
}

export function stringify(id: number | undefined): string {
	if (!id) return "none";
	if (!isClassified(id)) return `status:${id}`;
	const labels = ERROR_KIND_LABELS.filter(([kind]) => is(id, kind)).map(([, label]) => label);
	return labels.length > 0 ? labels.join("|") : `classified:0x${id.toString(16)}`;
}
