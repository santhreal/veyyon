/**
 * Live event-loop phase breadcrumb. Hot synchronous paths push a short label
 * before running and pop it after (via `try`/`finally`); the loop watchdog
 * reads {@link takeLoopPhaseProfile} when it detects a block, so a stall is
 * logged with the work that caused it instead of an opaque "unknown".
 *
 * This is deliberately a process-global stack and not part of the logger span
 * machinery: `main.ts` ends timing spans before the interactive TUI starts, so
 * `logger.openSpanPath()` is empty in a live session.
 *
 * A LABEL ALONE IS NOT A CAUSE. Only a handful of spans in the product push a
 * phase at all, so in an interactive session the last label pushed before any
 * block is nearly always the render pass, whatever actually blocked. Naming it
 * sends a reader to rewrite a pass that measures in single-digit milliseconds.
 * Each frame therefore carries its start time, every pop banks the elapsed
 * synchronous cost against its label, and the profile reports how long the
 * phase actually ran. A phase that accounts for a sliver of the block is not
 * reported as its cause.
 *
 * Correctness constraint: each `pushLoopPhase` must be balanced by a
 * `popLoopPhase` within the SAME synchronous execution (always via `try`/
 * `finally`). The stack is global and shared, so a label held across an
 * `await`/async boundary — or interleaved between concurrent tasks — would
 * misattribute or leak phases. Instrument only synchronous spans; for async
 * work, push/pop around each synchronous chunk, not across the await.
 */
interface PhaseFrame {
	readonly label: string;
	/** Reset by {@link takeLoopPhaseProfile} so a held phase is charged to one interval at a time. */
	start: number;
}

const stack: PhaseFrame[] = [];
/**
 * Synchronous milliseconds banked per label since the last profile read. A
 * phase that pushed and popped inside one macrotask is already gone from the
 * stack by the time the watchdog's delayed tick runs; this is what keeps its
 * cost, and the cost is the whole point.
 */
const spentMs = new Map<string, number>();
/** Last label pushed, kept so a phase whose cost rounds to nothing is still nameable. */
let recentPhase: string | undefined;

/** What ran during the interval that just elapsed, and for how long. */
export interface LoopPhaseProfile {
	/** Label that spent the most synchronous time, or `undefined` if none ran. */
	readonly phase: string | undefined;
	/** Synchronous milliseconds that label spent in the interval. */
	readonly ms: number;
}

export function pushLoopPhase(label: string): void {
	stack.push({ label, start: performance.now() });
	recentPhase = label;
}

export function popLoopPhase(): void {
	const frame = stack.pop();
	if (!frame) return;
	spentMs.set(frame.label, (spentMs.get(frame.label) ?? 0) + (performance.now() - frame.start));
}

export function currentLoopPhase(): string | undefined {
	return stack[stack.length - 1]?.label;
}

/**
 * Costliest phase of the interval that just elapsed, and its cost.
 *
 * A phase still held when this runs is charged for the time it has been open,
 * because that is precisely the case where the loop is blocked INSIDE it. The
 * accounting is then cleared and every live frame restarted, so one interval's
 * cost is never billed to the next.
 *
 * Nested phases each count the time they were open, so an inner phase's cost is
 * also inside its outer one's. The caller wants the largest span that was
 * running, and the outer span genuinely was.
 */
export function takeLoopPhaseProfile(): LoopPhaseProfile {
	const now = performance.now();
	const totals = new Map(spentMs);
	for (const frame of stack) {
		totals.set(frame.label, (totals.get(frame.label) ?? 0) + (now - frame.start));
		frame.start = now;
	}
	spentMs.clear();

	let phase: string | undefined;
	let ms = 0;
	for (const [label, total] of totals) {
		if (total >= ms) {
			phase = label;
			ms = total;
		}
	}
	if (phase === undefined) {
		phase = recentPhase;
		ms = 0;
	}
	recentPhase = undefined;
	return { phase, ms };
}
