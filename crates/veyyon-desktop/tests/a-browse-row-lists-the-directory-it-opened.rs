//! WHY: Enter on a directory row descended and nothing on screen changed.
//! The descent recorded the name it had entered and asked the host for no
//! listing, while the Browse projection drew every directory of the tree the
//! host had already sent, at every depth, whatever directory the operator had
//! opened. So the surface offered a walk that could not move: one flat dump of
//! the workspace, the same rows before and after Enter, and no way back up.
//!
//! THE CLASS THIS CLOSES: a step of palette navigation that changes the shell
//! and reaches no host, and a listing that draws rows belonging to a directory
//! other than the one being listed. The rows are read out of the projection
//! rather than out of a fixture, and the depth sweep is derived from the
//! host's own tree at run time, so a descent that stops reporting its target,
//! an ascent that stops reporting its parent, and a projection that widens
//! past one level each turn this suite red, at whatever depth the tree
//! carries.
//!
//! WHAT IT DOES NOT CATCH: the keystrokes, which
//! `the-palette-moves-runs-and-ascends-through-its-modes` drives through
//! `ShellView` for Enter on a directory row and Escape back out of it;
//! whether the host's `LoadFileTree` answers with the directory that was
//! asked for, which `handleLoadFileTree` bounds and
//! `every-host-action-has-a-dispatcher` dispatches; and the pixels of a
//! browse row, which
//! `a-line-row-states-its-detail-beside-the-title-not-under-it` measures.

#[path = "support/mod.rs"]
mod support;

use std::collections::HashMap;

use support::NOW_MS;
use veyyon_desktop::{SessionIndex, actions_for, project};
use veyyon_desktop_model::{
	FileKind, FileNode, FileTreeView, HostAction, QueuePartition, SessionId, Store,
};
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteItemKind, PaletteMode, PaletteState, ShellState,
};

/// A directory entry of `path` at `depth` below the listed root.
fn dir(path: &str, depth: u32) -> FileNode {
	FileNode {
		path: path.to_owned(),
		name: path
			.rsplit_once('/')
			.map_or(path, |(_, name)| name)
			.to_owned(),
		kind: FileKind::Directory,
		depth,
	}
}

/// A file entry, which Browse never lists.
fn file(path: &str, depth: u32) -> FileNode {
	FileNode {
		path: path.to_owned(),
		name: path
			.rsplit_once('/')
			.map_or(path, |(_, name)| name)
			.to_owned(),
		kind: FileKind::File,
		depth,
	}
}

/// A store holding one session and the tree the host last sent.
fn store_with(root: &str, entries: Vec<FileNode>) -> Store {
	let mut store = Store::new();
	store
		.sessions
		.insert(support::session("s", QueuePartition::Live));
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	store.domains.file_tree =
		Some(FileTreeView { root: root.to_owned(), entries, truncated: false });
	store
}

