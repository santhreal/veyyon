/**
 * Docker resource cleanup and output truncation for Harbor benchmark trials and compose projects.
 * A trial's process tree is terminated by `src/core/process-tree.ts`.
 */
import { spawnSync } from "node:child_process";
import { errorMessage } from "@veyyon/utils";
import { runBoundedCommand, syncCommandOptions } from "../../../core/external-command";

/**
 * The two functions below run before and after a whole harbor invocation rather than inside a trial,
 * so they stay synchronous — and take the same bound, because a `docker ps` that never returns
 * otherwise holds the launch with nothing printed.
 */
const SYNC_COMMAND_OPTIONS = syncCommandOptions();

/** Harbor names each trial's compose project `<task>__<7-char-suffix>`. */
const HARBOR_PROJECT_RE = /^[a-z0-9_.-]+__[a-zA-Z0-9]{7}$/;

export interface DockerContainer {
	id: string;
	state: string;
	project: string;
	workingDir: string;
}

/** All containers belonging to a Harbor trial (by compose project or task working_dir). */
export function listHarborContainers(): DockerContainer[] {
	const res = spawnSync(
		"docker",
		[
			"ps",
			"-a",
			"--format",
			'{{.ID}}\t{{.State}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
		],
		SYNC_COMMAND_OPTIONS,
	);
	if (res.status !== 0 || !res.stdout) return [];
	const out: DockerContainer[] = [];
	for (const line of res.stdout.trim().split("\n")) {
		if (!line.trim()) continue;
		const [id, state, project, workingDir] = line.split("\t");
		if (!id) continue;
		const harbor = HARBOR_PROJECT_RE.test(project ?? "") || (workingDir ?? "").includes(".cache/harbor/tasks");
		if (harbor) out.push({ id, state: state ?? "", project: project ?? "", workingDir: workingDir ?? "" });
	}
	return out;
}

/**
 * Remove leftover Harbor trial Docker resources: containers in a Harbor compose
 * trial project (or staged under `.cache/harbor/tasks`) plus the trial networks
 * crashed runs leave behind. With `force`, running containers are killed too and
 * every idle trial network is dropped; otherwise only exited/created/dead
 * containers and networks with no running container are removed.
 */
export function runDockerCleanup(force: boolean): void {
	try {
		process.stdout.write("Running harbor-targeted Docker cleanup...\n");
		const containers = listHarborContainers();
		const removable = force ? containers : containers.filter(c => ["exited", "created", "dead"].includes(c.state));
		if (removable.length > 0) {
			const ids = removable.map(c => c.id);
			process.stdout.write(
				`${force ? "Force-removing" : "Removing"} ${ids.length} leftover Harbor container(s)...\n`,
			);
			const rm = spawnSync("docker", force ? ["rm", "-f", ...ids] : ["rm", ...ids], SYNC_COMMAND_OPTIONS);
			if (rm.status !== 0) {
				process.stdout.write(`  docker rm failed: ${(rm.stderr ?? "").trim() || `exit ${rm.status}`}\n`);
			}
		}

		// Networks of projects that still have a running container are kept (non-force).
		const activeProjects = new Set<string>();
		if (!force) {
			for (const c of containers) {
				if (c.state === "running" && c.project) activeProjects.add(c.project);
			}
		}

		const netInspect = spawnSync(
			"docker",
			["network", "ls", "--format", "{{.ID}}\t{{.Labels}}"],
			SYNC_COMMAND_OPTIONS,
		);
		if (netInspect.status === 0 && netInspect.stdout) {
			const netIdsToRemove: string[] = [];
			for (const netLine of netInspect.stdout.trim().split("\n")) {
				const [netId, labels] = netLine.split("\t");
				if (!netId) continue;
				const projMatch = (labels ?? "").match(/com\.docker\.compose\.project=([^,]+)/);
				if (!projMatch) continue;
				if (HARBOR_PROJECT_RE.test(projMatch[1]) && !activeProjects.has(projMatch[1])) {
					netIdsToRemove.push(netId);
				}
			}
			if (netIdsToRemove.length > 0) {
				process.stdout.write(`Removing ${netIdsToRemove.length} stale trial Docker network(s)...\n`);
				for (const netId of netIdsToRemove) {
					const rmNet = spawnSync("docker", ["network", "rm", netId], SYNC_COMMAND_OPTIONS);
					if (rmNet.status !== 0) {
						process.stdout.write(
							`  docker network rm ${netId} failed: ${(rmNet.stderr ?? "").trim() || `exit ${rmNet.status}`}\n`,
						);
					}
				}
			}
		}
		process.stdout.write("Docker cleanup completed.\n");
	} catch (err: unknown) {
		process.stdout.write(`\nwarning: failed to run docker cleanup: ${errorMessage(err)}\n`);
	}
}

