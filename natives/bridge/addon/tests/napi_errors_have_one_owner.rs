//! A Rust error becomes a JavaScript message in one place.
//!
//! WHY THIS SUITE EXISTS. Every fallible export in this crate ends at
//! `napi::Error`, and each one used to build that error itself: 86 call sites
//! across sixteen modules, over two shapes written out by hand. Fifteen were
//! `Error::from_reason(err.to_string())`, the error's own message passed
//! straight through; thirty-four were `Error::from_reason(format!("<context>:
//! {err}"))`, the operation named in front of it. So the convention that a
//! wrapped message reads `context, colon, space, reason` was a habit rather
//! than code, and nothing stopped the next module from inventing `context -
//! reason` or `[context] reason`. `src/napi_error.rs` owns both shapes now.
//!
//! This is a source scan rather than a behavioural test, because what it guards
//! against compiles and passes: a new `Error::from_reason(err.to_string())` is
//! valid Rust that does the right thing today and is one more place to change
//! tomorrow. Nothing in the language or the build notices a second copy of a
//! convention.
//!
//! What it deliberately does NOT forbid is `from_reason` itself. A message that
//! is composed rather than wrapped -- a path in the middle of a sentence, two
//! values joined, a constant with no error behind it -- has no shape for a
//! helper to own, and forcing those through a mapper would either lose the
//! context or need a helper per message. The rule is narrower and checkable:
//! nobody re-implements the two shapes the owner already has.
//!
//! Every pattern is proved to match something real before the rule is applied,
//! so a scan that stopped finding files fails here rather than passing by
//! finding nothing.

use std::{
	fs,
	path::{Path, PathBuf},
};

/// This crate's `src` directory.
fn src_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// The module allowed to build the two wrapped shapes.
const OWNER: &str = "napi_error.rs";

/// Every `.rs` file under `src`, recursively, with its path relative to `src`.
fn sources() -> Vec<(String, String)> {
	fn walk(dir: &PathBuf, prefix: &str, out: &mut Vec<(String, String)>) {
		let entries = fs::read_dir(dir).expect("the crate's src directory should be readable");
		for entry in entries {
			let entry = entry.expect("a directory entry should be readable");
			let path = entry.path();
			let name = entry.file_name().to_string_lossy().into_owned();
			let relative = if prefix.is_empty() {
				name.clone()
			} else {
				format!("{prefix}/{name}")
			};
			if path.is_dir() {
				walk(&path, &relative, out);
			} else if Path::new(&name)
				.extension()
				.is_some_and(|ext| ext.eq_ignore_ascii_case("rs"))
			{
				let text = fs::read_to_string(&path).expect("a Rust source file should be readable");
				out.push((relative, text));
			}
		}
	}

	let mut out = Vec::new();
	walk(&src_dir(), "", &mut out);
	out.sort();
	out
}

/// The bare shape: an error VALUE's `Display` handed straight to `from_reason`.
///
/// The value has to be a binding rather than a literal, and the difference is
/// not academic: `from_reason("a message".to_string())` matched the loose
/// version of this pattern, and it is not this shape at all. It is a constant
/// message with a redundant conversion, which the helper has no business owning
/// (the conversion was removed where it was found, since `from_reason` takes
/// `impl Into<String>`).
fn bare_stringify_sites(text: &str) -> Vec<String> {
	text
		.lines()
		.filter(|line| {
			let Some(start) = line.find("Error::from_reason(") else {
				return false;
			};
			let after_open = &line[start + "Error::from_reason(".len()..];
			let Some(argument) = after_open.split(".to_string())").next() else {
				return false;
			};
			after_open.contains(".to_string())")
				&& !argument.is_empty()
				&& !argument.contains('"')
				&& argument
					.chars()
					.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '&' | '(' | ')'))
		})
		.map(|line| line.trim().to_string())
		.collect()
}

/// The wrapped shape: `format!("<something>: {ident}")` inside `from_reason`,
/// with no other interpolation, which is exactly what [`to_napi_with`] builds.
fn hand_wrapped_sites(text: &str) -> Vec<String> {
	text
		.lines()
		.filter(|line| {
			let Some(start) = line.find("Error::from_reason(format!(\"") else {
				return false;
			};
			let rest = &line[start..];
			// One interpolation, at the end, after a `: ` separator.
			rest.contains(": {") && rest.matches('{').count() == 1
		})
		.map(|line| line.trim().to_string())
		.collect()
}

