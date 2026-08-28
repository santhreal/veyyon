/**
 * Container filesystem mount generation: docker-compose overlay YAML and Harbor
 * mounts JSON payloads for binding repository sources and linux dependencies.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { repoRootDir } from "../../engine/package-paths";
import { type Config, SOURCE_BIN_MOUNT, SOURCE_SRC_MOUNT } from "./config";
import type { SourceMount } from "./deps";

/**
 * Docker-compose overlay YAML injected via `harbor run --compose-overlay`.
 * Sets host-network mode, routes host.docker.internal, and adds bind mounts
 * for source installations.
 */
export function writeComposeOverlay(benchDir: string, cfg: Config, source: SourceMount | null): string | null {
	const lines: string[] = [];
	if (cfg.hostNetwork) lines.push('    network_mode: "host"');
	if (cfg.gateway && new URL(cfg.gatewayUrl).hostname === "host.docker.internal") {
		lines.push("    extra_hosts:");
		lines.push('      - "host.docker.internal:host-gateway"');
	}
	const hasExtraVolumes = cfg.extraVolumes.length > 0;
	if (source || hasExtraVolumes) {
		lines.push("    volumes:");
		if (source) {
			lines.push(`      - "${repoRootDir()}:${SOURCE_SRC_MOUNT}:ro"`);
			for (const rel of source.nodeModules) {
				lines.push(`      - "${path.join(source.depsDir, rel)}:${SOURCE_SRC_MOUNT}/${rel}:ro"`);
			}
			lines.push(`      - "${path.join(source.depsDir, "bin")}:${SOURCE_BIN_MOUNT}:ro"`);
		}
		for (const v of cfg.extraVolumes) {
			lines.push(`      - "${v}"`);
		}
	}
	if (lines.length === 0) return null;
	const yaml = `services:\n  main:\n${lines.join("\n")}\n`;
	const file = path.join(benchDir, "compose-overlay.yml");
	fs.writeFileSync(file, yaml);
	return file;
}

/**
 * `harbor run --mounts` JSON (compose service-volume format) for non-compose
 * environments (apple-container): source repo + linux deps tree. Apple
 * Container currently mounts binds read-write regardless of `read_only`.
 */
export function buildMountsJson(source: SourceMount | null): string | null {
	if (!source) return null;
	const mounts: Array<{ type: "bind"; source: string; target: string; read_only: true }> = [
		{ type: "bind", source: repoRootDir(), target: SOURCE_SRC_MOUNT, read_only: true },
	];
	for (const rel of source.nodeModules) {
		mounts.push({
			type: "bind",
			source: path.join(source.depsDir, rel),
			target: `${SOURCE_SRC_MOUNT}/${rel}`,
			read_only: true,
		});
	}
	mounts.push({ type: "bind", source: path.join(source.depsDir, "bin"), target: SOURCE_BIN_MOUNT, read_only: true });
	return JSON.stringify(mounts);
}
