/**
 * Event stream collection and early-termination observer for benchmark prompts.
 *
 * Listens to client events, enforces connection and activity timeouts, tracks
 * turn limits, logs tool execution events, and invokes early-stop triggers.
 */

import { setTimeout as sleepFor } from "node:timers/promises";
import type { EarlyStopOptions } from "./early-stop";
import type { BenchmarkPromptDelivery } from "./prompt-delivery";
import { isMutationTool, PromptTimeoutError, PromptTurnLimitError } from "./telemetry";
import type { BenchmarkClient, BenchmarkConfig } from "./types";

/** How long a client gets to unwind its stream after the wait that aborted it has ended. */
export const PROMPT_UNWIND_GRACE_MS = 1_000;

export async function collectPromptEvents(
	client: BenchmarkClient,
	delivery: BenchmarkPromptDelivery,
	config: BenchmarkConfig,
	logEvent: (event: unknown) => Promise<void>,
	earlyStop?: EarlyStopOptions,
): Promise<Array<{ type: string; [key: string]: unknown }>> {
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	let unsubscribe: (() => void) | undefined;
	const startedAt = Date.now();
	let pendingRetry = false;
	let toolExecutionStarts = 0;
	let toolExecutionEnds = 0;
	let messageEnds = 0;
	let lastEventType: string | undefined;
	const recentEventTypes: string[] = [];
	let observedTurns = 0;
	let timer: NodeJS.Timeout | undefined;
	let settled = false;
	let receivedFirstEvent = false;
	let earlyStopTriggered = false;
	let earlyStopChain: Promise<void> = Promise.resolve();

	const connectionTimeout = config.connectionTimeout ?? 30_000;

	const eventsPromise = new Promise<void>((resolve, reject) => {
		const resolveWait = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe?.();
			resolve();
		};

		const rejectWait = (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe?.();
			reject(err);
		};

		const fireTimeout = () => {
			client.abort?.();
			rejectWait(
				new PromptTimeoutError({
					elapsedMs: Date.now() - startedAt,
					eventCount: events.length,
					toolExecutionStarts,
					toolExecutionEnds,
					messageEnds,
					lastEventType,
					recentEventTypes: [...recentEventTypes],
					pendingRetry,
				}),
			);
		};

		const triggerEarlyStop = () => {
			if (!earlyStop || earlyStopTriggered || settled) return;
			earlyStopChain = earlyStopChain
				.then(async () => {
					if (earlyStopTriggered || settled) return;
					let matched = false;
					try {
						matched = await earlyStop.check();
					} catch {
						return;
					}
					if (!matched || earlyStopTriggered || settled) return;
					earlyStopTriggered = true;
					try {
						await earlyStop.onMatch();
					} catch {
						// Swallow callback errors; we still want to short-circuit.
					}
					client.abort?.();
					resolveWait();
				})
				.catch(() => {});
		};

		// Start with the shorter connection timeout; upgrade to full timeout on first event
		timer = setTimeout(fireTimeout, connectionTimeout);

		unsubscribe = client.onEvent(event => {
			if (!event || settled) return;
			const typedEvent = event as { type: string; [key: string]: unknown };

			// First event arrived: switch to the full activity timeout
			if (!receivedFirstEvent) {
				receivedFirstEvent = true;
				clearTimeout(timer);
				timer = setTimeout(fireTimeout, config.timeout);
			}

			events.push(typedEvent);
			lastEventType = typedEvent.type;
			recentEventTypes.push(typedEvent.type);
			if (recentEventTypes.length > 8) {
				recentEventTypes.shift();
			}
			if (typedEvent.type === "tool_execution_start") {
				toolExecutionStarts += 1;
			}
			if (typedEvent.type === "tool_execution_end") {
				toolExecutionEnds += 1;
			}
			if (typedEvent.type === "tool_execution_end" && !typedEvent.isError && isMutationTool(typedEvent.toolName)) {
				triggerEarlyStop();
			}
			if (typedEvent.type === "message_end") {
				messageEnds += 1;
			}

			if (
				typedEvent.type === "tool_execution_start" ||
				typedEvent.type === "tool_execution_end" ||
				typedEvent.type === "message_end"
			) {
				logEvent(typedEvent).catch(() => {});
			}
			if (typedEvent.type === "turn_start") {
				observedTurns += 1;
				if (typeof config.maxTurns === "number" && observedTurns > config.maxTurns) {
					client.abort?.();
					rejectWait(
						new PromptTurnLimitError({
							elapsedMs: Date.now() - startedAt,
							observedTurns,
							maxTurns: config.maxTurns,
							pendingRetry,
							lastEventType,
							recentEventTypes: [...recentEventTypes],
						}),
					);
					return;
				}
				if (pendingRetry) {
					pendingRetry = false;
				}
			} else if (typedEvent.type === "auto_retry_start") {
				pendingRetry = true;
			}
			if (typedEvent.type === "agent_end") {
				if (pendingRetry) return;
				resolveWait();
			}
		});
	});

	let waitFailure: unknown;
	// Also prevents an unhandled rejection when the wait ends while the delivery is still in flight.
	const waitSettled = eventsPromise.then(
		() => {},
		(err: unknown) => {
			waitFailure = err;
		},
	);

	let delivered = false;
	let deliveryFailed = false;
	let deliveryError: unknown;
	const deliverySettled = (
		delivery.kind === "followUp" ? client.followUp(delivery.message) : client.prompt(delivery.message)
	).then(
		() => {
			delivered = true;
		},
		(err: unknown) => {
			delivered = true;
			deliveryFailed = true;
			deliveryError = err;
		},
	);

	// The deadline fires inside the wait, and `abort` is optional on a client: one that does not
	// implement it, or whose abort does not unblock its own stream, would hold this await after the
	// deadline was already spent, and no deadline covers a trial above this layer. So the delivery is
	// raced against the wait, and once the wait has ended the unwind gets a bounded grace.
	await Promise.race([deliverySettled, waitSettled]);
	if (!delivered) {
		const unwind = new AbortController();
		await Promise.race([
			deliverySettled,
			sleepFor(PROMPT_UNWIND_GRACE_MS, undefined, { signal: unwind.signal }).catch(() => {}),
		]);
		unwind.abort();
	}

	// The deadline and the turn limit win over the delivery's own failure, because the abort error a
	// client raises here is a consequence of this wait ending, and the attempt's retry accounting
	// reads the wait's error.
	if (waitFailure !== undefined) throw waitFailure;
	if (deliveryFailed) {
		clearTimeout(timer);
		unsubscribe?.();
		// Abort raised inside prompt(); the run already short-circuited successfully.
		if (earlyStopTriggered) return events;
		throw deliveryError;
	}
	await eventsPromise;
	return events;
}
