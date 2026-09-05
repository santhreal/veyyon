//! WHY: §6.7 adopts a 41-primitive kit so that a surface never reinvents a
//! control, and §8.25 states the surfaces each primitive serves. The tree held
//! the kit and the surfaces side by side, with the surfaces drawing their own
//! rows, dots, meters, scrims and dialogs while the kit's versions had a scene
//! and no consumer. A primitive nothing renders through is the drift §6.7
//! exists to prevent.
//!
//! CLASS CLOSED: a kit primitive with no consumer in the surface crate. The
//! inventory is `PrimitiveKind`, so a slot added to the kit is required to be
//! consumed the moment it exists; a consumer is a `use veyyon_desktop_kit::…`
//! import of the primitive's exported name in a surface source file. The set
//! still unconsumed is pinned by exact equality and may only shrink.
//!
//! NOT CAUGHT: a surface that imports a primitive and draws the slot by hand
//! anyway, and a primitive consumed through a path expression without an
//! import.

use std::{
	collections::BTreeSet,
	fs,
	path::{Path, PathBuf},
};

use strum::IntoEnumIterator;
use veyyon_desktop_kit::PrimitiveKind;

/// The exported names a primitive can be imported under. A variant's `Debug`
/// name is its exported name; two slots also export the struct behind the
/// alias.
fn exported_names(kind: PrimitiveKind) -> Vec<String> {
	let mut names = vec![format!("{kind:?}")];
	match kind {
		PrimitiveKind::SegmentedControl => names.push("Segmented".to_owned()),
		PrimitiveKind::TreeRow => names.push("TreeNode".to_owned()),
		_ => {},
	}
	names
}

/// Every primitive nothing in the surfaces imports yet. Shrink-only: a name
/// leaves this set when a surface renders through it, and never enters it.
const NOT_YET_CONSUMED: &[&str] = &[];

fn rust_files_under(dir: &Path, out: &mut Vec<PathBuf>) {
	let Ok(entries) = fs::read_dir(dir) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		if path.is_dir() {
			rust_files_under(&path, out);
		} else if path.extension().is_some_and(|ext| ext == "rs") {
			out.push(path);
		}
	}
}

/// The names each file imports from the kit: the leaves of every
/// `use veyyon_desktop_kit::…;` item that name a type, with any `as` rename
/// dropped so the kit's name is what counts and module segments skipped.
fn kit_imports(source: &str) -> BTreeSet<String> {
	let mut names = BTreeSet::new();
	let mut rest = source;
	while let Some(start) = rest.find("use veyyon_desktop_kit::") {
		let after = &rest[start + "use veyyon_desktop_kit::".len()..];
		let Some(end) = after.find(';') else {
			break;
		};
		for chunk in after[..end].split([',', '{', '}', '\n']) {
			let kit_name = chunk.split(" as ").next().unwrap_or("").trim();
			let leaf = kit_name.rsplit("::").next().unwrap_or("").trim();
			if leaf.starts_with(char::is_uppercase) {
				names.insert(leaf.to_owned());
			}
		}
		rest = &after[end..];
	}
	names
}

#[test]
fn every_kit_primitive_is_imported_by_a_surface_or_pinned_as_unconsumed() {
	let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
	let mut files = Vec::new();
	rust_files_under(&src, &mut files);
	assert!(!files.is_empty(), "no surface sources under {}", src.display());

	let mut imported = BTreeSet::new();
	for file in &files {
		let source = fs::read_to_string(file)
			.unwrap_or_else(|err| panic!("{} is readable: {err}", file.display()));
		imported.extend(kit_imports(&source));
	}

	let unconsumed: Vec<String> = PrimitiveKind::iter()
		.filter(|kind| {
			!exported_names(*kind)
				.iter()
				.any(|name| imported.contains(name))
		})
		.map(|kind| format!("{kind:?}"))
		.collect();

	let pinned: Vec<String> = NOT_YET_CONSUMED.iter().map(|s| (*s).to_owned()).collect();
	assert_eq!(
		unconsumed, pinned,
		"the kit primitives no surface imports differ from the pinned set: a name missing from the \
		 left gained a consumer and leaves NOT_YET_CONSUMED; a name only on the left lost one"
	);
}

#[test]
fn the_import_reader_sees_every_form_a_kit_import_takes() {
	let source = "use veyyon_desktop_kit::{\n\tBadge, ColorRole,\n\tcontrols::{Button as B, \
	              IconButton},\n\tinput::Editor,\n};\nuse veyyon_desktop_kit::TokenSet;\n";
	let names = kit_imports(source);
	for expected in ["Badge", "ColorRole", "Button", "IconButton", "Editor", "TokenSet"] {
		assert!(names.contains(expected), "{expected} not read from the import: {names:?}");
	}
	assert!(!names.contains("B"), "the rename, not the kit name, was read: {names:?}");
	assert!(!names.contains("controls"), "a module segment was read as a name: {names:?}");
}