/// The rows Browse mode draws for `store`, in ranked order, while the palette
/// is listing `browse_root`.
fn rows(store: &Store, browse_root: Option<&str>) -> Vec<String> {
	let mut palette = PaletteState::new(PaletteMode::Browse);
	palette.browse_to(browse_root.map(str::to_owned));
	let mut state = ShellState { overlay: Some(Overlay::Palette(palette)), ..ShellState::default() };
	let mut index = SessionIndex::default();
	project(store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	state
		.overlay_palette()
		.expect("the palette stays open across a projection")
		.filtered_items()
		.iter()
		.map(|item| match &item.kind {
			PaletteItemKind::Directory { path } => path.clone(),
			other => panic!("Browse listed a row that is not a directory: {other:?}"),
		})
		.collect()
}

#[test]
fn a_browse_listing_draws_the_children_of_the_directory_it_lists() {
	// One tree as the host sends it: the children of the listed root at depth
	// 0, their own children at 1, and files at both, which Browse never lists.
	let entries = vec![
		dir("crates", 0),
		dir("crates/veyyon-desktop", 1),
		dir("crates/veyyon-desktop/src", 2),
		file("crates/Cargo.toml", 1),
		dir("packages", 0),
		dir("packages/ai", 1),
		file("README.md", 0),
	];
	let store = store_with("/repo", entries.clone());

	assert_eq!(
		rows(&store, None),
		["crates", "packages"],
		"the listing is the directories one level under the root, not the whole tree"
	);

	// Derived from the fixture rather than restated: every entry the listing
	// leaves out is one the operator has not opened, or is not a directory.
	let listed = rows(&store, None);
	for entry in &entries {
		let expected = entry.kind == FileKind::Directory && entry.depth == 0;
		assert_eq!(
			listed.contains(&entry.path),
			expected,
			"{} at depth {} is {} the listing",
			entry.path,
			entry.depth,
			if expected { "missing from" } else { "in" }
		);
	}
}

#[test]
fn a_directory_with_no_subdirectory_lists_nothing_of_the_one_above_it() {
	// The host answers a descent with the leaf's own listing, which holds
	// files alone. Keeping the parent's rows would offer a walk into
	// directories that are not in this one.
	let store = store_with("/repo/crates/veyyon-desktop", vec![
		file("crates/veyyon-desktop/Cargo.toml", 0),
		file("crates/veyyon-desktop/src/main.rs", 1),
	]);
	assert!(
		rows(&store, Some("crates/veyyon-desktop")).is_empty(),
		"a directory whose children are files lists no rows"
	);
}

#[test]
fn a_descent_asks_the_host_for_the_directory_the_row_names() {
	let mut store = store_with("/repo", vec![dir("crates", 0), dir("packages", 0)]);
	let mut index = SessionIndex::default();
	let mut state = ShellState {
		overlay: Some(Overlay::Palette(PaletteState::new(PaletteMode::Browse))),
		..ShellState::default()
	};
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);

	let target = state
		.overlay_palette()
		.and_then(PaletteState::selected_item)
		.map(|item| match &item.kind {
			PaletteItemKind::Directory { path } => path.clone(),
			other => panic!("the first browse row is not a directory: {other:?}"),
		})
		.expect("the projection left a row selected");

	let intent = Intent::BrowseTo { path: Some(target.clone()) };
	assert_eq!(
		actions_for(&intent, &index, &mut store),
		vec![HostAction::LoadFileTree { root: Some(target.clone()) }],
		"the descent is the listing of what the row named"
	);
	assert!(!intent.is_local(), "a descent the shell keeps to itself reaches no host");

	intent.apply(&mut state);
	assert_eq!(
		state
			.overlay_palette()
			.expect("the palette stays open on a descent")
			.browse_root(),
		Some(target.as_str()),
		"the palette lists the directory it descended into"
	);
}

#[test]
fn an_ascent_asks_the_host_for_the_parent_and_stops_at_the_root() {
	let mut store =
		store_with("/repo/crates/veyyon-desktop", vec![dir("crates/veyyon-desktop/src", 0)]);
	let index = SessionIndex::default();
	let mut palette = PaletteState::new(PaletteMode::Browse);
	palette.browse_to(Some("crates/veyyon-desktop".to_owned()));
	let mut state = ShellState { overlay: Some(Overlay::Palette(palette)), ..ShellState::default() };

	// One level up is the directory above it, and the level above that is the
	// workspace root, which the host reads as `None`.
	let parents = [Some("crates".to_owned()), None];
	for parent in parents {
		let ascent = state
			.overlay_palette()
			.and_then(PaletteState::browse_parent)
			.expect("a listed directory has a parent to ascend to");
		assert_eq!(ascent, parent, "the ascent names the directory it returns to");
		let intent = Intent::BrowseTo { path: ascent };
		assert_eq!(
			actions_for(&intent, &index, &mut store),
			vec![HostAction::LoadFileTree { root: parent.clone() }],
			"the ascent is the listing of the parent"
		);
		intent.apply(&mut state);
	}

	assert!(
		state
			.overlay_palette()
			.and_then(PaletteState::browse_parent)
			.is_none(),
		"the workspace root has nothing above it, so the next Escape closes the palette"
	);
}

#[test]
fn only_browse_mode_ascends_through_directories() {
	// A mode with no directories to walk must not swallow the Escape that
	// closes the palette, which is what `browse_parent` returning `None`
	// states. The sweep is over the modes the surface declares.
	for mode in [
		PaletteMode::Commands,
		PaletteMode::Sessions,
		PaletteMode::Models,
		PaletteMode::Files,
		PaletteMode::ContentSearch,
	] {
		let mut palette = PaletteState::new(mode);
		palette.browse_to(Some("crates".to_owned()));
		assert!(
			palette.browse_parent().is_none(),
			"{mode:?}: a mode that does not browse offers no ascent"
		);
	}
	let mut browsing = PaletteState::new(PaletteMode::Browse);
	browsing.browse_to(Some("crates".to_owned()));
	assert_eq!(
		browsing.browse_parent(),
		Some(None),
		"Browse ascends from a first-level directory to the workspace root"
	);
}
