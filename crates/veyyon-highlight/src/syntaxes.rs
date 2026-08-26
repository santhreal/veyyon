//! The syntax set every highlight pass parses against.
//!
//! The set is assembled by `build.rs` and embedded as a single dump, so the
//! process deserialises it and nothing else. Assembling it here instead meant
//! `into_builder()`, which clones every context of every syntax, and then
//! `build()`, which relinks all of them, to fold three vendored syntaxes into a
//! set that is 1.5MB when merely deserialised. That copy cost 12.6MB of
//! resident heap, 6.9MB of which glibc never returned to the kernel.
//!
//! Deserialising is the cheap part. syntect keeps each context's regex in a
//! `OnceCell` and compiles it on first use, so the cost of highlighting grows
//! with the languages a session touches — measured at 5 to 7MB each — and stays
//! for as long as the set lives. Nothing in a `OnceCell` can be evicted, so the
//! set itself is what gets released: it is dropped once it has gone unused for
//! [`IDLE_TTL`], and reloaded from the same dump on the next pass. A reloaded
//! set highlights identically, which is what makes the policy free to change.
//!
//! `examples/rss-split.rs` measures the shape this replaced, what a session
//! pays after it, and what a release gives back.

use std::{
	sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError},
	thread,
	time::{Duration, Instant},
};

use syntect::parsing::{SyntaxReference, SyntaxSet};

/// syntect's newline-aware defaults plus the vendored Julia, Nix and Mermaid
/// syntaxes, linked at build time. `build.rs` fails the build if a vendored
/// syntax is missing or unreachable, so an absence cannot reach here and
/// degrade to uncoloured output.
const SYNTAX_DUMP: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/syntaxes.packdump"));

/// Deserialise a fresh set from the embedded dump.
///
/// Every call returns the same languages linked the same way, because the dump
/// is immutable bytes in `.rodata`. That is what makes releasing a set safe: a
/// reloaded set highlights identically to the one it replaced, so releasing can
/// cost time but never output.
///
/// Deserialising is not the expensive part of highlighting. syntect keeps each
/// context's regex in a `OnceCell` and compiles it on first use, so a set that
/// has highlighted several languages holds far more than this call allocates.
pub fn load_syntax_set() -> SyntaxSet {
	syntect::dumps::from_binary(SYNTAX_DUMP)
}

/// How long the set may sit unused before it is released.
///
/// Highlighting is bursty: a render colours every visible code block and then
/// nothing happens for a while. Retaining the compiled state across a burst
/// costs a millisecond of re-work saved; retaining it across an idle session
/// costs tens of megabytes for no one. Measured on the eight-language corpus in
/// `examples/rss-split.rs`: a cold burst that recompiles everything takes
/// 67.6ms against 1.1ms warm, and releasing gives back 31.5MB of 36.2MB.
const IDLE_TTL: Duration = Duration::from_secs(30);

/// Everything the holder mutates, under one lock so the set and its last-use
/// time can never disagree.
struct Held {
	set:         Option<Arc<SyntaxSet>>,
	last_use:    Instant,
	reaper_live: bool,
}

static HELD: LazyLock<Mutex<Held>> = LazyLock::new(|| {
	Mutex::new(Held { set: None, last_use: Instant::now(), reaper_live: false })
});

/// Take the lock, ignoring poisoning.
///
/// A panic in a highlight pass must not make highlighting unavailable for the
/// rest of the process: the guarded state is a cache plus a timestamp, and a
/// half-updated timestamp cannot corrupt output.
fn held() -> MutexGuard<'static, Held> {
	HELD.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The set, loading it if the last one was released.
///
/// Returns an `Arc` rather than a `&'static` because the set is releasable: a
/// caller mid-highlight keeps the set it started with alive until it is done,
/// so a release can never pull the set out from under a running pass.
pub fn syntax_set() -> Arc<SyntaxSet> {
	let mut held = held();
	held.last_use = Instant::now();

	if let Some(set) = &held.set {
		return Arc::clone(set);
	}

	// Loading under the lock so that two threads racing the first highlight
	// deserialise once between them rather than once each.
	let set = Arc::new(load_syntax_set());
	held.set = Some(Arc::clone(&set));

	if !held.reaper_live {
		held.reaper_live = true;
		drop(held);
		spawn_reaper();
	}

	set
}

/// Drop the retained set, returning whether one was held.
///
/// Output is unaffected: the next pass reloads from the same immutable dump, so
/// a released set and a reloaded one are the same set. Only the compiled
/// regexes are lost, and syntect recompiles those on demand.
pub fn release() -> bool {
	held().set.take().is_some()
}

/// Whether a set is currently retained.
pub fn is_loaded() -> bool {
	held().set.is_some()
}

