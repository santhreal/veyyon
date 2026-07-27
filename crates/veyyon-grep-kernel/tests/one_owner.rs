//! The structural half of the extraction: nothing declares a second compiled
//! matcher.
//!
//! The unit tests next to the type prove it BEHAVES. This file proves it is the
//! ONLY one, which is a different claim and the one that rots. Three engines
//! had each declared `enum CompiledMatcher { Rust(..), Pcre(..) }`
//! independently, and nothing about adding a fourth would have failed a build:
//! the copies were byte-identical, so nobody reading any single file could tell
//! it was shared.
//!
//! A copy is not a style problem here. The three copies were free to drift on
//! which engine a pattern lands on, on whether PCRE2 runs in UTF mode, and on
//! whether a match-time failure is an error or a miss, and every one of those
//! differences changes what a search RETURNS rather than failing loudly.
//!
//! These tests scan the workspace source rather than asking the compiler,
//! because the compiler is perfectly happy with duplication. Each one asserts
//! against a real path so a scan that stopped finding files cannot pass.

use std::{
	fs,
	path::{Path, PathBuf},
};

/// The workspace root, from this crate's own manifest directory.
fn workspace_root() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.and_then(Path::parent)
		.expect("the crate lives two levels under the workspace root")
		.to_path_buf()
}

/// This file's own path, excluded from every scan below.
///
/// Every rule here is expressed as a string that appears in the source it looks
/// for, so this file contains all of them and would flag itself as a violation
/// of each one. Excluding it by name is the honest fix; the alternative,
/// obfuscating the patterns so they do not match here, makes the rules
/// unreadable and is how a detector quietly stops matching the real thing.
const SCANNER: &str = "crates/veyyon-grep-kernel/tests/one_owner.rs";

/// The one crate allowed to declare the shared matcher and its defaults.
const OWNER: &str = "crates/veyyon-grep-kernel/src/lib.rs";

/// The one module allowed to reach for `SearcherBuilder`.
const OWNER_SEARCHER: &str = "crates/veyyon-grep-kernel/src/searcher.rs";

/// Every `.rs` file under `crates/`, excluding the vendored trees, which are
/// read-only snapshots of other people's code and are not ours to unify, and
/// excluding this file; see [`SCANNER`].
fn workspace_sources() -> Vec<(PathBuf, String)> {
	let mut found = Vec::new();
	collect(&workspace_root().join("crates"), &mut found);
	found.retain(|(path, _)| relative(path) != SCANNER);
	found
}

fn collect(dir: &Path, found: &mut Vec<(PathBuf, String)>) {
	let Ok(entries) = fs::read_dir(dir) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		let name = entry.file_name();
		let name = name.to_string_lossy();
		if path.is_dir() {
			if name == "vendor" || name == "target" || name == "node_modules" {
				continue;
			}
			collect(&path, found);
		} else if path.extension().is_some_and(|ext| ext == "rs")
			&& let Ok(source) = fs::read_to_string(&path)
		{
			found.push((path, source));
		}
	}
}

fn relative(path: &Path) -> String {
	path
		.strip_prefix(workspace_root())
		.unwrap_or(path)
		.to_string_lossy()
		.replace('\\', "/")
}

/// NON-VACUITY, first, because every assertion below is of the form "no file
/// does X" and an empty file list answers all of them for free.
///
/// The count is a floor rather than an exact number so that adding a crate does
/// not fail this test, and the named file is the one this crate is about: if
/// the scan cannot find its own source, it cannot find anybody else's either.
#[test]
fn the_scan_really_reads_the_workspace() {
	let sources = workspace_sources();

	assert!(sources.len() > 30, "only {} source files found; the walk is broken", sources.len());
	assert!(
		sources.iter().any(|(path, _)| relative(path) == OWNER),
		"the scan did not find this crate's own source",
	);
	assert!(
		sources
			.iter()
			.any(|(path, _)| relative(path) == "crates/veyyon-natives/src/grep.rs"),
		"the scan did not find the N-API grep engine",
	);
}

/// One declaration of the type, in the crate that owns it.
///
/// Asserted as the LIST of files that declare it rather than as a count, so a
/// failure names the file that re-introduced the copy instead of saying a
/// number changed.
#[test]
fn exactly_one_crate_declares_the_compiled_matcher() {
	let declarers: Vec<String> = workspace_sources()
		.into_iter()
		.filter(|(_, source)| source.contains("enum CompiledMatcher"))
		.map(|(path, _)| relative(&path))
		.collect();

	assert_eq!(
		declarers,
		vec![OWNER.to_string()],
		"CompiledMatcher has one owner; import it from veyyon-grep-kernel instead of redeclaring it",
	);
}

