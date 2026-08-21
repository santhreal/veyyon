//! The per-subsystem generation plans: the axes a subsystem is swept over, the
//! contracts its cases discharge, and the entry point each case requires.
//!
//! A plan is data, not code, for one reason: the manifest fixes how many cases
//! a subsystem owns, and the only way to fill that number honestly is with a
//! combinatorial sweep whose axes are declared and countable. The suite asserts
//! that every plan's axis product is at least its allocation, so a subsystem
//! cannot reach its count by repeating a tuple, and it asserts that every
//! subsystem in the manifest has a plan.
//!
//! # Entries are required, not resolved
//!
//! `direct_entry` names the production Rust entry point a direct case calls.
//! Naming it is not a claim that it exists: most of the behaviour the corpus
//! covers is still TypeScript, and issue #877 forbids covering it with a Rust
//! reimplementation. [`RESOLVED_ENTRIES`] is the set the conformance driver can
//! actually call today, and it is empty, because the driver has no dependency
//! on a production crate yet. Every direct row is therefore migration debt, and
//! [`migration_debt`] counts it rather than letting a materialized corpus imply
//! executable coverage.

use crate::corpus::{Subsystem, manifest};

/// One dimension of a sweep.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Axis {
	pub name:   &'static str,
	pub values: &'static [&'static str],
}

impl Axis {
	const fn new(name: &'static str, values: &'static [&'static str]) -> Self {
		Self { name, values }
	}

	/// How many values the axis carries.
	#[must_use]
	pub const fn len(&self) -> usize {
		self.values.len()
	}

	/// Never true: an axis with no value would collapse the sweep.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.values.is_empty()
	}
}

/// How one subsystem's cases are generated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
	pub subsystem:      Subsystem,
	/// Family id stamped into `generator.family`.
	pub family:         &'static str,
	/// The production Rust entry a direct case calls.
	pub direct_entry:   &'static str,
	/// The artifact a compiled-product case launches.
	pub compiled_entry: &'static str,
	pub axes:           &'static [Axis],
	/// Contract ids, cycled across the subsystem's cases.
	pub contracts:      &'static [&'static str],
	/// Structured error ids, one per non-clean value of the [`FAULT_AXIS`], in
	/// that axis's order. The pairing is positional and asserted, so a case's
	/// expected error is a function of the failure its dimensions inject and
	/// never of a counter.
	pub errors:         &'static [&'static str],
	/// Requirement ids every case of this subsystem discharges.
	pub requirements:   &'static [&'static str],
}

/// The axis whose value decides whether a row is an expected-error case.
pub const FAULT_AXIS: &str = "fault";

/// The one value of the fault axis that injects nothing.
///
/// A row holding this value must complete; every other value names the failure
/// the row injects and pins the diagnostic the product must answer with.
pub const CLEAN: &str = "none";

impl Plan {
	/// How many distinct dimension tuples the axes can produce.
	#[must_use]
	pub fn tuple_space(&self) -> usize {
		self
			.axes
			.iter()
			.fold(1, |product, axis| product.saturating_mul(axis.len()))
	}

	/// The cases the manifest allocates to this subsystem.
	#[must_use]
	pub const fn allocation(&self) -> manifest::SubsystemAllocation {
		manifest::allocation_of(self.subsystem)
	}

	/// Position of the fault axis in [`Self::axes`].
	///
	/// # Panics
	///
	/// When the plan declares no fault axis. Every plan must: it is the axis
	/// that decides whether a row is an expected-error case, and a plan without
	/// one could only pick its errors arbitrarily.
	#[must_use]
	pub fn fault_axis_index(&self) -> usize {
		self
			.axes
			.iter()
			.position(|axis| axis.name == FAULT_AXIS)
			.expect("every plan declares a fault axis")
	}

	/// The fault axis itself.
	#[must_use]
	pub fn fault_axis(&self) -> Axis {
		self.axes[self.fault_axis_index()]
	}

	/// The error id the fault value at `slot` injects, counting from the first
	/// non-clean value.
	#[must_use]
	pub fn error_at(&self, slot: usize) -> &'static str {
		self.errors[slot % self.errors.len()]
	}

	/// How many distinct tuples exist with the fault axis held at [`CLEAN`].
	///
	/// The bound a subsystem's success cases are drawn from: they all hold the
	/// fault axis clean, so the rest of the product is the whole space they
	/// have, and it has to be at least `cases - expected_errors`.
	#[must_use]
	pub fn clean_space(&self) -> usize {
		let fault = self.fault_axis_index();
		self
			.axes
			.iter()
			.enumerate()
			.filter(|(index, _)| *index != fault)
			.fold(1, |product, (_, axis)| product.saturating_mul(axis.len()))
	}
}