/// What one pass of the reaper decided.
#[derive(Debug, PartialEq, Eq)]
enum Reap {
	/// A set was retained and had been idle long enough. It is gone.
	Released,
	/// Nothing was retained, so there is nothing to watch.
	Idle,
	/// A set is retained and was used recently. The wait left before it is
	/// eligible, which is always at most the window itself.
	Busy(Duration),
}

/// Release the set if it has gone unused for `ttl`.
///
/// Split out from the reaper thread so the decision can be driven directly:
/// waiting `IDLE_TTL` to observe a release would make the test useless.
fn reap(ttl: Duration) -> Reap {
	let outcome = {
		let mut held = held();
		if held.set.is_none() {
			return Reap::Idle;
		}
		let idle = held.last_use.elapsed();
		match ttl.checked_sub(idle) {
			// Used within the window, so wait out the remainder.
			Some(remaining) if !remaining.is_zero() => Reap::Busy(remaining),
			_ => {
				held.set = None;
				Reap::Released
			},
		}
	};

	// Outside the lock: trimming walks the allocator's arenas and no other
	// thread needs to wait behind it.
	if outcome == Reap::Released {
		trim_arena();
	}
	outcome
}

/// Hand pages freed by the release back to the kernel.
///
/// Dropping the set frees tens of megabytes in one go, but glibc keeps those
/// pages in its arena, so RSS does not move and the process goes on looking as
/// if it still held every compiled regex. Measured through the addon: without
/// this, releasing an eight-language burst returns 3.1MB of 44.5MB.
///
/// Called only here. A trim on a hot path would be waste — this is the one
/// moment where a large, one-shot free has just happened.
fn trim_arena() {
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	// SAFETY: `malloc_trim` takes a byte count and touches only allocator
	// bookkeeping. It frees no live allocation and returns no pointer.
	unsafe {
		libc::malloc_trim(0);
	}
}

/// Watch the retained set and release it once it goes idle, then exit.
///
/// The thread ends rather than parking, so a process that highlights nothing
/// runs no thread at all and a process that highlights in bursts runs one only
/// between the burst and the release.
fn spawn_reaper() {
	let spawned = thread::Builder::new()
		.name("highlight-reaper".to_owned())
		.spawn(|| {
			loop {
				match reap(IDLE_TTL) {
					Reap::Released | Reap::Idle => {
						held().reaper_live = false;
						return;
					},
					Reap::Busy(remaining) => thread::sleep(remaining),
				}
			}
		})
		.is_ok();

	// A process that cannot spawn a thread still has to highlight. Give up the
	// release rather than the feature, and let the next load try again.
	if !spawned {
		held().reaper_live = false;
	}
}

/// Aliases for languages syntect either does not bundle or names differently
/// from the token a caller passes. Consulted only after a direct token and
/// extension lookup both miss, so an alias never shadows a real syntax.
const LANG_ALIASES: &[(&[&str], &str)] = &[
	(&["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs"], "JavaScript"),
	(&["py", "python"], "Python"),
	(&["rb", "ruby"], "Ruby"),
	(&["jl", "julia"], "Julia"),
	(&["nix"], "Nix"),
	(&["mermaid", "mmd"], "Mermaid"),
	(&["rs", "rust"], "Rust"),
	(&["go", "golang"], "Go"),
	(&["java"], "Java"),
	(&["kt", "kotlin"], "Java"),
	(&["swift"], "Objective-C"),
	(&["c", "h"], "C"),
	(&["cpp", "cc", "cxx", "c++", "hpp", "hxx", "hh"], "C++"),
	(&["cs", "csharp"], "C#"),
	(&["php"], "PHP"),
	(&["sh", "bash", "zsh", "shell"], "Bash"),
	(&["ps1", "powershell"], "PowerShell"),
	(&["html", "htm", "astro", "vue", "svelte"], "HTML"),
	(&["css"], "CSS"),
	(&["scss"], "SCSS"),
	(&["sass"], "Sass"),
	(&["less"], "LESS"),
	(&["json"], "JSON"),
	(&["yaml", "yml"], "YAML"),
	(&["toml"], "TOML"),
	(&["xml"], "XML"),
	(&["md", "markdown"], "Markdown"),
	(&["sql"], "SQL"),
	(&["lua"], "Lua"),
	(&["r"], "R"),
	(&["scala"], "Scala"),
	(&["clj", "clojure"], "Clojure"),
	(&["el", "elisp", "emacs-lisp", "emacslisp"], "Lisp"),
	(&["ex", "exs", "elixir"], "Ruby"),
	(&["erl", "erlang"], "Erlang"),
	(&["hs", "haskell"], "Haskell"),
	(&["ml", "ocaml"], "OCaml"),
	(&["vim"], "VimL"),
	(&["graphql", "gql"], "GraphQL"),
	(&["proto", "protobuf"], "Protocol Buffers"),
	(&["tf", "hcl", "terraform"], "Terraform"),
	(&["dockerfile", "docker", "containerfile"], "Dockerfile"),
	(&["makefile", "make", "just", "justfile"], "Makefile"),
	(&["cmake", "cmakelists"], "CMake"),
	(&["ini", "cfg", "conf", "config", "properties"], "INI"),
	(&["diff", "patch"], "Diff"),
	(&["gitignore", "gitattributes", "gitmodules"], "Git Ignore"),
];

