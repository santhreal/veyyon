//! WHY: the monospace family was the string literal `"monospace"` compiled
//! into `TokenSet::mono_family`, and no token file named a face. Fontconfig
//! resolves a family by name, so a lookup of the generic word failed and GPUI
//! substituted the proportional UI stack for every terminal row, diff hunk and
//! code line, with nothing reported. Section 9.3 states that nothing visual is
//! compiled in and that a value the loader cannot resolve is reported, never
//! replaced.
//!
//! CLASS CLOSED: the monospace face is authored in `scale.toml` as an ordered
//! chain, and a chain that states no preference, names something that is not a
//! family, or carries a key the loader does not read fails the load with the
//! file and the key. Presence and type of the key itself are swept for every
//! token key by `every_token_key_is_required_and_typed`, and the dump path is
//! covered by `roundtrip`.
//!
//! NOT CAUGHT: whether a machine has any family in the chain, which is
//! resolution rather than authoring and belongs to the kit
//! (`mono-text-is-set-in-a-family-this-machine-has`). Whether a face named
//! here is in fact monospaced: a proportional family written into the chain
//! loads, and the kit suite is what observes the advance.

use std::{fs, path::PathBuf};

use veyyon_desktop_tokens::{load_from_dir, loader_scale::load_scale};
use veyyon_test_scratch::{TempTree, scratch_dir};

/// The shipped token directory.
fn shipped() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tokens")
}

/// A scratch copy of the shipped `scale.toml` with `[type.family]` replaced by
/// `body`, and the path to it.
fn scale_with_family(label: &str, body: &str) -> (TempTree, PathBuf) {
	let tree = scratch_dir(label);
	let path = tree.path().join("scale.toml");
	let text = fs::read_to_string(shipped().join("scale.toml")).expect("read shipped scale");
	let head = text
		.split("[type.family]")
		.next()
		.expect("shipped scale declares [type.family]")
		.to_string();
	let tail = text
		.split_once("[stroke]")
		.expect("shipped scale declares [stroke] after the family chain")
		.1;
	fs::write(&path, format!("{head}{body}\n\n[stroke]{tail}")).expect("write scratch scale");
	(tree, path)
}

/// The shipped chain names at least one family, names each of them once, and
/// names nothing blank. A duplicate is unreachable after the first match, and
/// a blank entry is a name no font system answers to.
#[test]
fn the_shipped_scale_authors_an_ordered_chain_of_named_families() {
	let tokens = load_from_dir(&shipped()).expect("load shipped tokens");
	let chain = tokens.scale.mono_family_chain();

	assert!(!chain.is_empty(), "the shipped scale must name a monospace family");
	for family in chain {
		assert_eq!(family.trim(), family.as_str(), "{family:?} is padded with whitespace");
		assert!(!family.is_empty(), "the chain carries a blank family name");
	}
	let mut seen = chain.to_vec();
	seen.sort();
	seen.dedup();
	assert_eq!(seen.len(), chain.len(), "the chain names a family twice: {chain:?}");
}

/// An empty chain states no preference at all, so it is rejected where it is
/// written rather than at the point a surface asks for a family.
#[test]
fn an_empty_chain_is_rejected_naming_the_file_and_the_key() {
	let (_tree, path) = scale_with_family("scale-family-empty", "[type.family]\nmono = []");
	let error = load_scale(&path).expect_err("an empty chain must not load");
	let message = error.to_string();
	assert!(message.contains("scale.toml"), "{message}");
	assert!(message.contains("mono"), "{message}");
}

/// A chain entry is a family name. A number in the list is a typo, and reading
/// it as a name, skipping it, or truncating the chain there all hide the typo.
#[test]
fn a_chain_entry_that_is_not_a_name_is_rejected_naming_the_file_and_the_key() {
	let (_tree, path) = scale_with_family(
		"scale-family-mistyped-entry",
		"[type.family]\nmono = [\"JetBrains Mono\", 7]",
	);
	let error = load_scale(&path).expect_err("a numeric chain entry must not load");
	let message = error.to_string();
	assert!(message.contains("scale.toml"), "{message}");
	assert!(message.contains("mono"), "{message}");
}

/// A second family key beside the chain reads as configuration and reaches
/// nothing, so the load reports it instead of ignoring it.
#[test]
fn a_family_key_the_loader_does_not_read_is_rejected() {
	let (_tree, path) = scale_with_family(
		"scale-family-unknown-key",
		"[type.family]\nmono = [\"JetBrains Mono\"]\nui = [\"Inter\"]",
	);
	let error = load_scale(&path).expect_err("an unread family key must not load");
	let message = error.to_string();
	assert!(message.contains("scale.toml"), "{message}");
	assert!(message.contains("ui"), "{message}");
}
