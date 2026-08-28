import * as os from "node:os";
import * as path from "node:path";
import { DIR_LOCATION_ENV_KEYS } from "./dir-env-keys";
import { parseEnvFile, type UnreadableEnvFileReporter } from "./dotenv-parse";
import { errorMessage } from "./type-guards";

const reportUnreadable: UnreadableEnvFileReporter = (filePath, error) => {
	process.emitWarning(
		`Environment file exists but could not be read; none of its variables were applied: ${filePath} (${errorMessage(
			error,
		)})`,
		{ code: "VEYYON_ENV_FILE_UNREADABLE" },
	);
};

const injected = new Set<string>();

export const homeDotenvInjectedKeys: Set<string> = injected;

const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"), reportUnreadable);
for (const key of DIR_LOCATION_ENV_KEYS) {
	const value = homeEnv[key];
	if (value === undefined || Bun.env[key]) continue;
	Bun.env[key] = value;
	injected.add(key);
}
