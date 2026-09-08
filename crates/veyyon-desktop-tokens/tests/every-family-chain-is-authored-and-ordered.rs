//! WHY: the monospace family was the string literal `"monospace"` compiled
//! into `TokenSet::mono_family`, and no token file named a face; the
//! proportional family was never authored at all, so every UI run reached GPUI
//! as its unresolvable `.SystemUIFont` default. Fontconfig resolves a family by
//! name, so both lookups failed: the terminal, diffs and code lines were drawn
//! in a substituted proportional stack, and each UI run paid a ten-deep
//! fallback walk and a constructed miss error per frame. Section 9.3 states
//! that nothing visual is compiled in and that a value the loader cannot
//! resolve is reported, never replaced.
//!
//! CLASS CLOSED: every chain `[type.family]` authors, swept from the shipped
//! file at run time rather than from a list written here. Each chain must be
//! present, ordered, named and unique, must have an accessor on `ScaleTokens`, and a
//! chain that is missing, empty, or names something that is not a family fails
//! the load with the file and the key. A key the loader does not read fails
//! too. A chain added to the file with no accessor turns
//! `the_shipped_scale_authors_an_ordered_chain_for_every_family_it_names` red.
//! Presence and type of the key itself are swept for every token key by
//! `every_token_key_is_required_and_typed`, and the dump path is covered by
//! `roundtrip`.
//!
//! NOT CAUGHT: whether a machine has any family in a chain, which is
//! resolution rather than authoring and belongs to the kit
//! (`mono-text-is-set-in-a-family-this-machine-has`) and to the surface
//! install (`every-authored-font-family-is-a-face-this-machine-has`). Whether a
//! face named in the mono chain is in fact monospaced: a proportional family
//! written there loads, and the kit suite is what observes the advance.

use std::{collections::BTreeSet, fs, path::PathBuf};

use veyyon_desktop_tokens::{ScaleTokens, load_from_dir, loader_scale::load_scale};
use veyyon_test_scratch::{TempTree, scratch_dir};

/// A chain the loader reads, and the accessor a surface reads it back through.
type Accessor = fn(&ScaleTokens) -> &[String];

/// The accessors, keyed by the `[type.family]` key each one reads. A key the
/// shipped file authors and this table omits is a chain nothing can ask for.
fn accessors() -> Vec<(&'static str, Accessor)> {
	vec![
		("mono", ScaleTokens::mono_family_chain as Accessor),
		("ui", ScaleTokens::ui_family_chain as Accessor),
	]
}

/// The shipped token directory.
fn shipped() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tokens")
}

/// The `[type.family]` keys the shipped scale authors, read at run time.
fn authored_keys() -> BTreeSet<String> {
	let text = fs::read_to_string(shipped().join("scale.toml")).expect("read shipped scale");
	let document: toml::Table = text.parse().expect("the shipped scale parses");
	document
		.get("type")
		.and_then(toml::Value::as_table)
		.and_then(|type_tbl| type_tbl.get("family"))
		.and_then(toml::Value::as_table)
		.expect("the shipped scale declares a [type.family] table")
		.keys()
		.cloned()
		.collect()
}

/// A `[type.family]` table naming every authored key with a face, except `key`,
/// which takes `value` verbatim. An empty `value` omits the key entirely.
fn family_body(key: &str, value: &str) -> String {
	let mut body = String::from("[type.family]\n");
	for authored in authored_keys() {
		if authored == key {
			if value.is_empty() {
				continue;
			}
			body.push_str(&format!("{authored} = {value}\n"));
		} else {
			body.push_str(&format!("{authored} = [\"JetBrains Mono\"]\n"));
		}
	}
	body
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

/// Every authored chain has an accessor, names at least one family, names each
/// of them once, and names nothing blank. A duplicate is unreachable after the
/// first match, a blank entry is a name no font system answers to, and a chain
/// with no accessor is authored text nothing reads.
#[test]
fn the_shipped_scale_authors_an_ordered_chain_for_every_family_it_names() {
	let wired: BTreeSet<String> = accessors().iter().map(|(key, _)| (*key).to_string()).collect();
	assert_eq!(
		wired,
		authored_keys(),
		"the authored [type.family] keys and the chains a surface can read have diverged"
	);

	let tokens = load_from_dir(&shipped()).expect("load shipped tokens");
	for (key, chain_of) in accessors() {
		let chain = chain_of(&tokens.scale);
		assert!(!chain.is_empty(), "the shipped scale names no {key} family");
		for family in chain {
			assert_eq!(family.trim(), family.as_str(), "{key}: {family:?} is padded");
			assert!(!family.is_empty(), "the {key} chain carries a blank family name");
		}
		let mut seen = chain.to_vec();
		seen.sort();
		seen.dedup();
		assert_eq!(seen.len(), chain.len(), "the {key} chain names a family twice: {chain:?}");
	}
}

/// An empty chain states no preference at all, so it is rejected where it is
/// written rather than at the point a surface asks for a family.
#[test]
fn an_empty_chain_is_rejected_naming_the_file_and_the_key() {
	for (key, _) in accessors() {
		let (_tree, path) =
			scale_with_family(&format!("scale-family-empty-{key}"), &family_body(key, "[]"));
		let error = load_scale(&path).expect_err("an empty chain must not load");
		let message = error.to_string();
		assert!(message.contains("scale.toml"), "{key}: {message}");
		assert!(message.contains(key), "{key}: {message}");
	}
}

/// A chain the file omits leaves the family unstated, which is the state the
/// proportional stack was in: GPUI keeps its own default and no token authors
/// the face.
#[test]
fn a_missing_chain_is_rejected_naming_the_file_and_the_key() {
	for (key, _) in accessors() {
		let (_tree, path) =
			scale_with_family(&format!("scale-family-absent-{key}"), &family_body(key, ""));
		let error = load_scale(&path).expect_err("a missing chain must not load");
		let message = error.to_string();
		assert!(message.contains("scale.toml"), "{key}: {message}");
		assert!(message.contains(key), "{key}: {message}");
	}
}

/// A chain entry is a family name. A number in the list is a typo, and reading
/// it as a name, skipping it, or truncating the chain there all hide the typo.
#[test]
fn a_chain_entry_that_is_not_a_name_is_rejected_naming_the_file_and_the_key() {
	for (key, _) in accessors() {
		let (_tree, path) = scale_with_family(
			&format!("scale-family-mistyped-{key}"),
			&family_body(key, "[\"JetBrains Mono\", 7]"),
		);
		let error = load_scale(&path).expect_err("a numeric chain entry must not load");
		let message = error.to_string();
		assert!(message.contains("scale.toml"), "{key}: {message}");
		assert!(message.contains(key), "{key}: {message}");
	}
}

/// A further family key beside the authored chains reads as configuration and
/// reaches nothing, so the load reports it instead of ignoring it.
#[test]
fn a_family_key_the_loader_does_not_read_is_rejected() {
	let mut body = family_body("", "");
	body.push_str("display = [\"Inter Display\"]\n");
	let (_tree, path) = scale_with_family("scale-family-unknown-key", &body);
	let error = load_scale(&path).expect_err("an unread family key must not load");
	let message = error.to_string();
	assert!(message.contains("scale.toml"), "{message}");
	assert!(message.contains("display"), "{message}");
}
