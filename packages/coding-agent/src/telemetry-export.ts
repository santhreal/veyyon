import type * as TraceNode from "@opentelemetry/sdk-trace-node";
import { logger, postmortem } from "@veyyon/utils";

const FLUSH_INTERVAL_MS = 30_000;

let provider: TraceNode.NodeTracerProvider | undefined;
let initPromise: Promise<void> | undefined;

export function isTelemetryExportEnabled(): boolean {
	return provider !== undefined;
}

export async function initTelemetryExport(): Promise<void> {
	if (provider) return;
	if (initPromise) return initPromise;

	if (process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return;
	if (tracesExporterDisabled(process.env.OTEL_TRACES_EXPORTER)) return;

	const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (!endpoint) return;

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

	const exporter = new OTLPTraceExporter();
	const tracerProvider = new NodeTracerProvider({
		resource: resourceFromAttributes({
			"service.name": process.env.OTEL_SERVICE_NAME ?? "veyyon",
		}),
		spanProcessors: [new BatchSpanProcessor(exporter)],
	});
	tracerProvider.register({ contextManager: new AsyncLocalStorageContextManager().enable() });
	provider = tracerProvider;

	const flushTimer = setInterval(() => {
		provider?.forceFlush().catch(() => {});
	}, FLUSH_INTERVAL_MS);
	flushTimer.unref();

	postmortem.register("otel-trace-export", async () => {
		clearInterval(flushTimer);
		await provider?.shutdown();
	});
}

function tracesExporterDisabled(raw: string | undefined): boolean {
	if (!raw) return false;
	return raw.split(",").some(entry => entry.trim().toLowerCase() === "none");
}

export async function flushTelemetryExport(): Promise<void> {
	await provider?.forceFlush();
}
