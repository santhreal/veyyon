/**
 * WHY. A discovered MCP config is expanded once at load time, and an unset `${VAR}` with no default
 * is reported to that expansion's sink and left as the literal text `${VAR}` (`expandEnvVarsDeep` in
 * `discovery/env-expansion.ts`). Credential
 * fields fail closed at connect, but the structural fields did not: `command`, `args`, `cwd` and
 * `url` carried the literal into `Bun.spawn` and into a URL, so an unset variable became a command
 * argument, a working directory that does not exist, or a hostname nobody meant. The failure that
 * followed named the variable's text, never the field, and the operator was told a program was
 * missing rather than that a variable was unset.
 *
 * THE CLASS THIS CLOSES. Not "the reported field is checked". Every string-bearing field of the
 * server schema is enumerated from `config/mcp-schema.json` at run time and must be classified,
 * pinned by exact equality, so a field added to the schema turns this red until someone decides
 * which side it is on. The rejection is driven through the real `connectToServer`, and the proof
 * that nothing ran is a marker file a spawned child would have created.
 *
 * WHAT IT DOES NOT CATCH. `env`, `headers`, `auth` and `oauth` are deliberately not scanned, since
 * their strings are resolved credential material and a real secret may contain `${`. The first two
 * are re-resolved through the config-value grammar at connect and covered by
 * `a-credential-that-cannot-be-presented-is-not-sent-anonymously.test.ts`; an unresolved placeholder
 * in `auth`/`oauth` still reaches the authorization server and is rejected there. Nor does this
 * bound `$VAR` without braces: the expansion never produced it, so it is config text, not residue.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { collectUnresolved, expandEnvVarsDeep } from "@veyyon/coding-agent/discovery/env-expansion";
import { connectToServer } from "@veyyon/coding-agent/mcp/client";
import type { MCPServerConfig, MCPStdioServerConfig } from "@veyyon/coding-agent/mcp/types";
import {
	findUnresolvedPlaceholder,
	MCPUnresolvedPlaceholderError,
	PLACEHOLDER_CHECKED_FIELDS,
	PLACEHOLDER_DELEGATED_FIELDS,
	PLACEHOLDER_TRANSPORT_SELECTOR_FIELDS,
} from "@veyyon/coding-agent/mcp/unresolved-placeholder";
import { TempDir } from "@veyyon/utils";

/** A variable this suite requires to be unset, so the expansion leaves its placeholder behind. */
const ABSENT = "VEYYON_TEST_MCP_ABSENT_VARIABLE";

/**
 * A stdio config whose command really is spawnable and whose child announces itself on disk.
 *
 * The marker is what separates "the guard refused" from "the spawn failed anyway": a config that
 * reaches `Bun.spawn` creates the file even when the server is useless afterwards.
 */
function markerConfig(marker: string, overrides: Partial<MCPStdioServerConfig>): MCPStdioServerConfig {
	return {
		type: "stdio",
		command: process.execPath,
		args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");`],
		timeout: 2000,
		...overrides,
	};
}

async function marked(marker: string): Promise<boolean> {
	try {
		await fs.stat(marker);
		return true;
	} catch {
		return false;
	}
}

/** Connect and return the rejection, failing loudly when a connection was established instead. */
async function refusal(config: MCPServerConfig): Promise<unknown> {
	try {
		const connection = await connectToServer("placeholder-server", config);
		await connection.transport.close();
		throw new Error("connectToServer resolved; it was expected to refuse the config");
	} catch (error) {
		return error;
	}
}

/** Expansion exactly as a discovery provider performs it: reports to a sink, value travels on. */
function expandUnderTest<T>(config: T): T {
	return expandEnvVarsDeep(config, collectUnresolved());
}

