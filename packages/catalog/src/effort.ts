export const enum Effort {
	Minimal = "minimal",
	Low = "low",
	Medium = "medium",
	High = "high",
	XHigh = "xhigh",
	Max = "max",
}

export const THINKING_EFFORTS: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

export function isEffort(value: unknown): value is Effort {
	return typeof value === "string" && THINKING_EFFORTS.includes(value as Effort);
}

export function canonicalizeEfforts(efforts: readonly Effort[]): Effort[] {
	return THINKING_EFFORTS.filter(effort => efforts.includes(effort));
}
