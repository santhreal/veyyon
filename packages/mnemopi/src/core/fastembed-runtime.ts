import { createRequire } from "node:module";
import * as path from "node:path";
import {
	ensureRuntimeInstalled,
	getFastembedRuntimeDir,
	installRuntimeModuleResolver,
	logger,
	type RuntimeInstallSpec,
	resolveRuntimeModule,
} from "@veyyon/utils";
import type * as Fastembed from "fastembed";
import packageManifest from "../../package.json" with { type: "json" };

type FastembedModule = typeof Fastembed;

export interface FastembedRuntimeInstallPlan {
	versionKey: string;
	install: RuntimeInstallSpec;
}

const FASTEMBED_SPEC = packageManifest.peerDependencies.fastembed;

export function fastembedRuntimeInstallPlan(): FastembedRuntimeInstallPlan {
	return {
		versionKey: `fastembed-${FASTEMBED_SPEC}_transitive-ort`.replace(/[^A-Za-z0-9._-]/g, "_"),
		install: {
			dependencies: { fastembed: FASTEMBED_SPEC },
			trustedDependencies: ["onnxruntime-node"],
		},
	};
}
let fastembedLoad: Promise<FastembedModule> | null = null;

export function loadFastembed(): Promise<FastembedModule> {
	fastembedLoad ??= loadFastembedOnce().catch(error => {
		fastembedLoad = null;
		throw error;
	});
	return fastembedLoad;
}

async function loadFastembedOnce(): Promise<FastembedModule> {
	try {
		if (process.platform === "win32") {
			await import("onnxruntime-node");
		}
		return await import("fastembed");
	} catch (error) {
		if (!isRecoverableFastembedLoadError(error)) throw error;
		logger.warn(
			"mnemopi: the installed fastembed could not be loaded, so a runtime copy is being downloaded and installed on demand; the first indexing run will be slow",
			{ error: String(error) },
		);
		return loadFromRuntimeInstall();
	}
}

async function loadFromRuntimeInstall(): Promise<FastembedModule> {
	const plan = fastembedRuntimeInstallPlan();
	const runtimeDir = await ensureRuntimeInstalled({
		runtimeDir: path.join(getFastembedRuntimeDir(), plan.versionKey),
		install: plan.install,
		probePackage: "fastembed",
	});
	const nodeModules = path.join(runtimeDir, "node_modules");
	installRuntimeModuleResolver({ runtimeNodeModules: nodeModules });
	if (process.platform === "win32") {
		const ortEntry = resolveRuntimeModule(nodeModules, "onnxruntime-node");
		if (ortEntry) createRequire(ortEntry)(ortEntry);
	}
	const entry = resolveRuntimeModule(nodeModules, "fastembed");
	if (!entry) throw new Error(`fastembed runtime install at ${runtimeDir} has no loadable entry`);
	const requireRuntime = createRequire(entry);
	return requireRuntime(entry) as FastembedModule;
}

export function isRecoverableFastembedLoadError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
	if (name === "ResolveMessage") return true;
	if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_DLOPEN_FAILED") return true;
	return typeof message === "string" && /cannot find (module|package)/i.test(message);
}