describe("an unresolved placeholder never reaches a spawn", () => {
	it("refuses a command that is still a placeholder, naming the field and the variable", async () => {
		delete process.env[ABSENT];
		const error = await refusal(expandUnderTest({ type: "stdio", command: `\${${ABSENT}}` } as MCPServerConfig));
		expect(error).toBeInstanceOf(MCPUnresolvedPlaceholderError);
		const message = (error as Error).message;
		expect(message).toContain("command");
		expect(message).toContain(ABSENT);
		// The fix line has to name both ways out, or the operator is left guessing which.
		expect(message).toContain(`export ${ABSENT}`);
		expect(message).toContain(`\${${ABSENT}:-value}`);
	});

	it("refuses an argument that is still a placeholder, and spawns nothing", async () => {
		delete process.env[ABSENT];
		using dir = TempDir.createSync("veyyon-mcp-placeholder-");
		const marker = path.join(path.resolve(dir.path()), "spawned-from-args");
		const config = markerConfig(marker, {});
		config.args = [...(config.args ?? []), `--flag=\${${ABSENT}}`];
		const error = await refusal(expandUnderTest(config as MCPServerConfig));
		expect(error).toBeInstanceOf(MCPUnresolvedPlaceholderError);
		expect((error as MCPUnresolvedPlaceholderError).field).toBe("args[2]");
		expect((error as MCPUnresolvedPlaceholderError).variable).toBe(ABSENT);
		expect(await marked(marker)).toBe(false);
	});

	it("refuses a working directory that is still a placeholder, and spawns nothing", async () => {
		delete process.env[ABSENT];
		using dir = TempDir.createSync("veyyon-mcp-placeholder-");
		const marker = path.join(path.resolve(dir.path()), "spawned-from-cwd");
		const config = markerConfig(marker, { cwd: `/tmp/\${${ABSENT}}` });
		const error = await refusal(expandUnderTest(config as MCPServerConfig));
		expect(error).toBeInstanceOf(MCPUnresolvedPlaceholderError);
		expect((error as MCPUnresolvedPlaceholderError).field).toBe("cwd");
		expect(await marked(marker)).toBe(false);
	});

	it("refuses a URL that is still a placeholder, and opens no socket", async () => {
		delete process.env[ABSENT];
		let hits = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				hits += 1;
				return new Response("{}", { headers: { "content-type": "application/json" } });
			},
		});
		try {
			const error = await refusal(
				expandUnderTest({
					type: "http",
					url: `http://127.0.0.1:${server.port}/mcp/\${${ABSENT}}`,
					timeout: 2000,
				} as MCPServerConfig),
			);
			expect(error).toBeInstanceOf(MCPUnresolvedPlaceholderError);
			expect((error as MCPUnresolvedPlaceholderError).field).toBe("url");
			expect(hits).toBe(0);
		} finally {
			await server.stop(true);
		}
	});

	it("refuses a passthrough name that is still a placeholder", () => {
		delete process.env[ABSENT];
		const found = findUnresolvedPlaceholder(
			expandUnderTest({
				type: "stdio",
				command: "server",
				envPassthrough: ["HOME", `\${${ABSENT}}`],
			} as MCPServerConfig),
		);
		expect(found).toEqual({ field: "envPassthrough[1]", variable: ABSENT });
	});

	it("lets a resolved variable and a default through", () => {
		process.env[ABSENT] = "/opt/servers/real";
		try {
			expect(
				findUnresolvedPlaceholder(
					expandUnderTest({ type: "stdio", command: `\${${ABSENT}}/bin/server` } as MCPServerConfig),
				),
			).toBeUndefined();
		} finally {
			delete process.env[ABSENT];
		}
		expect(
			findUnresolvedPlaceholder(
				expandUnderTest({
					type: "stdio",
					command: "server",
					args: [`--root=\${${ABSENT}:-/var/empty}`],
				} as MCPServerConfig),
			),
		).toBeUndefined();
	});

	it("leaves credential fields to the grammar that resolves them", () => {
		delete process.env[ABSENT];
		// A resolved secret may itself contain `${`, so scanning these would reject working servers.
		expect(
			findUnresolvedPlaceholder(
				expandUnderTest({
					type: "stdio",
					command: "server",
					env: { TOKEN: `\${${ABSENT}}` },
				} as MCPServerConfig),
			),
		).toBeUndefined();
		expect(
			findUnresolvedPlaceholder(
				expandUnderTest({
					type: "http",
					url: "https://example.invalid/mcp",
					headers: { Authorization: `Bearer \${${ABSENT}}` },
				} as MCPServerConfig),
			),
		).toBeUndefined();
	});

	/**
	 * The sweep. Every string-bearing property of the server schema is classified, and the three sets
	 * are pinned by equality rather than counted, so a new schema field cannot join one silently.
	 */
	it("classifies every string-bearing field the schema defines", async () => {
		const schemaPath = path.join(import.meta.dirname, "..", "..", "src", "config", "mcp-schema.json");
		const schema = JSON.parse(await fs.readFile(schemaPath, "utf8")) as Record<string, unknown>;
		const defs = schema.$defs as Record<string, Record<string, unknown>>;

		/** True when this schema node can hold a string anywhere beneath it. */
		const holdsString = (node: unknown): boolean => {
			if (!node || typeof node !== "object") return false;
			const spec = node as Record<string, unknown>;
			if (typeof spec.$ref === "string") return holdsString(defs[spec.$ref.replace("#/$defs/", "")]);
			if (spec.type === "string") return true;
			for (const key of ["items", "additionalProperties"]) {
				if (holdsString(spec[key])) return true;
			}
			for (const branch of ["allOf", "anyOf", "oneOf"]) {
				const list = spec[branch];
				if (Array.isArray(list) && list.some(holdsString)) return true;
			}
			const properties = spec.properties;
			if (properties && typeof properties === "object") {
				if (Object.values(properties).some(holdsString)) return true;
			}
			return false;
		};

		const collect = (node: unknown, into: Set<string>): void => {
			if (!node || typeof node !== "object") return;
			const spec = node as Record<string, unknown>;
			if (typeof spec.$ref === "string") {
				collect(defs[spec.$ref.replace("#/$defs/", "")], into);
				return;
			}
			for (const branch of ["allOf", "anyOf", "oneOf"]) {
				const list = spec[branch];
				if (Array.isArray(list)) for (const item of list) collect(item, into);
			}
			const properties = spec.properties as Record<string, unknown> | undefined;
			if (!properties) return;
			for (const [name, child] of Object.entries(properties)) {
				if (holdsString(child)) into.add(name);
			}
		};

		const fields = new Set<string>();
		collect(defs.serverConfig, fields);
		// The schema has to be reachable at all, or the sweep would pass on an empty set.
		expect(fields.size).toBeGreaterThan(5);

		const classified: string[] = [
			...PLACEHOLDER_CHECKED_FIELDS,
			...PLACEHOLDER_DELEGATED_FIELDS,
			...PLACEHOLDER_TRANSPORT_SELECTOR_FIELDS,
		];
		expect([...fields].filter(field => !classified.includes(field)).sort()).toEqual([]);
		expect([...PLACEHOLDER_CHECKED_FIELDS].sort()).toEqual(["args", "command", "cwd", "envPassthrough", "url"]);
		expect([...PLACEHOLDER_DELEGATED_FIELDS].sort()).toEqual(["auth", "env", "headers", "oauth"]);
		expect([...PLACEHOLDER_TRANSPORT_SELECTOR_FIELDS]).toEqual(["type"]);
	});
});