/// The production entry points the conformance driver can call today.
///
/// Empty. The crate depends on no production crate, so no direct case is
/// executable yet, and pretending otherwise is how a corpus comes to describe
/// coverage nobody has. An entry joins this list in the same change that adds
/// the dependency and the driver call.
pub static RESOLVED_ENTRIES: [&str; 0] = [];

/// Direct cases whose entry point the driver cannot call yet.
///
/// The accounting identity is `migration_debt() + resolved ==
/// DIRECT_RUST_CASES`, asserted by the suite, so this number cannot be quietly
/// improved by dropping rows.
#[must_use]
pub fn migration_debt() -> usize {
	let resolved: usize = PLANS
		.iter()
		.filter(|plan| RESOLVED_ENTRIES.contains(&plan.direct_entry))
		.map(|plan| direct_cases(plan.allocation().cases))
		.sum();
	manifest::DIRECT_RUST_CASES - resolved
}

/// Direct-target cases in an allocation of `cases`.
///
/// The split is arithmetic on the manifest rather than a per-plan number: 2% of
/// every subsystem launches the compiled product, matching the corpus-wide
/// 5,000 of 250,000, and the rest runs in process.
#[must_use]
pub const fn direct_cases(cases: usize) -> usize {
	cases - compiled_cases(cases)
}

/// Compiled-product cases in an allocation of `cases`.
#[must_use]
pub const fn compiled_cases(cases: usize) -> usize {
	cases / 50
}

/// Cases of one target kind that a single named platform receives.
#[must_use]
pub const fn per_platform_cases(cases: usize) -> usize {
	cases / 250
}

/// The plan for `subsystem`.
///
/// An exhaustive match rather than a search, so a seventeenth subsystem fails
/// to compile here instead of materializing zero cases.
#[must_use]
pub const fn plan_for(subsystem: Subsystem) -> &'static Plan {
	match subsystem {
		Subsystem::RenderingTerminalUi => &PLANS[0],
		Subsystem::AiProvidersStreaming => &PLANS[1],
		Subsystem::ToolExecutionRuntime => &PLANS[2],
		Subsystem::SessionTreeEngine => &PLANS[3],
		Subsystem::PersistenceMnemopi => &PLANS[4],
		Subsystem::ConcurrencyAgentMesh => &PLANS[5],
		Subsystem::SecuritySandbox => &PLANS[6],
		Subsystem::CliEngineModes => &PLANS[7],
		Subsystem::InstallersDistribution => &PLANS[8],
		Subsystem::NativeServicesWorkers => &PLANS[9],
		Subsystem::ConfigurationSettings => &PLANS[10],
		Subsystem::ContextCompaction => &PLANS[11],
		Subsystem::MemoryEngineVectors => &PLANS[12],
		Subsystem::EditingHashlineEngine => &PLANS[13],
		Subsystem::LspClientDiagnostics => &PLANS[14],
		Subsystem::WireProtocolArgot => &PLANS[15],
	}
}