/// The scan reaches the whole crate.
///
/// Without this, every rule below is satisfied by a walk that found nothing,
/// which is the failure mode of a source scan.
#[test]
fn the_scan_reads_the_whole_crate() {
	let files = sources();

	assert!(
		files.len() >= 25,
		"the crate has more than 25 Rust files; the scan found {}",
		files.len()
	);
	assert!(
		files.iter().any(|(name, _)| name == OWNER),
		"the owner module is part of the scan: {:?}",
		files.iter().map(|(name, _)| name).collect::<Vec<_>>()
	);
	for expected in ["grep.rs", "ast.rs", "pty.rs", "iofs.rs"] {
		assert!(files.iter().any(|(name, _)| name == expected), "{expected} should be in the scan");
	}
	assert!(
		files
			.iter()
			.any(|(name, text)| name == "grep.rs" && text.contains("to_napi_with(")),
		"grep.rs should reach the owner, or the repoint was lost"
	);
}

/// Both patterns match a real line, checked against the owner's own body.
///
/// The rule is stated as the code it looks for, so the owner matches it.
/// Proving the match here is what keeps the two rules below from passing
/// because a pattern stopped matching anything at all.
#[test]
fn both_patterns_match_the_shapes_they_describe() {
	let owner = sources()
		.into_iter()
		.find(|(name, _)| name == OWNER)
		.expect("the owner module should exist")
		.1;

	// The owner builds each shape once and its tests compare against the
	// expressions they replaced, so the count is "at least one" and the point is
	// that the pattern matches real code at all.
	assert!(!bare_stringify_sites(&owner).is_empty(), "the owner builds the bare shape");
	assert!(!hand_wrapped_sites(&owner).is_empty(), "and the wrapped shape");
	assert!(
		bare_stringify_sites(&owner)
			.iter()
			.any(|line| line.contains("err.to_string()")),
		"and it is the error's own Display that goes through"
	);

	// And neither pattern is so loose that it matches an ordinary call.
	assert!(bare_stringify_sites("let name = value.to_string();").is_empty());
	assert!(
		bare_stringify_sites(r#"Error::from_reason("a constant message".to_string())"#).is_empty(),
		"a constant message with a redundant conversion is not an error being wrapped"
	);
	assert!(hand_wrapped_sites("Error::from_reason(format!(\"no interpolation here\"))").is_empty());
	assert!(
		hand_wrapped_sites("Error::from_reason(format!(\"{} at {}: {err}\", a, b))").is_empty(),
		"a composed message with several values is not the wrapped shape"
	);
}

/// Nobody else stringifies an error into a message.
#[test]
fn only_the_owner_passes_an_errors_display_straight_through() {
	let offenders: Vec<String> = sources()
		.into_iter()
		.filter(|(name, _)| name != OWNER)
		.flat_map(|(name, text)| {
			bare_stringify_sites(&text)
				.into_iter()
				.map(move |line| format!("{name}: {line}"))
		})
		.collect();

	assert!(
		offenders.is_empty(),
		"use `napi_error::to_napi(err)` instead of building the error here:\n{}",
		offenders.join("\n")
	);
}

/// And nobody else writes the `context: reason` join by hand.
#[test]
fn only_the_owner_joins_a_context_to_a_reason() {
	let offenders: Vec<String> = sources()
		.into_iter()
		.filter(|(name, _)| name != OWNER)
		.flat_map(|(name, text)| {
			hand_wrapped_sites(&text)
				.into_iter()
				.map(move |line| format!("{name}: {line}"))
		})
		.collect();

	assert!(
		offenders.is_empty(),
		"use `napi_error::to_napi_with(context, err)` instead of formatting the join here:\n{}",
		offenders.join("\n")
	);
}

/// The walker error keeps its own mapper, and there is only one of it.
///
/// `iofs::map_walker_error` is a specialist: the walker has two failure kinds
/// and they take different shapes, so it decides between them and then calls
/// the owner. It used to be two functions with different names and the same
/// body, which is the same duplication in miniature.
#[test]
fn the_walker_mapper_is_a_single_specialist_that_calls_the_owner() {
	let iofs = sources()
		.into_iter()
		.find(|(name, _)| name == "iofs.rs")
		.expect("iofs.rs should exist")
		.1;

	assert_eq!(
		iofs.matches("fn map_walker_error").count(),
		1,
		"one definition of the walker mapper"
	);
	assert!(
		!iofs.contains("fn walker_error_to_napi"),
		"the second name for the same body should be gone"
	);
	assert!(
		iofs.contains("to_napi(err)") && iofs.contains("to_napi_with("),
		"and it should build both shapes through the owner"
	);
}