/// And the consumers really consume it, which is the half that proves the
/// extraction happened rather than that the copies were merely deleted.
///
/// All three engines are named explicitly. A consumer that quietly stopped
/// importing the shared type would either have grown a copy, which the test
/// above catches, or dropped an engine, which nothing else here would notice.
#[test]
fn all_three_engines_import_the_shared_matcher() {
	let sources = workspace_sources();

	for expected in [
		"crates/veyyon-natives/src/grep.rs",
		"crates/veyyon-uu-grep/src/lib.rs",
		"crates/veyyon-uu-grep/src/rg.rs",
	] {
		let (_, source) = sources
			.iter()
			.find(|(path, _)| relative(path) == expected)
			.unwrap_or_else(|| panic!("{expected} is missing from the workspace"));

		assert!(
			source.contains("veyyon_grep_kernel::"),
			"{expected} no longer imports the shared matcher",
		);
	}
}

/// The PCRE2 defaults have one owner too, and the reason is worth stating:
/// `utf` and `ucp` decide whether `\w` and `.` mean characters or bytes, so two
/// engines that set them differently return different results for the same
/// pattern and neither one reports a problem. `jit_if_available` is the third
/// of the triple and is the one no caller has any reason to name.
#[test]
fn nobody_but_the_owner_enables_the_pcre_jit() {
	let offenders: Vec<String> = workspace_sources()
		.into_iter()
		.filter(|(path, _)| relative(path) != OWNER)
		.filter(|(_, source)| source.contains("jit_if_available"))
		.map(|(path, _)| relative(&path))
		.collect();

	assert_eq!(
		offenders,
		Vec::<String>::new(),
		"call pcre_matcher_defaults instead of setting utf/ucp/jit yourself",
	);
}

/// NON-VACUITY for the rule above, and the reason every scan-based gate needs
/// one: a typo in the string it looks for makes it pass on a workspace full of
/// violations, and a clean tree cannot tell a working detector from a broken
/// one.
#[test]
fn the_jit_detector_finds_the_owner_that_does_enable_it() {
	let naming: Vec<String> = workspace_sources()
		.into_iter()
		.filter(|(_, source)| source.contains("jit_if_available"))
		.map(|(path, _)| relative(&path))
		.collect();

	assert_eq!(naming, vec![OWNER.to_string()], "only the shared defaults turn the JIT on");
}

/// The unicode halves may be named in exactly one place besides the owner, and
/// that place is written down here rather than left to be rediscovered.
///
/// `rg --no-unicode` turns `utf` and `ucp` back OFF after the shared defaults
/// set them, which is an override of a documented default rather than a second
/// definition of it. Any other file naming them is redefining the contract.
#[test]
fn the_pcre_unicode_switches_have_one_owner_and_one_documented_override() {
	let naming: Vec<String> = workspace_sources()
		.into_iter()
		.filter(|(_, source)| source.contains(".ucp("))
		.map(|(path, _)| relative(&path))
		.collect();

	assert_eq!(
		naming,
		vec![OWNER.to_string(), "crates/veyyon-uu-grep/src/rg.rs".to_string()],
		"the owner and rg's --no-unicode override, in that order; everyone else calls \
		 pcre_matcher_defaults",
	);
}

/// The searcher has one construction site too.
///
/// `SearcherBuilder` has eleven settings and a caller that forgets one gets the
/// library's default silently. That is exactly how three engines ended up with
/// three different answers to "does this search compute line numbers": nobody
/// wrote `line_number(false)`, so everybody paid for line numbers whether or
/// not they printed any.
///
/// The three surfaces keep their own flag vocabularies, which are genuinely
/// different and should not be merged. What they share now is
/// `veyyon_grep_kernel::build_searcher`, and the surfaces translate into its
/// spec.
#[test]
fn only_the_kernel_touches_the_searcher_builder() {
	let offenders: Vec<String> = workspace_sources()
		.into_iter()
		.filter(|(path, _)| relative(path) != OWNER_SEARCHER)
		.filter(|(_, source)| source.contains("SearcherBuilder"))
		.map(|(path, _)| relative(&path))
		.collect();

	assert_eq!(
		offenders,
		Vec::<String>::new(),
		"fill in a SearcherSpec and call veyyon_grep_kernel::build_searcher instead",
	);
}

/// NON-VACUITY for the rule above. Same reason as the JIT twin: a scan that
/// finds nothing proves nothing until you have seen it find the one thing that
/// is really there.
#[test]
fn the_searcher_builder_detector_finds_the_kernel() {
	let naming: Vec<String> = workspace_sources()
		.into_iter()
		.filter(|(_, source)| source.contains("SearcherBuilder"))
		.map(|(path, _)| relative(&path))
		.collect();

	assert_eq!(naming, vec![OWNER_SEARCHER.to_string()], "only the kernel builds a Searcher");
}

/// And all three surfaces really use the shared constructor, which is the
/// positive half: deleting a call site would satisfy every rule above.
#[test]
fn all_three_engines_build_their_searcher_through_the_spec() {
	let sources = workspace_sources();

	for expected in [
		"crates/veyyon-natives/src/grep.rs",
		"crates/veyyon-uu-grep/src/lib.rs",
		"crates/veyyon-uu-grep/src/rg.rs",
	] {
		let (_, source) = sources
			.iter()
			.find(|(path, _)| relative(path) == expected)
			.unwrap_or_else(|| panic!("{expected} is missing from the workspace"));

		assert!(source.contains("SearcherSpec"), "{expected} stopped using the shared searcher spec");
	}
}
