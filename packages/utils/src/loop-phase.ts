const stack: string[] = [];
let recentPhase: string | undefined;

export function pushLoopPhase(label: string): void {
	stack.push(label);
	recentPhase = label;
}

export function popLoopPhase(): void {
	stack.pop();
}

export function currentLoopPhase(): string | undefined {
	return stack[stack.length - 1];
}

export function takeRecentLoopPhase(): string | undefined {
	const phase = stack[stack.length - 1] ?? recentPhase;
	recentPhase = undefined;
	return phase;
}