export interface ScopedHarborCleanupOptions {
	readonly jobDir?: string;
	readonly jobName?: string;
	readonly force?: boolean;
}

export async function cleanupHarborTrialContainers(
	options: ScopedHarborCleanupOptions,
	exec?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<void> {
	const runExec = exec ?? runBoundedCommand;

	try {
		const psRes = await runExec("docker", [
			"ps",
			"-a",
			"--format",
			'{{.ID}}\t{{.State}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
		]);

		const matchedContainerIds: string[] = [];
		const matchedProjects = new Set<string>();

		for (const line of psRes.stdout.trim().split("\n")) {
			if (!line.trim()) continue;
			const [id, state, project, workingDir] = line.split("\t");
			if (!id) continue;

			let matches = false;
			if (options.jobDir) {
				if (
					workingDir === options.jobDir ||
					workingDir?.startsWith(`${options.jobDir}/`) ||
					workingDir?.startsWith(`${options.jobDir}\\`)
				) {
					matches = true;
				}
			}
			if (options.jobName && !matches) {
				if (
					project === options.jobName ||
					project?.startsWith(`${options.jobName}_`) ||
					project?.startsWith(`${options.jobName}-`)
				) {
					matches = true;
				}
			}
			if (matches) {
				if (options.force || ["exited", "created", "dead"].includes(state ?? "")) {
					matchedContainerIds.push(id);
				}
				if (project) {
					matchedProjects.add(project);
				}
			}
		}

		if (matchedContainerIds.length > 0) {
			const rmArgs = options.force ? ["rm", "-f", ...matchedContainerIds] : ["rm", ...matchedContainerIds];
			try {
				await runExec("docker", rmArgs);
			} catch {
				/* ignore */
			}
		}

		const netRes = await runExec("docker", ["network", "ls", "--format", "{{.ID}}\t{{.Name}}\t{{.Labels}}"]);

		const matchedNetIds: string[] = [];
		for (const line of netRes.stdout.trim().split("\n")) {
			if (!line.trim()) continue;
			const [netId, name, labels] = line.split("\t");
			if (!netId) continue;

			let netMatches = false;
			if (options.jobDir && (labels ?? "").includes(options.jobDir)) {
				netMatches = true;
			}
			if (options.jobName) {
				if (
					name === `${options.jobName}_default` ||
					name === options.jobName ||
					name?.startsWith(`${options.jobName}-`) ||
					name?.startsWith(`${options.jobName}_`)
				) {
					netMatches = true;
				}
				if ((labels ?? "").includes(`com.docker.compose.project=${options.jobName}`)) {
					netMatches = true;
				}
			}
			if (!netMatches && matchedProjects.size > 0) {
				for (const proj of matchedProjects) {
					if (name === `${proj}_default` || (labels ?? "").includes(`com.docker.compose.project=${proj}`)) {
						netMatches = true;
						break;
					}
				}
			}

			if (netMatches) {
				matchedNetIds.push(netId);
			}
		}

		if (matchedNetIds.length > 0) {
			for (const netId of matchedNetIds) {
				try {
					await runExec("docker", ["network", "rm", netId]);
				} catch {
					/* ignore */
				}
			}
		}
	} catch {
		/* ignore docker failures */
	}
}
