//! WHY: the loaders defaulted a missing or mistyped key to a number written
//! into Rust (`unwrap_or(768)`, `unwrap_or(2.08)`, `_ => 0.0`, and a spacing
//! step chosen by the loader when the file had none). Section 9.3 states that
//! nothing visual is compiled in and that a malformed file is reported, never
//! replaced by a default. One loader (shell) was fixed; the other eleven kept
//! about 170 such sites, so a surface file missing a key rendered from a
//! number nobody could find in a token file.
//!
//! CLASS CLOSED: any key in any bundled token file loading as something other
//! than the value written in the file. The key set is enumerated from the
//! shipped files at run time, so a key added later is covered on arrival, and
//! a key that no loader reads is reported as dead rather than tolerated.
//!
//! NOT CAUGHT: a value that is the wrong number but the right type (a
//! negative height, a ratio above one). Those are range rules and each owns
//! its own test. A default hidden downstream of the loader, in a surface that
//! ignores the token it was given.

use std::{
	fs,
	path::{Path, PathBuf},
};

use toml::Value;
use veyyon_desktop_tokens::load_from_dir;
use veyyon_test_scratch::{TempTree, scratch_dir};

/// The shipped token directory.
fn shipped() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tokens")
}

/// Every token file the loader reads, relative to the token root.
fn token_files() -> Vec<PathBuf> {
	let root = shipped();
	let mut files = Vec::new();
	for dir in [root.clone(), root.join("surface")] {
		for entry in fs::read_dir(&dir).expect("read token dir") {
			let path = entry.expect("dir entry").path();
			if path.extension().is_some_and(|e| e == "toml") {
				files.push(path.strip_prefix(&root).expect("under root").to_path_buf());
			}
		}
	}
	files.sort();
	assert!(files.len() >= 13, "expected the 13 shipped token files, found {}", files.len());
	files
}

/// Copies the shipped files byte for byte, so the fixture is what ships and
/// not what the dumper writes.
fn copy_shipped(label: &str) -> (TempTree, PathBuf) {
	let tree = scratch_dir(label);
	let dir = tree.path().to_path_buf();
	fs::create_dir_all(dir.join("surface")).expect("mkdir surface");
	for rel in token_files() {
		fs::copy(shipped().join(&rel), dir.join(&rel)).expect("copy token file");
	}
	(tree, dir)
}

/// Dotted paths of every leaf under a table, in file order. An entry of an
/// array of tables (`[[level]]`) is addressed by its position.
fn leaf_paths(table: &toml::map::Map<String, Value>, prefix: &str, out: &mut Vec<String>) {
	for (key, value) in table {
		let path = if prefix.is_empty() {
			key.clone()
		} else {
			format!("{prefix}.{key}")
		};
		match value {
			Value::Table(inner) => leaf_paths(inner, &path, out),
			Value::Array(items) if items.iter().all(Value::is_table) && !items.is_empty() => {
				for (position, item) in items.iter().enumerate() {
					if let Value::Table(inner) = item {
						leaf_paths(inner, &format!("{path}.{position}"), out);
					}
				}
			},
			_ => out.push(path),
		}
	}
}

/// Walks to the table holding the last segment of `path`.
fn parent_mut<'a>(
	root: &'a mut toml::map::Map<String, Value>,
	path: &str,
) -> (&'a mut toml::map::Map<String, Value>, String) {
	let mut segments: Vec<&str> = path.split('.').collect();
	let last = segments.pop().expect("non-empty path").to_string();
	let Some(first) = segments.first() else {
		return (root, last);
	};
	let mut value: &mut Value = root.get_mut(*first).expect("first segment exists");
	for segment in &segments[1..] {
		value = match value {
			Value::Table(table) => table.get_mut(*segment).expect("segment exists"),
			Value::Array(items) => {
				let position: usize = segment.parse().expect("array segment is a position");
				items.get_mut(position).expect("position exists")
			},
			_ => panic!("segment {segment} of {path} is a leaf"),
		};
	}
	(value.as_table_mut().expect("parent is a table"), last)
}

/// The value that has the wrong type for `value`, so a mistype is always a
/// type change and never a range change.
fn mistyped(value: &Value) -> Value {
	match value {
		Value::String(_) => Value::Integer(7),
		_ => Value::String("x".to_string()),
	}
}

enum Corruption {
	Delete,
	Mistype,
}

/// Writes `rel` with one leaf corrupted and returns the leaf's last segment.
fn corrupt(dir: &Path, rel: &Path, leaf: &str, how: &Corruption) -> String {
	let path = dir.join(rel);
	let text = fs::read_to_string(&path).expect("read token file");
	let mut root: toml::map::Map<String, Value> =
		toml::from_str(&text).expect("shipped token file parses");
	let (table, key) = parent_mut(&mut root, leaf);
	match how {
		Corruption::Delete => {
			table.remove(&key).expect("leaf exists");
		},
		Corruption::Mistype => {
			let current = table.get(&key).expect("leaf exists").clone();
			table.insert(key.clone(), mistyped(&current));
		},
	}
	let rewritten = toml::to_string(&Value::Table(root)).expect("serialise token file");
	fs::write(&path, rewritten).expect("write token file");
	key
}

/// Restores `rel` from the shipped copy.
fn restore(dir: &Path, rel: &Path) {
	fs::copy(shipped().join(rel), dir.join(rel)).expect("restore token file");
}

fn sweep(label: &str, how: Corruption) -> Vec<String> {
	let (_tree, dir) = copy_shipped(label);
	load_from_dir(&dir).expect("the untouched copy loads");
	let mut tolerated = Vec::new();
	for rel in token_files() {
		let text = fs::read_to_string(shipped().join(&rel)).expect("read shipped file");
		let root: toml::map::Map<String, Value> = toml::from_str(&text).expect("parses");
		let mut leaves = Vec::new();
		leaf_paths(&root, "", &mut leaves);
		assert!(!leaves.is_empty(), "{} has no keys", rel.display());
		for leaf in leaves {
			let key = corrupt(&dir, &rel, &leaf, &how);
			let file = rel
				.file_name()
				.expect("file name")
				.to_string_lossy()
				.to_string();
			match load_from_dir(&dir) {
				Ok(_) => tolerated.push(format!("{}: {leaf} (loaded anyway)", rel.display())),
				Err(err) => {
					let message = err.to_string();
					if !message.contains(&file) || !message.contains(&key) {
						tolerated.push(format!(
							"{}: {leaf} (failed without naming file and key: {message})",
							rel.display()
						));
					}
				},
			}
			restore(&dir, &rel);
		}
	}
	tolerated
}

/// Deleting any one key fails the load with an error that names the file and
/// the key. A key that can be deleted without consequence is either defaulted
/// in Rust or never read, and both are defects.
#[test]
fn deleting_any_key_fails_the_load_naming_the_file_and_the_key() {
	let tolerated = sweep("tokens-delete-any-key", Corruption::Delete);
	assert!(
		tolerated.is_empty(),
		"{} keys load without their value:\n{}",
		tolerated.len(),
		tolerated.join("\n")
	);
}

/// Changing any one key to the wrong type fails the load with an error that
/// names the file and the key, rather than reading it as zero, empty, false
/// or a default step.
#[test]
fn mistyping_any_key_fails_the_load_naming_the_file_and_the_key() {
	let tolerated = sweep("tokens-mistype-any-key", Corruption::Mistype);
	assert!(
		tolerated.is_empty(),
		"{} keys load with a value of the wrong type:\n{}",
		tolerated.len(),
		tolerated.join("\n")
	);
}
