import { describe, expect, it } from "bun:test";
import { buildPluginDirRoot } from "@veyyon/coding-agent/discovery/plugin-dir-roots";

/**
 * buildPluginDirRoot synthesizes a plugin root for a --plugin-dir path so a locally
 * pointed directory looks like a marketplace-installed plugin to the rest of the
 * loader. The synthetic identity must be stable: the "__local__" marketplace and
 * "local" version are what let downstream code recognize (and never try to update)
 * a local plugin, and the name falls back to the directory basename when no manifest
 * name is given. A regression in these constants would make a local plugin collide
 * with a real marketplace entry or be treated as updatable.
 */

describe("buildPluginDirRoot", () => {
	it("uses the manifest name and stamps the local identity", () => {
		expect(buildPluginDirRoot("/abs/plugins/foo", "MyPlugin")).toEqual({
			id: "MyPlugin@__local__",
			marketplace: "__local__",
			plugin: "MyPlugin",
			version: "local",
			path: "/abs/plugins/foo",
			scope: "user",
		});
	});

	it("falls back to the directory basename when no manifest name is given", () => {
		expect(buildPluginDirRoot("/abs/plugins/foo-bar")).toEqual({
			id: "foo-bar@__local__",
			marketplace: "__local__",
			plugin: "foo-bar",
			version: "local",
			path: "/abs/plugins/foo-bar",
			scope: "user",
		});
	});

	it("treats an empty manifest name as absent and uses the basename", () => {
		expect(buildPluginDirRoot("/abs/plugins/foo-bar", "").plugin).toBe("foo-bar");
	});
});
