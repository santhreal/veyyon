//! Where the resident cost of a syntax set actually goes.
//!
//! Loading syntect's bundled pack and folding three vendored syntaxes into it
//! costs around seventeen megabytes of resident heap for the life of the
//! process. That figure alone does not say what to change, because three
//! different things are inside it:
//!
//! 1. the deserialised default pack,
//! 2. the copy `into_builder` makes of every context of every syntax,
//! 3. the freshly linked set `build` returns.
//!
//! Steps 2 and 3 are freed before the set is first used, so whether they are
//! still charged to the process depends on whether the allocator returned the
//! pages. This example reports each step separately and then calls
//! `malloc_trim`, which distinguishes a set that is genuinely large from an
//! arena that was never handed back.
//!
//! Run with:
//!
//! ```sh
//! cargo run -p veyyon-highlight --profile local --example rss-split
//! ```
//!
//! `--profile local` rather than `--release`: the numbers are allocator
//! behaviour, not codegen, and a debug build inflates every one of them.

use syntect::parsing::{SyntaxDefinition, SyntaxSet};

const EXTRA_SYNTAXES: &[(&str, &str)] = &[
	("Julia", include_str!("../src/syntaxes/Julia.sublime-syntax")),
	("Nix", include_str!("../src/syntaxes/Nix.sublime-syntax")),
	("Mermaid", include_str!("../src/syntaxes/Mermaid.sublime-syntax")),
];

/// Resident set size in bytes, from the kernel rather than from an allocator
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

/// Ask glibc to return free arena pages to the kernel. Without this, memory
/// freed by `into_builder`'s copy still counts against RSS and reads as if the
/// final set were holding it.
fn trim() {
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	// SAFETY: `malloc_trim` takes a byte count and touches only allocator
	// bookkeeping; no live allocation is reachable from it.
	unsafe {
		libc::malloc_trim(0);
	}
}

struct Steps {
	label: &'static str,
	rss:   u64,
}

/// Record the current RSS under `label`.
fn mark(label: &'static str, steps: &mut Vec<Steps>) {
	steps.push(Steps { label, rss: rss_bytes() });
}

fn mb(bytes: u64) -> f64 {
	bytes as f64 / (1024.0 * 1024.0)
}

fn main() {
	let mut steps: Vec<Steps> = Vec::new();
	mark("process start", &mut steps);

	let defaults = SyntaxSet::load_defaults_newlines();
	let default_count = defaults.syntaxes().len();
	mark("after load_defaults_newlines", &mut steps);

	let mut builder = defaults.into_builder();
	mark("after into_builder (clones every context)", &mut steps);

	for (_, src) in EXTRA_SYNTAXES {
		if let Ok(def) = SyntaxDefinition::load_from_str(src, true, None) {
			builder.add(def);
		}
	}
	mark("after adding 3 vendored syntaxes", &mut steps);

	let full = builder.build();
	let full_count = full.syntaxes().len();
	mark("after build (relinks everything)", &mut steps);

	trim();
	mark("after malloc_trim", &mut steps);

	// What one self-contained syntax costs on its own. Nix is vendored here and
	// embeds nothing, so this is a floor for a per-language set: a syntax that
	// embeds others (HTML, Markdown) additionally carries their contexts.
	let mut single = SyntaxSet::load_defaults_newlines().into_builder();
	single = {
		let nix = SyntaxDefinition::load_from_str(EXTRA_SYNTAXES[1].1, true, None)
			.expect("vendored Nix syntax must parse");
		let mut fresh = syntect::parsing::SyntaxSetBuilder::new();
		fresh.add(nix);
		drop(single);
		fresh
	};
	let nix_only = single.build();
	trim();
	let after_single = rss_bytes();

	println!("\n{:<46} {:>10}  {:>10}", "step", "RSS MB", "delta MB");
	let mut prev = steps[0].rss;
	for step in &steps {
		let delta = step.rss as i64 - prev as i64;
		println!(
			"{:<46} {:>10.1}  {:>+10.1}",
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

	println!("\nsyntaxes: {default_count} bundled, {full_count} after vendoring");
	println!("peak over baseline:    {:>8.1} MB", mb(peak.saturating_sub(start)));
	println!(
		"settled over baseline: {:>8.1} MB   <- what the process keeps",
		mb(settled.saturating_sub(start))
	);
	println!(
		"transient (freed):     {:>8.1} MB   <- what into_builder + build cost while running",
		mb(peak.saturating_sub(settled))
	);
	println!(
		"\nNix-only set ({} syntax): settled {:.1} MB over baseline",
		nix_only.syntaxes().len(),
		mb(after_single.saturating_sub(start))
	);
}