/// Every plan, in manifest order.
pub static PLANS: [Plan; 16] = [
	Plan {
		subsystem:      Subsystem::RenderingTerminalUi,
		family:         "rendering-terminal-matrix",
		direct_entry:   "veyyon_natives::text::render",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("width", &["20", "40", "60", "80", "100", "120", "160", "200", "300", "400"]),
			Axis::new("height", &["5", "10", "24", "30", "40", "60", "80", "120"]),
			Axis::new("content", &[
				"ascii",
				"wide-cjk",
				"emoji-zwj",
				"combining",
				"tabs",
				"long-path",
				"raw-control",
				"rtl",
				"box-drawing",
				"mixed",
			]),
			Axis::new("motion", &["enabled", "reduced", "disabled"]),
			Axis::new("path", &["stream", "rebuild", "resize", "scrollback", "overflow"]),
			Axis::new("ground", &["grey", "black"]),
			Axis::new("fault", &[
				"none",
				"dimension-rejected",
				"invisible-fill",
				"illegible-text",
				"grid-overflow",
				"invalid-sequence",
				"zero-width-cell",
				"scroll-region-invalid",
				"raster-mismatch",
			]),
		],
		contracts:      &[
			"render.cell-grid.exact",
			"render.dual-ground.legible",
			"render.width.unicode",
			"render.wrap.deferred",
			"render.resize.reflow",
			"render.stream-rebuild.equivalent",
			"render.clip.bounded",
			"render.sanitize.control-bytes",
		],
		errors:         &[
			"render.dimension-rejected",
			"render.invisible-fill",
			"render.illegible-text",
			"render.grid-overflow",
			"render.invalid-sequence",
			"render.zero-width-cell",
			"render.scroll-region-invalid",
			"render.raster-mismatch",
		],
		requirements:   &["dual-ground-evidence", "unicode-width-exact", "bounded-clip"],
	},
	Plan {
		subsystem:      Subsystem::AiProvidersStreaming,
		family:         "provider-terminal-matrix",
		direct_entry:   "veyyon_provider::stream::decode",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("api", &[
				"openai-completions",
				"openai-responses",
				"anthropic-messages",
				"google-gemini",
				"ollama",
				"openai-compat",
			]),
			Axis::new("framing", &[
				"lf-sse",
				"crlf-sse",
				"comment-records",
				"multi-data-fields",
				"one-event-per-chunk",
				"many-events-per-chunk",
				"json-split",
				"utf8-split",
				"http1-chunked",
				"h2-data-frames",
			]),
			Axis::new("outputShape", &[
				"empty",
				"whitespace-only",
				"text",
				"reasoning-only",
				"reasoning-then-text",
				"one-tool-call",
				"parallel-tool-calls",
				"missing-tool-id",
				"missing-tool-name",
				"truncated-arguments",
				"malformed-arguments",
				"interleaved-text-tools",
				"interleaved-reasoning-tools",
				"out-of-order-deltas",
			]),
			Axis::new("terminal", &[
				"finish-stop",
				"finish-tool-calls",
				"finish-length",
				"content-filter",
				"refusal",
				"done-only",
				"done-with-terminal",
				"clean-eof",
				"empty-eof",
				"socket-open-after-terminal",
			]),
			Axis::new("fault", &[
				"none",
				"incomplete-stream",
				"malformed-event",
				"invalid-utf8",
				"tool-call-incomplete",
				"rate-limited",
				"unauthorized",
				"upstream-unavailable",
				"first-event-timeout",
				"next-event-timeout",
				"retry-exhausted",
			]),
			Axis::new("transport", &["http1", "http1-chunked", "h2c", "h2-tls"]),
		],
		contracts:      &[
			"provider.clean-eof.self-contained",
			"provider.clean-eof.complete-tool-batch",
			"provider.reasoning-only.recovers",
			"provider.empty-eof.retryable",
			"provider.transport-error.preserved",
			"provider.incomplete-tool.never-executes",
			"provider.parallel-batch.order-preserved",
			"provider.terminal-frame.bounded",
			"provider.retry.no-duplicate-output",
			"provider.history.delivered-attempt-only",
		],
		errors:         &[
			"provider.incomplete-stream",
			"provider.malformed-event",
			"provider.invalid-utf8",
			"provider.tool-call-incomplete",
			"provider.rate-limited",
			"provider.unauthorized",
			"provider.upstream-unavailable",
			"provider.first-event-timeout",
			"provider.next-event-timeout",
			"provider.retry-exhausted",
		],
		requirements:   &[
			"provider-terminal-completeness",
			"tool-arguments-complete",
			"bounded-termination",
			"replay-safety",
		],
	},
	Plan {
		subsystem:      Subsystem::ToolExecutionRuntime,
		family:         "tool-lifecycle-matrix",
		direct_entry:   "veyyon_tools::dispatch::execute",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("tool", &[
				"read", "write", "edit", "bash", "grep", "glob", "eval", "launch", "task", "todo",
				"irc", "debug",
			]),
			Axis::new("arguments", &[
				"valid",
				"missing-required",
				"wrong-type",
				"unknown-extra",
				"empty",
				"truncated",
				"primitive",
				"array",
				"object",
				"malformed",
			]),
			Axis::new("permission", &[
				"allowed",
				"denied",
				"prompt-approved",
				"prompt-rejected",
				"sandboxed",
			]),
			Axis::new("lifecycle", &[
				"completes",
				"errors",
				"times-out",
				"cancelled-before-start",
				"cancelled-running",
				"streams",
				"partial-arguments",
				"double-settle-attempt",
			]),
			Axis::new("workspace", &["clean", "dirty", "read-only", "missing"]),
			Axis::new("concurrency", &["serial", "parallel-2", "parallel-8"]),
			Axis::new("fault", &[
				"none",
				"arguments-invalid",
				"permission-denied",
				"timeout",
				"cancelled",
				"not-found",
				"workspace-escape",
				"output-too-large",
				"already-settled",
			]),
		],
		contracts:      &[
			"tool.schema-rejection.before-side-effect",
			"tool.settles-exactly-once",
			"tool.cancellation.bounded",
			"tool.timeout.bounded",
			"tool.permission.enforced",
			"tool.streaming.preview-consistent",
			"tool.parallel.independent",
			"tool.workspace.contained",
		],
		errors:         &[
			"tool.arguments-invalid",
			"tool.permission-denied",
			"tool.timeout",
			"tool.cancelled",
			"tool.not-found",
			"tool.workspace-escape",
			"tool.output-too-large",
			"tool.already-settled",
		],
		requirements:   &["validation-before-execution", "settles-once", "bounded-termination"],
	},
	Plan {
		subsystem:      Subsystem::SessionTreeEngine,
		family:         "session-tree-walk",
		direct_entry:   "veyyon_session::tree::apply",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("operation", &[
				"append",
				"fork",
				"switch",
				"resume",
				"compact",
				"retry-replace",
				"branch-delete",
				"interrupt-batch",
				"crash-recover",
				"stale-load",
			]),
			Axis::new("depth", &["1", "2", "3", "4", "8", "16", "32", "64"]),
			Axis::new("breadth", &["1", "2", "4", "8", "16"]),
			Axis::new("persistence", &["fresh", "resumed", "migrated", "corrupted", "truncated"]),
			Axis::new("state", &["idle", "streaming", "tool-pending", "compacting"]),
			Axis::new("version", &["current", "previous", "unknown"]),
			Axis::new("fault", &[
				"none",
				"stale-schema",
				"corrupt-record",
				"missing-parent",
				"branch-not-found",
				"compaction-empty",
				"retry-conflict",
				"truncated-log",
				"cycle-detected",
			]),
		],
		contracts:      &[
			"session.fork.parent-preserved",
			"session.switch.path-to-root",
			"session.compact.keeps-a-turn",
			"session.retry.replaces-not-appends",
			"session.crash.recovers-last-committed",
			"session.stale-version.rejected",
			"session.interrupted-batch.settles",
			"session.resume.equivalent-state",
		],
		errors:         &[
			"session.stale-schema",
			"session.corrupt-record",
			"session.missing-parent",
			"session.branch-not-found",
			"session.compaction-empty",
			"session.retry-conflict",
			"session.truncated-log",
			"session.cycle-detected",
		],
		requirements:   &["persisted-version-rejection", "tree-reachability", "replay-safety"],
	},
	Plan {
		subsystem:      Subsystem::PersistenceMnemopi,
		family:         "persistence-state-matrix",
		direct_entry:   "veyyon_store::sqlite::apply",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("operation", &[
				"insert",
				"update",
				"delete",
				"query",
				"migrate",
				"vacuum",
				"checkpoint",
				"restore",
				"compact",
				"reindex",
			]),
			Axis::new("schema", &[
				"current",
				"previous",
				"two-behind",
				"next",
				"future-minor",
				"unknown",
			]),
			Axis::new("size", &["empty", "one", "small", "large", "huge"]),
			Axis::new("fault", &[
				"none",
				"stale-schema",
				"disk-full",
				"read-only",
				"locked",
				"checksum-mismatch",
				"constraint-violation",
				"corrupt-page",
				"migration-failed",
			]),
			Axis::new("concurrency", &["single", "two-writers", "reader-writer"]),
			Axis::new("durability", &["wal", "truncate", "memory"]),
			Axis::new("transaction", &["none", "single", "batched", "nested"]),
			Axis::new("index", &["fresh", "stale", "absent"]),
		],
		contracts:      &[
			"persistence.version.rejects-stale",
			"persistence.write.atomic",
			"persistence.lock.bounded-wait",
			"persistence.migration.idempotent",
			"persistence.restore.round-trips",
			"persistence.checkpoint.durable",
			"persistence.query.exact",
			"persistence.delete.cascades",
		],
		errors:         &[
			"persistence.stale-schema",
			"persistence.disk-full",
			"persistence.read-only",
			"persistence.locked",
			"persistence.checksum-mismatch",
			"persistence.constraint-violation",
			"persistence.corrupt-page",
			"persistence.migration-failed",
		],
		requirements:   &["persisted-version-rejection", "atomic-write", "bounded-termination"],
	},
	Plan {
		subsystem:      Subsystem::ConcurrencyAgentMesh,
		family:         "mesh-scheduling-matrix",
		direct_entry:   "veyyon_mesh::scheduler::step",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("workers", &["1", "2", "3", "4", "8", "16", "32"]),
			Axis::new("event", &[
				"spawn",
				"message",
				"steering",
				"cancel",
				"crash",
				"restart",
				"shutdown",
				"timeout",
				"backpressure",
				"drain",
			]),
			Axis::new("queue", &["empty", "one", "full", "overflowing"]),
			Axis::new("ordering", &["fifo", "reordered", "duplicated", "dropped"]),
			Axis::new("lock", &["uncontended", "contended", "inverted", "held-across-await"]),
			Axis::new("deadline", &["none", "short", "long", "elapsed"]),
			Axis::new("fault", &[
				"none",
				"queue-overflow",
				"peer-gone",
				"deadline-exceeded",
				"deadlock-detected",
				"worker-crashed",
				"cancelled",
				"duplicate-delivery",
				"spawn-refused",
			]),
		],
		contracts:      &[
			"mesh.message.ordered-per-peer",
			"mesh.cancel.bounded",
			"mesh.crash.restarts-once",
			"mesh.shutdown.drains",
			"mesh.lock.no-inversion",
			"mesh.backpressure.bounded-queue",
			"mesh.deadline.enforced",
			"mesh.spawn.cap-respected",
		],
		errors:         &[
			"mesh.queue-overflow",
			"mesh.peer-gone",
			"mesh.deadline-exceeded",
			"mesh.deadlock-detected",
			"mesh.worker-crashed",
			"mesh.cancelled",
			"mesh.duplicate-delivery",
			"mesh.spawn-refused",
		],
		requirements:   &["bounded-termination", "lock-order", "message-ordering"],
	},
	Plan {
		subsystem:      Subsystem::SecuritySandbox,
		family:         "security-boundary-matrix",
		direct_entry:   "veyyon_natives::workspace::contain",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("vector", &[
				"path-traversal",
				"symlink-escape",
				"hardlink",
				"absolute-path",
				"unc-path",
				"null-byte",
				"case-collision",
				"long-path",
				"device-file",
				"dotfile",
			]),
			Axis::new("credential", &["absent", "env", "file", "header", "token-placeholder"]),
			Axis::new("approval", &["required", "granted", "denied", "expired"]),
			Axis::new("payload", &[
				"clean",
				"malicious-ansi",
				"malformed-archive",
				"checksum-mismatch",
				"oversized",
			]),
			Axis::new("mount", &["workspace", "temp", "home", "system", "readonly"]),
			Axis::new("platform-shape", &["posix", "windows", "macos-case-insensitive"]),
			Axis::new("fault", &[
				"none",
				"path-escape",
				"symlink-escape",
				"credential-leak",
				"approval-missing",
				"checksum-mismatch",
				"archive-malformed",
				"permission-denied",
				"payload-too-large",
			]),
		],
		contracts:      &[
			"security.path.contained",
			"security.symlink.not-followed-out",
			"security.credential.redacted",
			"security.approval.enforced",
			"security.archive.rejected-when-malformed",
			"security.checksum.fails-closed",
			"security.ansi.sanitized",
			"security.mount.readonly-respected",
		],
		errors:         &[
			"security.path-escape",
			"security.symlink-escape",
			"security.credential-leak",
			"security.approval-missing",
			"security.checksum-mismatch",
			"security.archive-malformed",
			"security.permission-denied",
			"security.payload-too-large",
		],
		requirements:   &["path-containment", "credential-redaction", "fail-closed"],
	},
	Plan {
		subsystem:      Subsystem::CliEngineModes,
		family:         "cli-mode-matrix",
		direct_entry:   "veyyon_cli::dispatch::run",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("command", &[
				"run",
				"chat",
				"config",
				"stats",
				"export",
				"resume",
				"doctor",
				"update",
				"completions",
				"help",
			]),
			Axis::new("argv", &["valid", "missing-value", "unknown-flag", "conflicting", "empty"]),
			Axis::new("stdio", &["tty", "piped-in", "piped-out", "both-piped"]),
			Axis::new("mode", &["interactive", "print", "json", "quiet"]),
			Axis::new("signal", &["none", "sigint", "sigterm", "eof", "resize"]),
			Axis::new("exit-shape", &["success", "usage-error", "runtime-error", "interrupted"]),
			Axis::new("fault", &[
				"none",
				"usage-invalid",
				"unknown-command",
				"missing-argument",
				"conflicting-flags",
				"interrupted",
				"not-a-tty",
				"config-invalid",
				"command-failed",
			]),
		],
		contracts:      &[
			"cli.argv.usage-error-exits-two",
			"cli.stdio.detects-pipe",
			"cli.signal.exits-bounded",
			"cli.json-mode.machine-readable",
			"cli.help.lists-every-command",
			"cli.exit-code.matches-outcome",
			"cli.completions.stable",
			"cli.quiet.no-stdout-noise",
		],
		errors:         &[
			"cli.usage-invalid",
			"cli.unknown-command",
			"cli.missing-argument",
			"cli.conflicting-flags",
			"cli.interrupted",
			"cli.not-a-tty",
			"cli.config-invalid",
			"cli.command-failed",
		],
		requirements:   &["exit-code-contract", "bounded-termination", "registry-enumerated"],
	},
	Plan {
		subsystem:      Subsystem::InstallersDistribution,
		family:         "install-artifact-matrix",
		direct_entry:   "veyyon_release::artifact::select",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("script", &[
				"install-sh",
				"install-ps1",
				"updater",
				"uninstall",
				"resolve-latest",
				"verify-checksum",
			]),
			Axis::new("platform-shape", &[
				"linux-x64",
				"linux-arm64",
				"darwin-x64",
				"darwin-arm64",
				"windows-x64",
			]),
			Axis::new("release", &[
				"complete",
				"missing-asset",
				"missing-sha",
				"stale-metadata",
				"prerelease",
			]),
			Axis::new("fault", &[
				"none",
				"checksum-mismatch",
				"asset-missing",
				"unsupported-platform",
				"network-failed",
				"disk-full",
				"permission-denied",
				"interrupted",
				"stale-metadata",
			]),
			Axis::new("state", &["fresh", "upgrade", "same-version", "downgrade", "reinstall"]),
			Axis::new("link", &["path-linked", "path-absent", "conflicting-binary"]),
			Axis::new("shell", &["sh", "bash", "dash", "zsh", "powershell"]),
		],
		contracts:      &[
			"install.checksum.fails-closed",
			"install.asset.matches-platform",
			"install.interrupt.leaves-no-partial",
			"install.upgrade.replaces-atomically",
			"install.link.reports-path",
			"install.stale-metadata.refetched",
			"install.exit-code.matches-outcome",
			"install.uninstall.removes-everything",
		],
		errors:         &[
			"install.checksum-mismatch",
			"install.asset-missing",
			"install.unsupported-platform",
			"install.network-failed",
			"install.disk-full",
			"install.permission-denied",
			"install.interrupted",
			"install.stale-metadata",
		],
		requirements:   &["checksum-verification", "fail-closed", "exit-code-contract"],
	},
	Plan {
		subsystem:      Subsystem::NativeServicesWorkers,
		family:         "worker-lifecycle-matrix",
		direct_entry:   "veyyon_natives::pty::spawn",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("worker", &[
				"stats-sync",
				"tab",
				"js-eval",
				"tiny-inference",
				"grep",
				"glob",
				"highlight",
				"pty",
			]),
			Axis::new("phase", &[
				"spawn", "ready", "message", "cancel", "crash", "restart", "shutdown", "orphaned",
			]),
			Axis::new("host", &["source", "bundle", "compiled-binary", "embedded"]),
			Axis::new("payload", &["small", "large", "binary", "invalid-utf8", "empty"]),
			Axis::new("fault", &[
				"none",
				"spawn-failed",
				"handshake-timeout",
				"killed",
				"protocol-invalid",
				"orphaned",
				"payload-too-large",
				"selector-unknown",
				"restart-exhausted",
			]),
			Axis::new("platform-shape", &["posix", "windows"]),
			Axis::new("transport", &[
				"argv-selector",
				"module-fallback",
				"ipc",
				"shared-buffer",
				"stdio",
			]),
		],
		contracts:      &[
			"worker.spawn.reenters-entrypoint",
			"worker.ready.handshake-bounded",
			"worker.message.ordered",
			"worker.crash.restarts-once",
			"worker.shutdown.no-orphan",
			"worker.cancel.bounded",
			"worker.payload.binary-safe",
			"worker.selector.dispatches",
		],
		errors:         &[
			"worker.spawn-failed",
			"worker.handshake-timeout",
			"worker.killed",
			"worker.protocol-invalid",
			"worker.orphaned",
			"worker.payload-too-large",
			"worker.selector-unknown",
			"worker.restart-exhausted",
		],
		requirements:   &["worker-host-entry", "bounded-termination", "no-orphan-process"],
	},
	Plan {
		subsystem:      Subsystem::ConfigurationSettings,
		family:         "settings-precedence-matrix",
		direct_entry:   "veyyon_config::resolve::effective",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("source", &[
				"default",
				"profile",
				"project",
				"environment",
				"cli-flag",
				"runtime-write",
			]),
			Axis::new("type", &[
				"boolean",
				"number",
				"enum",
				"string",
				"array",
				"record",
				"model-chain",
			]),
			Axis::new("value", &[
				"default",
				"non-default",
				"boundary-low",
				"boundary-high",
				"invalid",
				"absent",
			]),
			Axis::new("condition", &["unconditional", "gate-on", "gate-off", "gate-toggled"]),
			Axis::new("persistence", &[
				"session-only",
				"written",
				"written-then-reverted",
				"reloaded",
			]),
			Axis::new("scope", &["global", "profile", "project", "session"]),
			Axis::new("fault", &[
				"none",
				"value-invalid",
				"unknown-path",
				"type-mismatch",
				"out-of-range",
				"enum-unknown",
				"write-failed",
				"file-malformed",
				"condition-missing",
			]),
		],
		contracts:      &[
			"settings.precedence.cli-over-project",
			"settings.default.honored",
			"settings.non-default.changes-behaviour",
			"settings.invalid.fails-loud",
			"settings.write.persists-across-restart",
			"settings.condition.hides-dependent",
			"settings.enum.rejects-unknown",
			"settings.write.rebuilds-dependent-state",
		],
		errors:         &[
			"settings.value-invalid",
			"settings.unknown-path",
			"settings.type-mismatch",
			"settings.out-of-range",
			"settings.enum-unknown",
			"settings.write-failed",
			"settings.file-malformed",
			"settings.condition-missing",
		],
		requirements:   &["precedence-order", "loud-invalid-value", "conditional-visibility"],
	},
	Plan {
		subsystem:      Subsystem::ContextCompaction,
		family:         "context-budget-matrix",
		direct_entry:   "veyyon_context::compact::plan",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("budget", &["tiny", "small", "typical", "large", "exhausted"]),
			Axis::new("history", &[
				"empty",
				"text-only",
				"tool-heavy",
				"reasoning-heavy",
				"mixed",
				"one-huge-message",
				"many-small",
				"binary-attachment",
				"image-heavy",
				"already-compacted",
			]),
			Axis::new("trigger", &["threshold", "explicit", "resume", "tool-overflow", "none"]),
			Axis::new("strategy", &["summarize", "drop-oldest", "drop-tool-output", "spill-artifact"]),
			Axis::new("boundary", &["mid-turn", "turn-end", "mid-tool-batch", "after-error"]),
			Axis::new("outcome", &["fits", "still-over", "nothing-to-drop", "refused"]),
			Axis::new("fault", &[
				"none",
				"budget-exceeded",
				"nothing-to-compact",
				"summary-failed",
				"spill-failed",
				"batch-split",
				"attachment-too-large",
				"history-corrupt",
				"refused",
			]),
		],
		contracts:      &[
			"context.compaction.preserves-last-turn",
			"context.compaction.idempotent",
			"context.budget.never-exceeded",
			"context.tool-batch.not-split",
			"context.spill.recoverable",
			"context.resume.matches-live",
			"context.refusal.explains",
			"context.summary.replaces-not-appends",
		],
		errors:         &[
			"context.budget-exceeded",
			"context.nothing-to-compact",
			"context.summary-failed",
			"context.spill-failed",
			"context.batch-split",
			"context.attachment-too-large",
			"context.history-corrupt",
			"context.refused",
		],
		requirements:   &["budget-bound", "batch-atomicity", "resume-equivalence"],
	},
	Plan {
		subsystem:      Subsystem::MemoryEngineVectors,
		family:         "memory-recall-matrix",
		direct_entry:   "veyyon_memory::recall::search",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("operation", &["remember", "recall", "forget", "reindex", "migrate", "export"]),
			Axis::new("corpus-size", &["empty", "one", "hundred", "ten-thousand", "million"]),
			Axis::new("query", &["exact", "fuzzy", "empty", "oversized", "invalid-utf8", "unicode"]),
			Axis::new("embedding", &["present", "absent", "stale", "wrong-dimension"]),
			Axis::new("ranking", &["cosine", "dot", "hybrid", "recency"]),
			Axis::new("fault", &[
				"none",
				"index-corrupt",
				"model-missing",
				"dimension-mismatch",
				"query-invalid",
				"timeout",
				"disk-full",
				"stale-schema",
				"not-found",
			]),
			Axis::new("store", &["sqlite", "memory", "sharded", "readonly", "migrating"]),
		],
		contracts:      &[
			"memory.recall.deterministic-order",
			"memory.embedding.dimension-checked",
			"memory.forget.removes-everything",
			"memory.reindex.idempotent",
			"memory.empty-corpus.answers-empty",
			"memory.query.bounded",
			"memory.migration.versioned",
			"memory.export.round-trips",
		],
		errors:         &[
			"memory.index-corrupt",
			"memory.model-missing",
			"memory.dimension-mismatch",
			"memory.query-invalid",
			"memory.timeout",
			"memory.disk-full",
			"memory.stale-schema",
			"memory.not-found",
		],
		requirements:   &[
			"deterministic-ranking",
			"persisted-version-rejection",
			"bounded-termination",
		],
	},
	Plan {
		subsystem:      Subsystem::EditingHashlineEngine,
		family:         "hashline-patch-grammar",
		direct_entry:   "veyyon_hashline::apply::patch",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("operation", &[
				"swap",
				"swap-block",
				"del",
				"del-block",
				"ins-pre",
				"ins-post",
				"ins-block-post",
				"ins-head",
				"ins-tail",
				"move",
				"remove",
			]),
			Axis::new("anchor", &[
				"fresh",
				"stale-tag",
				"shifted-line",
				"out-of-range",
				"closer-line",
			]),
			Axis::new("file-shape", &[
				"empty",
				"one-line",
				"no-trailing-newline",
				"crlf",
				"tabs",
				"unicode",
				"huge",
			]),
			Axis::new("range", &["single", "multi", "whole-file", "overlapping", "inverted"]),
			Axis::new("body", &["plain", "blank-lines", "leading-plus", "leading-minus", "empty"]),
			Axis::new("language", &["rust", "typescript", "markdown", "json", "plain"]),
			Axis::new("fault", &[
				"none",
				"stale-tag",
				"range-out-of-bounds",
				"overlapping-hunks",
				"block-not-resolvable",
				"body-malformed",
				"file-missing",
				"destination-exists",
				"inverted-range",
			]),
		],
		contracts:      &[
			"hashline.stale-tag.refused",
			"hashline.range.exact-lines",
			"hashline.block.resolves-closer",
			"hashline.insert.does-not-widen",
			"hashline.crlf.preserved",
			"hashline.trailing-newline.preserved",
			"hashline.overlapping-hunks.refused",
			"hashline.move.applies-edits-first",
		],
		errors:         &[
			"hashline.stale-tag",
			"hashline.range-out-of-bounds",
			"hashline.overlapping-hunks",
			"hashline.block-not-resolvable",
			"hashline.body-malformed",
			"hashline.file-missing",
			"hashline.destination-exists",
			"hashline.inverted-range",
		],
		requirements:   &["anchor-integrity", "byte-exact-apply", "fail-closed"],
	},
	Plan {
		subsystem:      Subsystem::LspClientDiagnostics,
		family:         "lsp-protocol-matrix",
		direct_entry:   "veyyon_lsp::transport::frame",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("server", &["typescript", "rust-analyzer", "pyright", "gopls", "absent"]),
			Axis::new("message", &[
				"initialize",
				"did-open",
				"did-change",
				"diagnostics",
				"hover",
				"definition",
				"shutdown",
				"exit",
			]),
			Axis::new("framing", &[
				"exact",
				"split-header",
				"split-body",
				"missing-content-length",
				"oversized",
				"utf8-split",
			]),
			Axis::new("fault", &[
				"none",
				"framing-invalid",
				"server-crashed",
				"timeout",
				"malformed-json",
				"unknown-method",
				"not-initialized",
				"server-missing",
				"restart-exhausted",
			]),
			Axis::new("state", &["uninitialized", "initialized", "shutting-down", "restarted"]),
			Axis::new("workspace", &["single-root", "multi-root", "no-root"]),
			Axis::new("transport", &["stdio", "pipe", "socket", "node-ipc"]),
		],
		contracts:      &[
			"lsp.framing.content-length-exact",
			"lsp.crash.restarts-bounded",
			"lsp.diagnostics.mapped-to-file",
			"lsp.unknown-method.answered",
			"lsp.shutdown.ordered",
			"lsp.split-frame.reassembled",
			"lsp.absent-server.degrades",
			"lsp.request.deadline-enforced",
		],
		errors:         &[
			"lsp.framing-invalid",
			"lsp.server-crashed",
			"lsp.timeout",
			"lsp.malformed-json",
			"lsp.unknown-method",
			"lsp.not-initialized",
			"lsp.server-missing",
			"lsp.restart-exhausted",
		],
		requirements:   &["protocol-framing", "bounded-termination", "graceful-degradation"],
	},
	Plan {
		subsystem:      Subsystem::WireProtocolArgot,
		family:         "wire-codec-matrix",
		direct_entry:   "veyyon_wire::codec::decode",
		compiled_entry: "veyyon",
		axes:           &[
			Axis::new("message", &[
				"hello",
				"session-state",
				"tool-call",
				"tool-result",
				"delta",
				"error",
				"ping",
				"bye",
			]),
			Axis::new("encoding", &[
				"utf8",
				"utf8-split",
				"invalid-utf8",
				"oversized",
				"empty",
				"truncated",
			]),
			Axis::new("argot", &["disabled", "handle", "handle-split", "unknown-handle", "nested"]),
			Axis::new("seam", &["tool-args", "display", "stream", "transcript", "subagent-return"]),
			Axis::new("version", &["current", "older", "newer", "unknown"]),
			Axis::new("fault", &[
				"none",
				"malformed-frame",
				"unknown-version",
				"invalid-utf8",
				"too-large",
				"out-of-order",
				"duplicate-message",
				"handle-unresolved",
				"dictionary-missing",
			]),
			Axis::new("role", &["host", "guest", "relay"]),
		],
		contracts:      &[
			"wire.decode.round-trips",
			"wire.version.rejects-unknown",
			"argot.handle.never-reaches-display",
			"argot.split-handle.reassembled",
			"argot.unknown-handle.passes-through",
			"wire.oversized.refused",
			"wire.reorder.detected",
			"wire.error.structured",
		],
		errors:         &[
			"wire.malformed-frame",
			"wire.unknown-version",
			"wire.invalid-utf8",
			"wire.too-large",
			"wire.out-of-order",
			"wire.duplicate-message",
			"argot.handle-unresolved",
			"argot.dictionary-missing",
		],
		requirements:   &["codec-round-trip", "handle-never-leaks", "version-rejection"],
	},
];
