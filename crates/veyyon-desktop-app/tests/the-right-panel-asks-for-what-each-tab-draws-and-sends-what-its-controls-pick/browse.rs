//! The files tab draws the host's tree as a disclosure tree: the entries at
//! the listed root, and beneath each opened directory its own entries, in the
//! host's order. Opening or closing a directory asks the host for nothing,
//! since the host's listing holds every level down to its depth limit
//! (`FILE_TREE_MAX_DEPTH` in the host's `gui-host/actions/files.ts`); a file
//! row asks for the text of the path it lists.
//!
//! WHY: the retired palette's Browse mode drew every directory of the tree at
//! every depth whatever directory was opened, so a descent changed nothing on
//! screen. The sweep reads the directories out of the host's tree at run time
//! and, for each, opens the path down to it and compares the rows drawn with
//! the rows whose every ancestor is open, worked out from the paths rather
//! than the depths the tab reads; then it closes it again. A tab that draws
//! past an opened level, keeps a closed directory's rows or a sibling's,
//! loses rows after an opened empty directory, or asks the host for a listing
//! turns it red.
//!
//! Gap: a directory whose entries the host cut is drawn opened and empty
//! under the cut notice `cuts` asserts; the indent of a row is not measured.

use std::collections::HashSet;

use gpui::TestAppContext;
use veyyon_desktop_app::panel::PanelTab;
use veyyon_desktop_model::{
	FileKind, FileNode, FileTreeView, HostAction, HostEvent, SnapshotSection,
};

use super::harness::{SESSION, Win, opened, window};

/// A tree as the host lists it: depth first, names sorted, an empty
/// directory before one that holds a file.
const TREE: [(&str, FileKind); 10] = [
	("alpha", FileKind::Directory),
	("alpha/beta", FileKind::Directory),
	("alpha/beta/delta", FileKind::Directory),
	("alpha/beta/delta/epsilon.rs", FileKind::File),
	("alpha/beta/gamma.rs", FileKind::File),
	("alpha/zeta.rs", FileKind::File),
	("empty", FileKind::Directory),
	("eta", FileKind::Directory),
	("eta/theta.rs", FileKind::File),
	("iota.rs", FileKind::File),
];

fn name(path: &str) -> &str {
	path.rsplit_once('/').map_or(path, |(_, name)| name)
}

/// The directories above `path`, outermost first.
fn ancestors(path: &str) -> impl Iterator<Item = &str> {
	path.match_indices('/').map(|(at, _)| &path[..at])
}

/// The names of the rows drawn with every directory in `open` opened, in
/// the host's order.
fn expected(open: &HashSet<&str>) -> Vec<&'static str> {
	TREE
		.iter()
		.filter(|(path, _)| ancestors(path).all(|dir| open.contains(dir)))
		.map(|(path, _)| name(path))
		.collect()
}

/// The names of the tree rows the last frame drew, top to bottom.
fn drawn(w: &mut Win<'_>) -> Vec<String> {
	let names: HashSet<&str> = TREE.iter().map(|(path, _)| name(path)).collect();
	w.texts()
		.into_iter()
		.map(|text| text.trim().to_owned())
		.filter(|text| names.contains(text.as_str()))
		.collect()
}

fn browsing(app: &mut TestAppContext) -> Win<'_> {
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Files);
	w.apply(vec![HostEvent::Snapshot(SnapshotSection::FileTree(FileTreeView {
		root:      "/w/s".to_owned(),
		entries:   TREE
			.iter()
			.map(|&(path, kind)| FileNode {
				path: path.to_owned(),
				name: name(path).to_owned(),
				kind,
				depth: ancestors(path).count() as u32,
			})
			.collect(),
		truncated: false,
	}))]);
	w.requests();
	w
}

/// Clicks the row of `dir`, which opens or closes it and asks the host for
/// nothing.
fn toggle(w: &mut Win<'_>, dir: &str) {
	w.click_text(name(dir));
	assert_eq!(
		w.sent(),
		Vec::<HostAction>::new(),
		"opening or closing {dir} asks the host for nothing"
	);
}

#[gpui::test]
fn opening_a_directory_draws_its_own_entries_and_closing_it_hides_every_row_beneath(
	app: &mut TestAppContext,
) {
	let mut w = browsing(app);
	let mut open = HashSet::new();
	assert_eq!(drawn(&mut w), expected(&open), "the tab opens on the root's entries alone");

	let dirs = TREE
		.iter()
		.filter(|(_, kind)| *kind == FileKind::Directory)
		.map(|(path, _)| *path);
	for dir in dirs {
		for step in ancestors(dir).chain([dir]) {
			if open.insert(step) {
				toggle(&mut w, step);
			}
		}
		assert_eq!(drawn(&mut w), expected(&open), "{dir} and every directory above it opened");
		open.remove(dir);
		toggle(&mut w, dir);
		assert_eq!(drawn(&mut w), expected(&open), "{dir} closed again");
	}

	// `alpha` and `alpha/beta` are still open: closing the outer one hides
	// the inner one's rows with its own.
	assert!(open.contains("alpha/beta"), "the sweep left a nested directory open: {open:?}");
	open.remove("alpha");
	toggle(&mut w, "alpha");
	assert_eq!(drawn(&mut w), expected(&open), "alpha closed over an opened alpha/beta");
}

#[gpui::test]
fn a_file_row_asks_for_the_text_of_the_path_it_lists(app: &mut TestAppContext) {
	let mut w = browsing(app);
	let file = "alpha/beta/delta/epsilon.rs";
	for dir in ancestors(file) {
		toggle(&mut w, dir);
	}
	w.click_text(name(file));
	assert_eq!(
		w.sent(),
		[HostAction::ReadFile { path: file.to_owned() }],
		"the row asks for the path it lists, not its name"
	);
	assert!(w.draws(file), "the viewer shows the file the row named: {:?}", w.texts());
}
