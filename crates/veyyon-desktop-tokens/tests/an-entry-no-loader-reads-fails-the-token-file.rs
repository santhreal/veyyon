//! WHY: a token file is the product's whole visual vocabulary, and an entry
//! nobody reads is the quietest way to lose one: the file states a value, the
//! loader ignores it, and the surface draws something else forever. Two scale
//! sections shipped that way — `type.mono` and `stroke` read their known keys
//! and dropped the rest — and nothing went red, because no suite handed a
//! loader an entry it does not read.
//!
//! The class this closes is a table in any token file that accepts a key the
//! loader never reads. The sweep walks every table of every file under
//! `tokens/`, hands each one a surplus entry, and asserts the load fails. A
//! new table, a new file, and a loader that forgets `only` or a ceiling each
//! arrive as a named row in the failure.
//!
//! `[spacing]` is the one table that accepts a surplus entry, because §6.1
//! declares 16 slots for 14 steps and the two free slots are the headroom. It
//! is pinned here by exact equality, so the headroom cannot silently spread to
//! a second table.
//!
//! It does not reach the theme files, which state colour rather than scale and
//! are swept by
//! `a_bundled_theme_declares_every_role_and_a_broken_one_fails_loud`.

use std::{fs, path::Path};

use veyyon_desktop_tokens::{TokenError, load_from_dir};
use veyyon_test_scratch::{TempTree, scratch_dir};

/// A table of a token file, named the way the failure should read.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Table {
	file: String,
	name: String,
	/// The line the header sits on, so repeated `[[level]]` entries are
	/// probed one at a time.
	line: usize,
}

fn shipped_dir() -> std::path::PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens")
}

/// Copies the shipped token tree into a scratch directory, one level deep,
/// which is the shape `tokens/` has: files at the root and files in
/// `surface/`.
fn copy_shipped(tree: &TempTree) -> Vec<String> {
	let source = shipped_dir();
	let mut files = Vec::new();
	for entry in fs::read_dir(&source).expect("read tokens dir") {
		let path = entry.expect("tokens dir entry").path();
		let name = path
			.file_name()
			.expect("named entry")
			.to_string_lossy()
			.into_owned();
		if path.is_dir() {
			fs::create_dir_all(tree.path().join(&name)).expect("create sub directory");
			for nested in fs::read_dir(&path).expect("read token sub directory") {
				let nested = nested.expect("token sub directory entry").path();
				let leaf = nested
					.file_name()
					.expect("named entry")
					.to_string_lossy()
					.into_owned();
				let relative = format!("{name}/{leaf}");
				fs::copy(&nested, tree.path().join(&relative)).expect("copy token file");
				files.push(relative);
			}
		} else {
			fs::copy(&path, tree.path().join(&name)).expect("copy token file");
			files.push(name);
		}
	}
	files.sort();
	files
}

fn tables_of(text: &str, file: &str) -> Vec<Table> {
	text
		.lines()
		.enumerate()
		.filter(|(_, line)| line.starts_with('[') && line.ends_with(']'))
		.map(|(index, line)| Table {
			file: file.to_string(),
			name: line.trim_matches(['[', ']'].as_slice()).to_string(),
			line: index,
		})
		.collect()
}

/// `text` with one entry no loader reads added to the table opened on `line`.
fn with_surplus(text: &str, line: usize) -> String {
	let mut out = String::with_capacity(text.len() + 32);
	for (index, source) in text.lines().enumerate() {
		out.push_str(source);
		out.push('\n');
		if index == line {
			out.push_str("zz_surplus = 1\n");
		}
	}
	out
}

#[test]
fn a_table_that_takes_an_entry_no_loader_reads_is_only_the_spacing_headroom() {
	let tree = scratch_dir("desktop-tokens-surplus-entry");
	let files = copy_shipped(&tree);
	assert!(files.contains(&"scale.toml".to_string()), "no scale.toml in {files:?}");
	assert!(files.iter().any(|file| file.starts_with("surface/")), "no surfaces in {files:?}");

	let mut accepted: Vec<(String, String)> = Vec::new();
	let mut unexpected: Vec<(String, String, String)> = Vec::new();

	for file in files {
		let path = tree.path().join(&file);
		let original = fs::read_to_string(&path).expect("read copied token file");
		for table in tables_of(&original, &file) {
			fs::write(&path, with_surplus(&original, table.line)).expect("write probe");
			match load_from_dir(tree.path()) {
				Ok(_) => accepted.push((table.file.clone(), table.name.clone())),
				Err(TokenError::UnknownKey { .. } | TokenError::CeilingExceeded { .. }) => {},
				Err(other) => {
					unexpected.push((table.file.clone(), table.name.clone(), other.to_string()));
				},
			}
			fs::write(&path, &original).expect("restore token file");
		}
	}

	let none: Vec<(String, String, String)> = Vec::new();
	assert_eq!(unexpected, none, "a surplus entry is rejected by name, not by a later failure");
	assert_eq!(accepted, [("scale.toml".to_string(), "spacing".to_string())]);
}

#[test]
fn the_shipped_token_tree_loads_before_and_after_a_probe_is_undone() {
	let tree = scratch_dir("desktop-tokens-surplus-restore");
	copy_shipped(&tree);
	let path = tree.path().join("scale.toml");
	let original = fs::read_to_string(&path).expect("read copied scale.toml");

	let radius = tables_of(&original, "scale.toml")
		.into_iter()
		.find(|table| table.name == "radius")
		.expect("scale.toml declares a radius table");

	load_from_dir(tree.path()).expect("the copied tree loads");
	fs::write(&path, with_surplus(&original, radius.line)).expect("write probe");
	load_from_dir(tree.path()).expect_err("a ninth radius is over the ceiling");
	fs::write(&path, &original).expect("restore scale.toml");

	load_from_dir(tree.path()).expect("the restored tree loads");
}
