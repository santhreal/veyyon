/** OTLP trace export bootstrap. Veyyon's agent core (`@veyyon/agent-core`) emits OpenTelemetry GenAI */

import type * as TraceNode from "@opentelemetry/sdk-trace-node";
import { logger, postmortem } from "@veyyon/utils";

/** Periodic flush interval. A long-lived `veyyon` process (the ACP server is spawned once and reused across many turns) would otherwise hold finished */
const FLUSH_INTERVAL_MS = 30_000;

let provider: TraceNode.NodeTracerProvider | undefined;
let initPromise: Promise<void> | undefined;

/** Whether {@link initTelemetryExport} registered a real provider. The CLI uses this to decide whether to switch on the agent loop's telemetry config — there */
export function isTelemetryExportEnabled(): boolean {
	return provider !== undefined;
}

/** Register the global TracerProvider + OTLP exporter when an OTLP endpoint is configured via env. Idempotent, and a no-op when no endpoint is set (or when */
export async function initTelemetryExport(): Promise<void> {
	if (provider) return;
	if (initPromise) return initPromise;

	// The OTEL env contract parses booleans and enum lists case-insensitively, so
	// OTEL_SDK_DISABLED=TRUE and OTEL_TRACES_EXPORTER=None must also disable export.
	if (process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return;
	if (tracesExporterDisabled(process.env.OTEL_TRACES_EXPORTER)) return;

	const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (!endpoint) return;

	// We only ship the http/protobuf transport (the line validated on Bun). The OTEL contract lets OTEL_EXPORTER_OTLP*_PROTOCOL select grpc / http/json;
	const protocol = (process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL)
		?.trim()
		.toLowerCase();
	if (protocol && protocol !== "http/protobuf") {
		logger.warn(
			`OTEL trace export disabled: OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is unsupported (only http/protobuf)`,
		);
		return;
	}

	initPromise = registerProvider();
	return initPromise;
}

async function registerProvider(): Promise<void> {
	const [
		{ AsyncLocalStorageContextManager },
		{ OTLPTraceExporter },
		{ resourceFromAttributes },
		{ BatchSpanProcessor },
		{ NodeTracerProvider },
	] = await Promise.all([
		import("@opentelemetry/context-async-hooks"),
		import("@opentelemetry/exporter-trace-otlp-proto"),
		import("@opentelemetry/resources"),
		import("@opentelemetry/sdk-trace-base"),
		import("@opentelemetry/sdk-trace-node"),
	]);

	// The exporter reads endpoint/headers/timeout from OTEL_EXPORTER_OTLP_* itself,
	// so there is nothing to thread through here.
	const exporter = new OTLPTraceExporter();
	const tracerProvider = new NodeTracerProvider({
		resource: resourceFromAttributes({
			"service.name": process.env.OTEL_SERVICE_NAME ?? "veyyon",
		}),
		spanProcessors: [new BatchSpanProcessor(exporter)],
	});
	// register() installs the global tracer provider and the W3C trace-context +
	// baggage propagators; the explicit AsyncLocalStorage context manager keeps
	// parent/child span linkage working under Bun.
	tracerProvider.register({ contextManager: new AsyncLocalStorageContextManager().enable() });
	provider = tracerProvider;

	const flushTimer = setInterval(() => {
		provider?.forceFlush().catch(() => {});
	}, FLUSH_INTERVAL_MS);
	flushTimer.unref();

	// Shut down through postmortem rather than a bare signal listener. postmortem owns SIGINT/SIGTERM/SIGHUP/exit and quit(), and awaits registered cleanups
	postmortem.register("otel-trace-export", async () => {
		clearInterval(flushTimer);
		await provider?.shutdown();
	});
}

/** Parse the `OTEL_TRACES_EXPORTER` selection. The value is a case-insensitive, comma-separated list; the literal `none` disables span export entirely. */
function tracesExporterDisabled(raw: string | undefined): boolean {
	if (!raw) return false;
	return raw.split(",").some(entry => entry.trim().toLowerCase() === "none");
}

/** Flush any buffered spans to the exporter. No-op when export is disabled. Hosts embedding the agent can call this at natural boundaries (e.g. the end */
export async function flushTelemetryExport(): Promise<void> {
	await provider?.forceFlush();
}
