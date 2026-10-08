/**
 * The hooks every request of a session passes through: the secret lease a request is admitted under,
 * the context and payload transforms the extensions run, the stream function that redacts each
 * payload, the tool-argument transform that expands secrets and argot handles, and the telemetry
 * sanitizer.
 */

import {
	type AgentMessage,
	type AgentTelemetryConfig,
	filterProviderReplayMessages,
	type StreamFn,
	type ToolCallArgumentTransform,
} from "@veyyon/agent-core";
import type { Context, Message, Model, SimpleStreamOptions } from "@veyyon/ai";
import { errorMessage, logger } from "@veyyon/utils";
import type { ArgotSession } from "argot/session";
import { expandToolArguments } from "../argot-wire";
import type { Settings } from "../config/settings";
import type { ExtensionRunner } from "../extensibility/extensions";
import { SecretRequestLeases } from "../secrets/request-leases";
import type { SessionSecretRuntime } from "../secrets/session-runtime";
import type { SecretRuntimeLease } from "./agent-session-types";
import { convertToLlm } from "./messages";
import { wrapSteeringForModel } from "./steering-envelope";

/** The per-request hooks an agent and its session share. */
export interface SessionRequestHooks {
	readonly requestLeases: SecretRequestLeases;
	readonly transformContext: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	readonly convertToLlm: (messages: AgentMessage[]) => Message[];
	readonly transformProviderContext: (
		context: Context,
		model: Model,
		requestLease?: SecretRuntimeLease,
	) => Promise<Context>;
	readonly onPayload: (payload: unknown, model?: Model) => Promise<unknown>;
	readonly onResponse: SimpleStreamOptions["onResponse"];
}

/**
 * The hooks every request of a session passes through. A request is admitted under a secret lease
 * before the first async extension hook, and the arrays and context it returns keep that authority
 * through provider serialization.
 */
export function createRequestHooks(
	secretRuntime: SessionSecretRuntime,
	extensionRunner: ExtensionRunner,
): SessionRequestHooks {
	const requestLeases = new SecretRequestLeases(secretRuntime);
	return {
		requestLeases,
		transformContext: async messages => {
			const lease = await requestLeases.admit(messages);
			const withContext = await extensionRunner.emitContext(messages);
			const transformed = wrapSteeringForModel(withContext);
			requestLeases.bind(withContext, lease);
			requestLeases.bind(transformed, lease);
			return transformed;
		},
		// No image policy here. Conversion sees one model per session, while the main turn, a side
		// request, compaction and an advisor each dispatch their own; the policy resolves in
		// AgentSession's provider-context hook, which has the model the request is sent to.
		convertToLlm: messages =>
			requestLeases.redactMessages(messages, filterProviderReplayMessages(convertToLlm(messages))),
		transformProviderContext: async (context, _model, requestLease) =>
			requestLeases.redactContext(context, requestLease),
		// The raw extension hook. The leased stream wrapper performs the final redaction after this
		// await, with the request's immutable runtime.
		onPayload: async payload => (await extensionRunner.emitBeforeProviderRequest(payload)) ?? payload,
		onResponse: async (response, model) => {
			await extensionRunner.emitAfterProviderResponse(response, model);
		},
	};
}

/**
 * The agent's stream function. `onFirstChatDispatch`, the launch-latency marker, fires once, before the
 * first request reaches the provider transport. Each request's payload passes through the secret lease
 * the request was admitted under, after any `onPayload` the request carries.
 */
export function createLeasedStreamFn(
	requestLeases: SecretRequestLeases,
	streamFn: StreamFn,
	onFirstChatDispatch: (() => void) | undefined,
): StreamFn {
	let notifyFirstChatDispatch = onFirstChatDispatch;
	return async (streamModel, context, streamOptions) => {
		if (notifyFirstChatDispatch) {
			const notify = notifyFirstChatDispatch;
			notifyFirstChatDispatch = undefined;
			try {
				notify();
			} catch (err) {
				logger.warn("onFirstChatDispatch hook threw", { error: errorMessage(err) });
			}
		}
		const runtime = requestLeases.requestLease(context);
		const optionsForRequest = streamOptions ?? {};
		const requestOnPayload = optionsForRequest.onPayload;
		const leasedOnPayload =
			runtime.hasRedactions || requestOnPayload
				? async (payload: unknown, payloadModel?: Model) => {
						const replacement = requestOnPayload ? await requestOnPayload(payload, payloadModel) : undefined;
						return runtime.obfuscatePayload(replacement ?? payload);
					}
				: undefined;
		return streamFn(streamModel, context, { ...optionsForRequest, onPayload: leasedOnPayload });
	};
}

/** What {@link createToolArgumentTransform} reads. */
export interface ToolArgumentTransformInput {
	settings: Settings;
	secretRuntime: SessionSecretRuntime;
	requestLeases: SecretRequestLeases;
	argot: ArgotSession | undefined;
	sessionId: () => string | undefined;
}

/**
 * The agent's tool-argument transform. `display` is what an operator reads and the session records;
 * `execution` is what the tool runs with, and differs from `display` only where a secret expanded. Both
 * carry a timeout clamped to `tools.maxTimeout`, and both expand loaded argot handles: a handle is
 * opaque to a reader, so an unexpanded display is a defect, not a protection.
 */
export function createToolArgumentTransform(
	input: ToolArgumentTransformInput,
): (args: Record<string, unknown>, toolName: string) => ToolCallArgumentTransform {
	const { settings, secretRuntime, requestLeases, argot, sessionId } = input;
	return (args, toolName) => {
		let display = args;
		const maxTimeout = settings.get("tools.maxTimeout");
		if (maxTimeout > 0 && typeof display.timeout === "number") {
			display = { ...display, timeout: Math.min(display.timeout, maxTimeout) };
		}
		let execution = secretRuntime.deobfuscateForExecution(requestLeases.mainRequest, display, toolName, sessionId());
		if (argot?.loaded) {
			// When no secret expanded, `execution` is `display` itself and one walk serves both.
			const expandedDisplay = expandToolArguments(argot, display);
			execution = execution === display ? expandedDisplay : expandToolArguments(argot, execution);
			display = expandedDisplay;
		}
		return { execution, display };
	};
}

/**
 * The caller's telemetry config, with every exported text passed through the session's secret
 * obfuscation after the caller's own sanitizer. Opt-in: a session without one starts no span and never
 * evaluates `@opentelemetry/api`.
 */
export function sessionTelemetry(
	telemetry: AgentTelemetryConfig | undefined,
	secretRuntime: SessionSecretRuntime,
): AgentTelemetryConfig | undefined {
	if (!telemetry) return undefined;
	const callerSanitizer = telemetry.textSanitizer;
	return {
		...telemetry,
		textSanitizer: text => secretRuntime.obfuscateText(callerSanitizer ? callerSanitizer(text) : text),
	};
}
