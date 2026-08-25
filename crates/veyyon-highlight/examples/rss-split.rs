//! Where the resident cost of a syntax set actually goes, old shape vs new.
//!
//! The old shape assembled the set per process: load syntect's bundled pack,
//! `into_builder()` to fold three vendored syntaxes in, `build()` to relink.
//! The new shape loads one dump that `build.rs` already linked. This example
//! runs both and reports what each leaves resident.
//!
//! Both arms run in their own child process, because RSS is cumulative: two
//! arms in one process would charge the second for the first's pages. The
//! parent re-executes itself, so one command produces both numbers and they
//! cannot drift apart.
//!
//! ```sh
//! cargo run -p veyyon-highlight --profile local --example rss-split
//! ```
//!
//! `--profile local` rather than `--release`: the numbers are allocator
//! behaviour, not codegen, and a debug build inflates every one of them.

use std::{env, process::Command};

use syntect::parsing::{SyntaxDefinition, SyntaxSet};
use veyyon_highlight::{Palette, highlight_with};

const EXTRA_SYNTAXES: &[(&str, &str)] = &[
	("Julia", include_str!("../src/syntaxes/Julia.sublime-syntax")),
	("Nix", include_str!("../src/syntaxes/Nix.sublime-syntax")),
	("Mermaid", include_str!("../src/syntaxes/Mermaid.sublime-syntax")),
];

/// Resident set size in bytes, from the kernel rather than an allocator
/// counter: the question is what the process is charged for, which a
/// heap-tracking figure cannot answer.
fn rss_bytes() -> u64 {
	let statm = std::fs::read_to_string("/proc/self/statm")
		.expect("this example reads /proc, so it runs on Linux only");
	let resident_pages: u64 = statm
		.split_whitespace()
		.nth(1)
		.and_then(|f| f.parse().ok())
		.expect("/proc/self/statm always has a resident-pages field");
	// SAFETY: `_SC_PAGESIZE` takes no pointer and cannot fail for a constant
	// the platform defines.
	let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
	resident_pages * page.unsigned_abs()
}

/// Ask glibc to return free arena pages to the kernel.
///
/// Without this, memory freed by `into_builder`'s copy still counts against RSS
/// and reads as if the final set were holding it. The addon never calls this,
/// so the untrimmed figure is the one a session actually pays.
fn trim() {
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	// SAFETY: `malloc_trim` takes a byte count and touches only allocator
	// bookkeeping; no live allocation is reachable from it.
	unsafe {
		libc::malloc_trim(0);
	}
}

fn mb(bytes: u64) -> f64 {
	bytes as f64 / (1024.0 * 1024.0)
}

struct Step {
	label: &'static str,
	rss:   u64,
}

/// Record the current RSS under `label`.
fn mark(label: &'static str, steps: &mut Vec<Step>) {
	steps.push(Step { label, rss: rss_bytes() });
}

/// The shape this change replaced: assemble the set in-process.
fn arm_old() -> Vec<Step> {
	let mut steps = Vec::new();
	mark("process start", &mut steps);

	let defaults = SyntaxSet::load_defaults_newlines();
	mark("load_defaults_newlines", &mut steps);

	let mut builder = defaults.into_builder();
	mark("into_builder (clones every context)", &mut steps);

	for (name, src) in EXTRA_SYNTAXES {
		let def = SyntaxDefinition::load_from_str(src, true, None)
			.unwrap_or_else(|e| panic!("vendored syntax {name} does not parse: {e}"));
		builder.add(def);
	}
	mark("add 3 vendored syntaxes", &mut steps);

	let set = builder.build();
	mark("build (relinks everything)", &mut steps);

	assert!(set.find_syntax_by_name("Nix").is_some(), "old arm must reach the vendored syntaxes");
	highlight_once(&set, &mut steps);

	// Untrimmed is what the addon pays, trimmed is what the set genuinely
	// holds. Reporting both is the only way to tell a large set from an arena
	// nobody handed back.
	trim();
	mark("malloc_trim", &mut steps);

	steps
}

/// The shape this change introduces: deserialise one build-time dump.
fn arm_new() -> Vec<Step> {
	let mut steps = Vec::new();
	mark("process start", &mut steps);

	let set = veyyon_highlight::syntax_set();
	mark("load embedded dump", &mut steps);

	assert!(set.find_syntax_by_name("Nix").is_some(), "new arm must reach the vendored syntaxes");
	highlight_once(set, &mut steps);

	trim();
	mark("malloc_trim", &mut steps);

	steps
}

/// One real highlight pass, so both arms are charged for syntect's lazy regex
/// compilation. Without this the arms measure set construction alone and
/// understate the floor a session pays: syntect holds each context's regex in a
/// `OnceCell` and compiles it on first use, not at load.
fn highlight_once(set: &SyntaxSet, steps: &mut Vec<Step>) {
	const CODE: &str = "fn main() {\n\tlet x = 42; // the answer\n\tprintln!(\"{x}\");\n}\n";
	let palette = Palette {
		comment:     "\x1b[90m",
		keyword:     "\x1b[35m",
		function:    "\x1b[34m",
		variable:    "\x1b[37m",
		string:      "\x1b[32m",
		number:      "\x1b[33m",
		type_name:   "\x1b[36m",
		operator:    "\x1b[37m",
		punctuation: "\x1b[37m",
		inserted:    "\x1b[32m",
		deleted:     "\x1b[31m",
	};
	let out = highlight_with(set, CODE, Some("rust"), &palette);
	assert!(
		out.contains("\x1b[35m"),
		"the highlight pass produced no colours, so it proved nothing"
	);
	mark("first highlight (compiles regexes)", steps);
}

fn report(arm: &str, steps: &[Step]) {
	println!("\n=== {arm} ===");
	println!("{:<40} {:>9}  {:>9}", "step", "RSS MB", "delta MB");
	let mut prev = steps[0].rss;
	for step in steps {
		let delta = step.rss as i64 - prev as i64;
		println!(
			"{:<40} {:>9.1}  {:>+9.1}",
			step.label,
			mb(step.rss),
			delta as f64 / (1024.0 * 1024.0)
		);
		prev = step.rss;
	}

	let start = steps.first().expect("marked at least once").rss;
	let peak = steps
		.iter()
		.map(|s| s.rss)
		.max()
		.expect("marked at least once");
	let settled = steps.last().expect("marked at least once").rss;

	println!("  peak over baseline      {:>8.1} MB", mb(peak.saturating_sub(start)));
	println!(
		"  untrimmed over baseline {:>8.1} MB   <- what a session pays",
		mb(steps[steps.len() - 2].rss.saturating_sub(start))
	);
	println!(
		"  trimmed over baseline   {:>8.1} MB   <- what the set holds",
		mb(settled.saturating_sub(start))
	);
}

fn main() {
	match env::args().nth(1).as_deref() {
		Some("old") => report("old: assembled per process", &arm_old()),
		Some("new") => report("new: build-time dump", &arm_new()),
		// No arm named: run each in its own process so neither is charged for
		// the other's pages.
		_ => {
			let exe = env::current_exe().expect("a running example has a path");
			for arm in ["old", "new"] {
				let status = Command::new(&exe)
					.arg(arm)
					.status()
					.unwrap_or_else(|e| panic!("cannot re-execute for the {arm} arm: {e}"));
				assert!(status.success(), "the {arm} arm failed: {status}");
			}
		},
	}
}
