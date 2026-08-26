import * as path from "node:path";
import { YAML } from "bun";

/**
 * Parse config file content as YAML (`.yaml`, `.yml`) or JSON by extension; does not swallow parse errors.
 */
export function parseJsonOrYamlByExtension(content: string, filePath: string): unknown {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml") {
		return YAML.parse(content) as unknown;
	}
	return JSON.parse(content) as unknown;
}