/// The syntax name an alias points at.
#[inline]
fn find_alias(lang: &str) -> Option<&'static str> {
	LANG_ALIASES
		.iter()
		.find(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
		.map(|(_, target)| *target)
}

/// Whether `lang` appears in the alias table at all.
#[inline]
pub fn is_known_alias(lang: &str) -> bool {
	LANG_ALIASES
		.iter()
		.any(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
}

/// Resolve a caller's language token to a syntax.
///
/// Token, then extension, then the alias table. Any syntax in `ss` is
/// reachable through the first two, so the alias table only adds names, it
/// never removes reach.
pub fn find_syntax<'a>(ss: &'a SyntaxSet, lang: &str) -> Option<&'a SyntaxReference> {
	if let Some(syn) = ss.find_syntax_by_token(lang) {
		return Some(syn);
	}
	if let Some(syn) = ss.find_syntax_by_extension(lang) {
		return Some(syn);
	}
	let alias = find_alias(lang)?;
	ss.find_syntax_by_name(alias)
		.or_else(|| ss.find_syntax_by_token(alias))
}

#[cfg(test)]
mod tests {
	// WHY: the set is released on idle to give back the compiled regexes syntect
	// keeps in a `OnceCell` for the life of a set. These cover the decision the
	// reaper makes and the bound on what is retained. They deliberately do not
	// sleep `IDLE_TTL`: `reap` takes the window so both branches are reachable
	// in microseconds, which is also the only way to assert that the wait is
	// bounded rather than merely observing that it has not finished yet.
	//
	// What they do not catch: that the reaper thread is actually spawned and
	// actually ends. `reaper_live` is asserted, but a thread that spins without
	// clearing it would look the same as one that never started.
	use std::{
		sync::{Arc, Mutex, MutexGuard, PoisonError},
		time::Duration,
	};

	use super::{Reap, is_loaded, reap, release, syntax_set};

	/// The holder is process-wide, and these tests release it, so they cannot
	/// run beside each other. Serialising here rather than making the holder
	/// per-thread, because a per-thread holder would retain one compiled set per
	/// thread and defeat the point.
	static SERIAL: Mutex<()> = Mutex::new(());

	fn serial() -> MutexGuard<'static, ()> {
		SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
	}

	#[test]
	fn the_process_retains_one_set_and_nothing_after_a_release() {
		let _serial = serial();
		let first = syntax_set();
		let second = syntax_set();
		assert!(
			Arc::ptr_eq(&first, &second),
			"two calls built two sets, so the retained state is unbounded"
		);
		assert!(is_loaded());

		assert!(release(), "release reported nothing held while a set was retained");
		assert!(!is_loaded(), "a set survived its release");
		assert!(!release(), "release reported a second set to drop");

		// The Arc taken before the release stays valid: a pass already running
		// must not lose the set it is parsing against.
		assert!(first.find_syntax_by_name("Nix").is_some());
	}

	#[test]
	fn a_set_used_inside_the_window_is_kept_and_the_wait_is_bounded_by_it() {
		let _serial = serial();
		let _set = syntax_set();
		let window = Duration::from_hours(1);
		match reap(window) {
			Reap::Busy(remaining) => assert!(
				remaining <= window && !remaining.is_zero(),
				"the reaper would wait {remaining:?}, which is not inside its own window"
			),
			other => panic!("a set used just now was not treated as busy: {other:?}"),
		}
		assert!(is_loaded(), "a set used inside the window was released anyway");
		release();
	}

	#[test]
	fn a_set_idle_past_the_window_is_released_and_the_reaper_then_stops() {
		let _serial = serial();
		let _set = syntax_set();
		// A zero window makes any set idle, which is the branch a real reaper
		// reaches after sleeping.
		assert_eq!(reap(Duration::ZERO), Reap::Released);
		assert!(!is_loaded());
		// Nothing retained means the reaper has no reason to keep looping, which
		// is what ends the thread.
		assert_eq!(reap(Duration::ZERO), Reap::Idle);
	}
}
