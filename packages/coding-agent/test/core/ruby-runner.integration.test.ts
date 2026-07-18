/**
 * End-to-end exercise of the subprocess-backed Ruby runner.
 *
 * Gated by `VEYYON_RUBY_INTEGRATION=1` so CI without a real Ruby interpreter
 * (or sandboxes where subprocess spawning is restricted) does not fail.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { disposeAllRubyKernelSessions, executeRubyWithKernel } from "@veyyon/coding-agent/eval/rb/executor";
import { RubyKernel } from "@veyyon/coding-agent/eval/rb/kernel";
import { TempDir } from "@veyyon/utils";

const SHOULD_RUN = Bun.env.VEYYON_RUBY_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)("ruby runner subprocess", () => {
	afterEach(async () => {
		await disposeAllRubyKernelSessions();
	});

	it("streams stdout chunks as they are produced", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-stream-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const chunks: string[] = [];
			const result = await executeRubyWithKernel(kernel, "5.times { |i| puts i }", {
				onChunk: chunk => {
					chunks.push(chunk);
				},
			});
			expect(result.exitCode).toBe(0);
			expect(chunks.join("")).toContain("0\n");
			expect(chunks.join("")).toContain("4\n");
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(process.platform === "win32")("runs in its own POSIX session", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-session-isolation-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executeRubyWithKernel(kernel, 'puts "#{Process.getsid(0)} #{Process.pid}"', {});
			const [sessionId, processId] = result.output.trim().split(/\s+/).map(Number);
			expect(sessionId).toBe(processId);
		} finally {
			await kernel.shutdown();
		}
	});

	it("keeps local variables across cells on one kernel", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-state-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const first = await executeRubyWithKernel(kernel, "x = 41", {});
			expect(first.exitCode).toBe(0);
			const second = await executeRubyWithKernel(kernel, "x + 1", {});
			expect(second.exitCode).toBe(0);
			expect(second.output).toContain("42");
		} finally {
			await kernel.shutdown();
		}
	});

	it("auto-displays the last expression but suppresses assignments", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-display-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const assigned = await executeRubyWithKernel(kernel, "y = { a: 1, b: [2, 3] }", {});
			expect(assigned.displayOutputs).toHaveLength(0);

			const expr = await executeRubyWithKernel(kernel, "y", {});
			const json = expr.displayOutputs.find(o => o.type === "json");
			expect(json).toBeDefined();
			if (json?.type === "json") {
				expect(json.data).toEqual({ a: 1, b: [2, 3] });
			}
		} finally {
			await kernel.shutdown();
		}
	});

	it("renders to_veyyon_mime bundles, accepting to_omp_mime as the legacy name", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-mime-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const primary = await executeRubyWithKernel(
				kernel,
				'class VeyyonCard; def to_veyyon_mime; { "text/markdown" => "**veyyon primary**" }; end; end; VeyyonCard.new',
				{},
			);
			expect(primary.exitCode).toBe(0);
			expect(primary.output).toContain("veyyon primary");
			expect(primary.displayOutputs.some(o => o.type === "markdown")).toBe(true);

			// Pre-rebrand notebooks may still implement the old hook name.
			const legacy = await executeRubyWithKernel(
				kernel,
				'class OmpCard; def to_omp_mime; { "text/markdown" => "**legacy accepted**" }; end; end; OmpCard.new',
				{},
			);
			expect(legacy.exitCode).toBe(0);
			expect(legacy.output).toContain("legacy accepted");
			expect(legacy.displayOutputs.some(o => o.type === "markdown")).toBe(true);

			// When both exist, the veyyon name wins.
			const both = await executeRubyWithKernel(
				kernel,
				'class BothCard; def to_veyyon_mime; { "text/markdown" => "**new name wins**" }; end; def to_omp_mime; { "text/markdown" => "**old name lost**" }; end; end; BothCard.new',
				{},
			);
			expect(both.output).toContain("new name wins");
			expect(both.output).not.toContain("old name lost");
		} finally {
			await kernel.shutdown();
		}
	});

	it("cancels a running cell via signal and keeps the kernel usable", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-cancel-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const controller = new AbortController();
			// Real delay: this interrupts a live OS subprocess mid-`sleep`, which runs on
			// the platform clock — fake timers cannot drive it. Abort once the cell is in flight.
			setTimeout(() => controller.abort(), 300);
			const cancelled = await executeRubyWithKernel(kernel, "sleep 30", { signal: controller.signal });
			expect(cancelled.cancelled).toBe(true);

			const after = await executeRubyWithKernel(kernel, "20 + 22", {});
			expect(after.exitCode).toBe(0);
			expect(after.output).toContain("42");
		} finally {
			await kernel.shutdown();
		}
	});

	it("does not write an already-aborted request and keeps the kernel usable", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-preabort-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const controller = new AbortController();
			controller.abort();
			const cancelled = await executeRubyWithKernel(kernel, 'File.write("aborted.txt", "nope")', {
				signal: controller.signal,
			});
			expect(cancelled.cancelled).toBe(true);

			const sideEffect = await executeRubyWithKernel(kernel, 'File.exist?("aborted.txt")', {});
			expect(sideEffect.exitCode).toBe(0);
			expect(sideEffect.output).toContain("false");

			const after = await executeRubyWithKernel(kernel, "20 + 22", {});
			expect(after.exitCode).toBe(0);
			expect(after.output).toContain("42");
		} finally {
			await kernel.shutdown();
		}
	});

	it("surfaces Ruby errors with a non-zero exit and the message", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-error-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executeRubyWithKernel(kernel, "raise 'boom'", {});
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("boom");
		} finally {
			await kernel.shutdown();
		}
	});

	it("surfaces Ruby and child-process stderr in output", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-stderr-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executeRubyWithKernel(
				kernel,
				[
					'$stderr.print("ruby stderr\\n")',
					'STDERR.print("constant stderr\\n")',
					'require "rbconfig"',
					'system(RbConfig.ruby, "-e", \'STDERR.print("child stderr\\\\n"); STDOUT.print("child stdout\\\\n")\')',
				].join("\n"),
				{},
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("ruby stderr\n");
			expect(result.output).toContain("constant stderr\n");
			expect(result.output).toContain("child stderr\n");
			expect(result.output).toContain("child stdout\n");
		} finally {
			await kernel.shutdown();
		}
	});

	it("exposes prelude file helpers", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-prelude-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const written = await executeRubyWithKernel(kernel, 'write("note.txt", "hello"); read("note.txt")', {});
			expect(written.output).toContain("hello");
		} finally {
			await kernel.shutdown();
		}
	});
});
