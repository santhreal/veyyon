//! WHY THIS EXISTS.
//!
//! The presentation contract is defined in TypeScript and mirrored by hand in
//! Rust. A hand mirror drifts: someone adds a `TranscriptBlock` member for the
//! terminal, the GUI's deserializer rejects it, and the operator sees a
//! transcript that stops at the new message. Nothing in either language's type
//! system spans the gap, so this test does.
//!
//! THE CLASS IT CLOSES. A member of any tagged union in the contract —
//! transcript block, dialog, event, dialog result — that exists on one side and
//! not the other. Both directions, from the tables the TypeScript declares for
//! exactly this purpose, and from serde's own view of the Rust enums rather
//! than a list a person maintains.
//!
//! WHAT IT DOES NOT CATCH. Field-level drift. A member renamed `durationMs` to
//! `elapsedMs`, or a required field made optional, passes here — the tags still
//! match. Field shapes are covered by the round-trip tests beside each type,
//! which pin the wire bytes, but nothing checks those bytes against the
//! TypeScript declaration. Closing that needs a schema the TypeScript emits.
//!
//! It also cannot see a member that exists in neither place. A block kind the
//! session builder produces without declaring is invisible to both sides.

use std::{
	path::{Path, PathBuf},
	process::Command,
};

use veyyon_gui_contract::{
	UiEvent, fixtures,
	reflect::variants,
	session::{
		overlay::{DialogResult, DialogViewModel},
		transcript::TranscriptBlock,
	},
};

/// Where the contract is declared, relative to the repository root, newest
/// layout first.
///
/// Two roots because the interface layer is moving: the contract is
/// `contracts/wire` where that move has landed and `packages/wire` where it has
/// not. Both are tried in the working tree and then on [`CONTRACT_BRANCH`], so
/// this test is meaningful on either side of the move and needs no edit when it
/// lands. When the old root is gone everywhere, its entry goes with it.
const CONTRACT_ROOTS: [&str; 2] =
	["contracts/wire/src/presentation", "packages/wire/src/presentation"];

/// The branch the contract is on until it merges.
///
/// It is read through git rather than the working tree so this test is
/// meaningful before that merge. Once the path exists in the checkout the
/// working tree wins and this is never consulted; when it can be deleted, the
/// fallback goes with it.
const CONTRACT_BRANCH: &str = "origin/tui-decoupling";

/// Every transcript block kind the TypeScript declares matches every variant
/// serde reports for the Rust enum.
#[test]
fn transcript_block_kinds_agree() {
	compare("transcript.ts", "TRANSCRIPT_BLOCK_KINDS", &variants::<TranscriptBlock>("kind"));
}

#[test]
fn dialog_kinds_agree() {
	compare("overlay.ts", "DIALOG_KINDS", &variants::<DialogViewModel>("kind"));
}

#[test]
fn ui_event_types_agree() {
	compare("events.ts", "UI_EVENT_TYPES", &variants::<UiEvent>("type"));
}

/// `DialogResult` has no exported table on the TypeScript side — it is a bare
/// union — so its members are read out of the union declaration itself.
#[test]
fn dialog_result_outcomes_agree() {
	let source = read("overlay.ts");
	let declared = outcomes(&source);
	let mirrored = variants::<DialogResult>("outcome");
	assert_eq!(declared, mirrored, "DialogResult outcomes differ (typescript first, rust second)");
}

/// Every member of every mirrored union has a fixture.
///
/// A variant with no fixture has never been serialized, never been drawn, and
/// is only as correct as the moment someone typed it. This is what forces a new
/// member through the fixtures the shell renders from.
#[test]
fn every_mirrored_variant_has_a_fixture() {
	let covered = |present: Vec<String>, all: Vec<String>, what: &str| {
		let missing: Vec<&String> = all.iter().filter(|kind| !present.contains(kind)).collect();
		assert!(missing.is_empty(), "{what} variants with no fixture: {missing:?}");
	};

	covered(
		fixtures::transcript_blocks()
			.iter()
			.map(|block| tag_of(block, "kind"))
			.collect(),
		variants::<TranscriptBlock>("kind"),
		"TranscriptBlock",
	);
	covered(
		fixtures::dialogs()
			.iter()
			.map(|dialog| tag_of(dialog, "kind"))
			.collect(),
		variants::<DialogViewModel>("kind"),
		"DialogViewModel",
	);
	covered(
		fixtures::ui_events()
			.iter()
			.map(|event| tag_of(event, "type"))
			.collect(),
		variants::<UiEvent>("type"),
		"UiEvent",
	);
	covered(
		fixtures::dialog_results()
			.iter()
			.map(|result| tag_of(result, "outcome"))
			.collect(),
		variants::<DialogResult>("outcome"),
		"DialogResult",
	);
}

