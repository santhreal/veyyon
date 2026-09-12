import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/discovery/capability/fs";
import {
	scanCustomToolsFromDir,
	scanMarkdownCommands,
	scanSubdirectoryHooks,
} from "@veyyon/coding-agent/discovery/helpers";
import { parseFrontmatter, removeWithRetries } from "@veyyon/utils";

describe("parseFrontmatter", () => {
	const parse = (content: string) => parseFrontmatter(content, { source: "tests:frontmatter", level: "off" });

	test("parses simple key-value pairs", () => {
		const content = `---
name: test
enabled: true
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({ name: "test", enabled: true });
		expect(result.body).toBe("Body content");
	});

	test("parses YAML list syntax", () => {
		const content = `---
tags:
  - javascript
  - typescript
  - react
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			tags: ["javascript", "typescript", "react"],
		});
		expect(result.body).toBe("Body content");
	});

	test("parses multi-line string values", () => {
		const content = `---
description: |
  This is a multi-line
  description block
  with several lines
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			description: "This is a multi-line\ndescription block\nwith several lines\n",
		});
		expect(result.body).toBe("Body content");
	});

	test("parses nested objects", () => {
		const content = `---
config:
  server:
    port: 3000
    host: localhost
  database:
    name: mydb
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			config: {
				server: { port: 3000, host: "localhost" },
				database: { name: "mydb" },
			},
		});
		expect(result.body).toBe("Body content");
	});

	test("parses mixed complex YAML", () => {
		const content = `---
name: complex-test
version: 1.0.0
tags:
  - prod
  - critical
metadata:
  author: tester
  created: 2024-01-01
description: |
  Multi-line description
  with formatting
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			name: "complex-test",
			version: "1.0.0",
			tags: ["prod", "critical"],
			metadata: {
				author: "tester",
				created: "2024-01-01",
			},
			description: "Multi-line description\nwith formatting\n",
		});
		expect(result.body).toBe("Body content");
	});

	test("handles missing frontmatter", () => {
		const content = "Just body content";
		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Just body content");
	});

	test("handles invalid YAML in frontmatter", () => {
		const content = `---
invalid: [unclosed array
---
Body content`;

		const result = parse(content);
		// Simple fallback parser extracts key:value pairs it can parse
		expect(result.frontmatter).toEqual({ invalid: "[unclosed array" });
		// Body is still extracted even with invalid YAML
		expect(result.body).toBe("Body content");
	});

	test("handles empty frontmatter", () => {
		const content = `---
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Body content");
	});

	test("normalizes kebab-case keys to camelCase", () => {
		const content = `---
thinking-level: medium
output-schema: json
nested-field:
  inner-key: value
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			thinkingLevel: "medium",
			outputSchema: "json",
			nestedField: { innerKey: "value" },
		});
		expect(result.body).toBe("Body content");
	});
});

describe("consolidated discovery helpers", () => {
	let tempDir = "";

	const setup = async () => {
		clearFsCache();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-discovery-helpers-test-"));
	};

	const teardown = async () => {
		clearFsCache();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	};

	describe("scanCustomToolsFromDir", () => {
		test("discovers all files and strips only recognized script extensions", async () => {
			await setup();
			try {
				await fs.writeFile(path.join(tempDir, "git-helper.sh"), "#!/bin/sh\n");
				await fs.writeFile(path.join(tempDir, "query.py"), "print('hello')\n");
				await fs.writeFile(path.join(tempDir, "ignored.txt"), "text file\n");

				const result = await scanCustomToolsFromDir(tempDir, "test-provider", "user");

				expect(result.warnings).toEqual([]);
				expect(result.items).toHaveLength(3);
				const names = result.items.map(t => t.name).sort();
				expect(names).toEqual(["git-helper", "ignored.txt", "query"]);
				const gitHelper = result.items.find(t => t.name === "git-helper");
				expect(gitHelper?.description).toBe("git-helper custom tool");
				expect(gitHelper?.level).toBe("user");
				expect(gitHelper?._source.provider).toBe("test-provider");
			} finally {
				await teardown();
			}
		});
	});

	describe("scanSubdirectoryHooks", () => {
		test("scans pre/ and post/ subdirectories and parses tool names", async () => {
			await setup();
			try {
				const preDir = path.join(tempDir, "pre");
				const postDir = path.join(tempDir, "post");
				await fs.mkdir(preDir, { recursive: true });
				await fs.mkdir(postDir, { recursive: true });
				await fs.writeFile(path.join(preDir, "bash.sh"), "#!/bin/sh\n");
				await fs.writeFile(path.join(postDir, "write.bash"), "#!/bin/bash\n");

				const result = await scanSubdirectoryHooks(tempDir, "claude-test", "user");
				expect(result.warnings).toEqual([]);
				expect(result.items).toHaveLength(2);

				const pre = result.items.find(h => h.type === "pre");
				expect(pre?.name).toBe("bash.sh");
				expect(pre?.tool).toBe("bash");
				expect(pre?.type).toBe("pre");

				const post = result.items.find(h => h.type === "post");
				expect(post?.name).toBe("write.bash");
				expect(post?.tool).toBe("write");
				expect(post?.type).toBe("post");
			} finally {
				await teardown();
			}
		});
	});

	describe("scanMarkdownCommands", () => {
		test("parses markdown commands with frontmatter and namespace prefix", async () => {
			await setup();
			try {
				await fs.writeFile(path.join(tempDir, "deploy.md"), "---\nname: custom-deploy\n---\nDeploy body");
				await fs.writeFile(path.join(tempDir, "status.md"), "Status body");

				const withFm = await scanMarkdownCommands(tempDir, "test-prov", "user", {
					parseFrontmatter: true,
					prefix: "my-plugin",
				});
				expect(withFm.items).toHaveLength(2);
				const deploy = withFm.items.find(c => c.path.endsWith("deploy.md"));
				expect(deploy?.name).toBe("my-plugin:custom-deploy");
				expect(deploy?.content).toBe("Deploy body");
				const status = withFm.items.find(c => c.path.endsWith("status.md"));
				expect(status?.name).toBe("my-plugin:status");
				expect(status?.content).toBe("Status body");
			} finally {
				await teardown();
			}
		});
	});
});
