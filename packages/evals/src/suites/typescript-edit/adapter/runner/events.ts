/**
 * Event stream collection and early-termination observer for benchmark prompts.
 *
 * Listens to client events, enforces connection and activity timeouts, tracks
 * turn limits, logs tool execution events, and invokes early-stop triggers.
 */

import type { EarlyStopOptions } from "./early-stop";
import type { BenchmarkPromptDelivery } from "./prompt-delivery";
import { isMutationTool, PromptTimeoutError, PromptTurnLimitError } from "./telemetry";
import type { BenchmarkClient, BenchmarkConfig } from "./types";

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

	// Prevent unhandled rejection if events reject eventsPromise during prompt()
	eventsPromise.catch(() => {});

	try {
		if (delivery.kind === "followUp") {
			await client.followUp(delivery.message);
		} else {
			await client.prompt(delivery.message);
		}
	} catch (err) {
		if (earlyStopTriggered) {
			// Abort raised inside prompt(); the run already short-circuited successfully.
			clearTimeout(timer);
			unsubscribe?.();
			return events;
		}
		clearTimeout(timer);
		unsubscribe?.();
		throw err;
	}
	await eventsPromise;
	return events;
}
