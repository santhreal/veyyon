import { describe, expect, it } from "bun:test";
import { syncYamlTextToSettings } from "../src/yaml-sync";

describe("syncYamlTextToSettings", () => {
	it("returns empty-ish output for empty text and empty target", () => {
		const result = syncYamlTextToSettings("", {});
		expect(result.trim()).toBe("{}");
	});

	it("removes existing key not in target", () => {
		const text = "foo: bar\n";
		const result = syncYamlTextToSettings(text, {});
		expect(result).not.toContain("foo: bar");
	});

	it("adds new key from target while removing old ones", () => {
		const text = "foo: bar\n";
		const result = syncYamlTextToSettings(text, { baz: "qux" });
		expect(result).toContain("baz: qux");
		expect(result).not.toContain("foo: bar");
	});

	it("updates existing key value", () => {
		const text = "foo: bar\n";
		const result = syncYamlTextToSettings(text, { foo: "updated" });
		expect(result).toContain("foo: updated");
		expect(result).not.toContain("foo: bar");
	});

	it("removes key not in target", () => {
		const text = "foo: bar\nbaz: qux\n";
		const result = syncYamlTextToSettings(text, { foo: "bar" });
		expect(result).toContain("foo: bar");
		expect(result).not.toContain("baz");
	});

	it("removes key with undefined value in target", () => {
		const text = "foo: bar\nbaz: qux\n";
		const result = syncYamlTextToSettings(text, { foo: "bar", baz: undefined });
		expect(result).toContain("foo: bar");
		expect(result).not.toContain("baz: qux");
	});

	it("handles nested objects", () => {
		const text = "outer:\n  inner: value\n";
		const result = syncYamlTextToSettings(text, { outer: { inner: "updated" } });
		expect(result).toContain("inner: updated");
	});

	it("adds new nested key", () => {
		const text = "outer:\n  inner: value\n";
		const result = syncYamlTextToSettings(text, { outer: { inner: "value", newKey: "newVal" } });
		expect(result).toContain("newKey: newVal");
		expect(result).toContain("inner: value");
	});

	it("removes nested key not in target", () => {
		const text = "outer:\n  inner: value\n  removed: gone\n";
		const result = syncYamlTextToSettings(text, { outer: { inner: "value" } });
		expect(result).toContain("inner: value");
		expect(result).not.toContain("removed");
	});

	it("handles arrays of same length", () => {
		const text = "items:\n  - one\n  - two\n";
		const result = syncYamlTextToSettings(text, { items: ["one", "updated"] });
		expect(result).toContain("updated");
		expect(result).not.toContain("- two");
	});

	it("replaces array when length changes", () => {
		const text = "items:\n  - one\n  - two\n";
		const result = syncYamlTextToSettings(text, { items: ["one", "two", "three"] });
		expect(result).toContain("three");
	});

	it("handles boolean values", () => {
		const text = "enabled: false\n";
		const result = syncYamlTextToSettings(text, { enabled: true });
		expect(result).toContain("enabled: true");
	});

	it("handles numeric values", () => {
		const text = "count: 5\n";
		const result = syncYamlTextToSettings(text, { count: 42 });
		expect(result).toContain("count: 42");
	});

	it("throws on invalid YAML", () => {
		expect(() => syncYamlTextToSettings("foo: bar\n  bad: indent", {})).toThrow();
	});

	it("throws on non-mapping root (scalar)", () => {
		expect(() => syncYamlTextToSettings("just a string", {})).toThrow();
	});

	it("throws on non-mapping root (array)", () => {
		expect(() => syncYamlTextToSettings("- item1\n- item2\n", {})).toThrow();
	});

	it("preserves comments on keys", () => {
		const text = "# This is a comment\nfoo: bar\n";
		const result = syncYamlTextToSettings(text, { foo: "bar" });
		expect(result).toContain("This is a comment");
	});

	it("preserves comment when deleting a key with comment", () => {
		const text = "# comment for foo\nfoo: bar\nbaz: qux\n";
		const result = syncYamlTextToSettings(text, { baz: "qux" });
		expect(result).toContain("comment for foo");
		expect(result).toContain("baz: qux");
	});

	it("renames root keys with renamedKeys option", () => {
		const text = "oldName: value\n";
		const result = syncYamlTextToSettings(text, { newName: "value" }, { renamedKeys: { oldName: "newName" } });
		expect(result).toContain("newName: value");
		expect(result).not.toContain("oldName");
	});

	it("does not rename if target name already exists", () => {
		const text = "oldName: value1\nnewName: value2\n";
		const result = syncYamlTextToSettings(
			text,
			{ oldName: "value1", newName: "value2" },
			{ renamedKeys: { oldName: "newName" } },
		);
		expect(result).toContain("oldName: value1");
		expect(result).toContain("newName: value2");
	});

	it("handles multiple renames", () => {
		const text = "a: 1\nb: 2\n";
		const result = syncYamlTextToSettings(text, { alpha: 1, beta: 2 }, { renamedKeys: { a: "alpha", b: "beta" } });
		expect(result).toContain("alpha: 1");
		expect(result).toContain("beta: 2");
	});

	it("ignores rename when source key not present", () => {
		const text = "foo: bar\n";
		const result = syncYamlTextToSettings(text, { foo: "bar" }, { renamedKeys: { nonexistent: "new" } });
		expect(result).toContain("foo: bar");
	});
	it("handles deep nested objects", () => {
		const text = "level1:\n  level2:\n    level3: deep\n";
		const result = syncYamlTextToSettings(text, { level1: { level2: { level3: "updated" } } });
		expect(result).toContain("updated");
	});

	it("handles null values", () => {
		const text = "foo: bar\n";
		const result = syncYamlTextToSettings(text, { foo: null });
		expect(result).toContain("foo: null");
	});

	it("does not rewrite unchanged values", () => {
		const text = "foo: bar\n";
		const result = syncYamlTextToSettings(text, { foo: "bar" });
		expect(result).toContain("foo: bar");
	});

	it("handles array of objects with same length", () => {
		const text = "items:\n  - name: first\n  - name: second\n";
		const result = syncYamlTextToSettings(text, { items: [{ name: "first" }, { name: "changed" }] });
		expect(result).toContain("changed");
		expect(result).toContain("first");
	});

	it("handles mixed nested structures", () => {
		const text = "config:\n  name: test\n  values:\n    - one\n    - two\n";
		const result = syncYamlTextToSettings(text, { config: { name: "test", values: ["one", "two"] } });
		expect(result).toContain("name: test");
		expect(result).toContain("- one");
		expect(result).toContain("- two");
	});

	it("adds nested object to existing key", () => {
		const text = "config:\n  name: test\n";
		const result = syncYamlTextToSettings(text, { config: { name: "test", new: "value" } });
		expect(result).toContain("new: value");
	});
});
