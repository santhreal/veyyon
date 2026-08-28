import { getGlobalConfigRootDir } from "@veyyon/utils";
import { collectEnvSecrets, loadSecrets, type SecretEntry, SecretObfuscator } from ".";
import { buildEnvSecretPattern, loadEnvSecretKeywords } from "./env-keywords";
import { resolveVaultLocations, SecretVault } from "./vault";
import { loadOrCreateVaultKey } from "./vault-crypto";

export interface StandaloneSecretRuntimeOptions {
	/** Project whose declarations and project vault apply to this provider dispatch. */
	cwd: string;
	/** Active profile's agent directory. */
	agentDir: string;
	/** Mirrors the session-level `secrets.enabled` gate. Disabled runtimes perform no secret I/O. */
	enabled: boolean;
	/** Test/isolation override; production callers use the active global config root. */
	globalConfigRoot?: string;
}

/** Load the complete secret runtime for a provider-facing operation that does not create an AgentSession. */
export async function loadStandaloneSecretRuntime(options: StandaloneSecretRuntimeOptions): Promise<SecretObfuscator> {
	if (!options.enabled) return new SecretObfuscator([]);
	try {
		const globalConfigRoot = options.globalConfigRoot ?? getGlobalConfigRootDir();
		const placeholderKey = await loadOrCreateVaultKey(globalConfigRoot);
		const vault = new SecretVault(
			resolveVaultLocations({ globalConfigRoot, agentDir: options.agentDir, cwd: options.cwd }),
		);
		const [fileEntries, envKeywords, liveVaultEntries] = await Promise.all([
			loadSecrets(options.cwd, options.agentDir),
			loadEnvSecretKeywords({ cwd: options.cwd, agentDir: options.agentDir }),
			vault.load(),
		]);
		const envEntries = collectEnvSecrets(buildEnvSecretPattern(envKeywords));
		const vaultEntries: SecretEntry[] = liveVaultEntries.map(secret => ({
			type: "plain",
			content: secret.value,
			name: secret.name,
			expiresAt: secret.expiresAt,
			origin: "vault",
		}));
		return new SecretObfuscator(envEntries.concat(fileEntries, vaultEntries), { placeholderKey });
	} catch {
		throw new Error(
			"Refusing provider dispatch because the secret protection runtime could not be loaded. Fix secrets.yml, env-keywords.yml, or the secret vault and retry.",
		);
	}
}