/// The tag a value serializes with.
fn tag_of<T: serde::Serialize>(value: &T, tag: &str) -> String {
	let json = serde_json::to_value(value).expect("serializes");
	json
		.get(tag)
		.and_then(serde_json::Value::as_str)
		.unwrap_or_else(|| panic!("no `{tag}` field in {json}"))
		.to_owned()
}

/// Compare one TypeScript `as const` table against a Rust variant list.
fn compare(file: &str, table: &str, mirrored: &[String]) {
	let source = read(file);
	let declared = table_entries(&source, table);
	assert!(
		!declared.is_empty(),
		"{table} in {file} yielded no entries — the table was renamed or its shape changed"
	);
	assert_eq!(
		declared, mirrored,
		"{table} and the Rust mirror differ (typescript first, rust second)"
	);
}

/// The string literals of `export const NAME = [ ... ] as const`.
///
/// The table exists in the TypeScript for exactly this purpose: it is asserted
/// there to be exhaustive over the union, in both directions, at compile time.
/// So reading it is reading a declared contract, not grepping an implementation
/// for incidental text — and an unreadable table fails rather than yielding
/// nothing, which [`compare`] asserts.
fn table_entries(source: &str, table: &str) -> Vec<String> {
	let opener = format!("export const {table} = [");
	let after = source
		.split(&opener)
		.nth(1)
		.unwrap_or_else(|| panic!("`{opener}` not found; the table was renamed or reformatted"));
	let body = after
		.split(']')
		.next()
		.expect("split always yields one part");
	quoted(body)
}

/// The `outcome` literals of the `DialogResult` union declaration.
fn outcomes(source: &str) -> Vec<String> {
	let opener = "export type DialogResult =";
	let after = source
		.split(opener)
		.nth(1)
		.unwrap_or_else(|| panic!("`{opener}` not found; the union was renamed"));
	let body = after
		.split(";\n")
		.next()
		.expect("split always yields one part");
	body
		.split("outcome:")
		.skip(1)
		.filter_map(|member| quoted(member).into_iter().next())
		.collect()
}

/// Every double-quoted string in a fragment, in order.
fn quoted(fragment: &str) -> Vec<String> {
	fragment
		.split('"')
		.skip(1)
		.step_by(2)
		.map(str::to_owned)
		.filter(|entry| !entry.is_empty())
		.collect()
}

/// Read one contract file: from the working tree when it is there, otherwise
/// from [`CONTRACT_BRANCH`], trying each of [`CONTRACT_ROOTS`] in turn.
fn read(file: &str) -> String {
	let root = repository_root();
	for candidate in CONTRACT_ROOTS {
		let path = root.join(candidate).join(file);
		if path.is_file() {
			return std::fs::read_to_string(&path)
				.unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
		}
	}

	let mut attempts = Vec::new();
	for candidate in CONTRACT_ROOTS {
		let reference = format!("{CONTRACT_BRANCH}:{candidate}/{file}");
		let output = Command::new("git")
			.arg("-C")
			.arg(&root)
			.args(["show", &reference])
			.output()
			.unwrap_or_else(|error| panic!("running git in {}: {error}", root.display()));
		if output.status.success() {
			return String::from_utf8(output.stdout).expect("the contract is utf-8");
		}
		attempts.push(format!("{reference}: {}", String::from_utf8_lossy(&output.stderr).trim()));
	}

	panic!(
		"the presentation contract is in none of the places it is looked for, so the mirror is \
		 unchecked.\nRoots tried under {}: {}\n{}",
		root.display(),
		CONTRACT_ROOTS.join(", "),
		attempts.join("\n")
	);
}

/// The repository root, from this crate's location.
///
/// `gui/crates/veyyon-gui-contract` — three levels up. Walked and checked
/// rather than assumed, so a crate that moves fails here instead of reading
/// nothing.
fn repository_root() -> PathBuf {
	let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
	let root = crate_dir
		.ancestors()
		.find(|candidate| candidate.join("packages").is_dir() && candidate.join("crates").is_dir())
		.unwrap_or_else(|| {
			panic!("no repository root above {} — this crate moved", crate_dir.display())
		});
	root.to_path_buf()
}

/// The reader finds the contract, and what it finds is the contract rather than
/// an empty string or an error page. This is the test's own foundation: every
/// assertion above is vacuous if this is broken.
#[test]
fn the_contract_is_reachable_and_looks_like_itself() {
	let source = read("transcript.ts");
	assert!(
		source.contains("export type TranscriptBlock"),
		"read something that is not the contract"
	);
	assert!(source.len() > 1_000, "read a truncated contract: {} bytes", source.len());
}
