//! A pane the host cut states the cut: a diff that stops at the host's size
//! limit, the changed files it withheld, a tree and a file that stop at
//! theirs, and a search that stopped short; each notice is gone once an
//! answer arrives that was not cut.
//!
//! WHY: the host cuts a working tree, a listing, a file and a search to fit a
//! frame, and a cut the pane does not state reads as the whole answer. A diff
//! the host cut before its first file drew "No changes in the working tree".
//! Each pane is driven through every combination of its cut flags, the diff
//! with and without rows, in both directions: stated when cut, gone when the
//! next answer is whole.
//!
//! Gap: where the notice sits in the pane, and the host's side of the cut.

use gpui::TestAppContext;
use veyyon_desktop_app::panel::PanelTab;
use veyyon_desktop_model::{
	ChangeScope, ChangeStatus, ChangesView, ContentMatch, ContentMatchesView, FileContentView,
	FileKind, FileNode, FileTreeView, HostEvent, SearchResultsView, SnapshotSection,
};

use super::{
	changed, diff,
	harness::{SESSION, opened, search, window},
};

const DIFF_CUT: &str = "The diff stops at the host's size limit.";
const FILES_WITHHELD: &str = "3 more files not shown.";
const CLEAN: &str = "No changes in the working tree";
const TREE_CUT: &str = "The tree stops at the host's size limit";
const FILE_CUT: &str = "The file stops at the host's size limit";
const SEARCH_CUT: &str = "The host stopped short of every match";

/// The working tree's changes as answer `revision`, holding the two changed
/// files when `rows` and none otherwise, cut as `truncated` and `withheld`
/// state.
fn answer(revision: u64, rows: bool, truncated: bool, withheld: u64) -> HostEvent {
	let (files, diff) = if rows {
		(
			vec![
				changed("src/lib.rs", ChangeStatus::Modified, 2, 1),
				changed("README.md", ChangeStatus::Added, 1, 0),
			],
			diff(),
		)
	} else {
		(Vec::new(), String::new())
	};
	HostEvent::Snapshot(SnapshotSection::Changes(ChangesView {
		revision,
		repository: Some("/w/s".to_owned()),
		scope: ChangeScope::WorkingTree,
		files,
		diff,
		diff_truncated: truncated,
		files_withheld: withheld,
	}))
}

#[gpui::test]
fn a_cut_diff_states_what_the_host_held_back_whether_or_not_it_left_rows(app: &mut TestAppContext) {
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Diff);
	w.requests();
	let mut revision = 0;
	for rows in [true, false] {
		for truncated in [false, true] {
			for withheld in [0, 3] {
				revision += 1;
				w.apply(vec![answer(revision, rows, truncated, withheld)]);
				let case = format!("rows {rows}, truncated {truncated}, withheld {withheld}");
				assert_eq!(w.draws(DIFF_CUT), truncated, "{case}: {:?}", w.texts());
				assert_eq!(w.draws(FILES_WITHHELD), withheld > 0, "{case}: {:?}", w.texts());
				assert_eq!(
					w.draws(CLEAN),
					!rows && !truncated && withheld == 0,
					"{case}: only an answer the host did not cut reads as a clean tree"
				);
				assert_eq!(w.draws("fn new_one() {}"), rows, "{case}: the rows it left are drawn");
			}
		}
	}
}

#[gpui::test]
fn the_tree_the_search_and_the_file_state_the_cut_the_host_made(app: &mut TestAppContext) {
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Files);
	w.requests();
	for truncated in [true, false] {
		w.apply(vec![HostEvent::Snapshot(SnapshotSection::FileTree(FileTreeView {
			root: "/w/s".to_owned(),
			entries: vec![FileNode {
				path:  "src/lib.rs".to_owned(),
				name:  "lib.rs".to_owned(),
				kind:  FileKind::File,
				depth: 0,
			}],
			truncated,
		}))]);
		assert!(w.draws("lib.rs"), "the tree draws what it holds: {:?}", w.texts());
		assert_eq!(w.draws(TREE_CUT), truncated, "tree truncated {truncated}: {:?}", w.texts());
	}

	search(&mut w, "needle");
	w.requests();
	for (paths_cut, lines_cut) in [(true, false), (false, true), (true, true), (false, false)] {
		w.apply(vec![
			HostEvent::Snapshot(SnapshotSection::SearchResults(SearchResultsView {
				query:     "needle".to_owned(),
				paths:     vec!["src/needle.rs".to_owned()],
				truncated: paths_cut,
			})),
			HostEvent::Snapshot(SnapshotSection::ContentMatches(ContentMatchesView {
				query:     "needle".to_owned(),
				matches:   vec![ContentMatch {
					path:    "src/lib.rs".to_owned(),
					line:    3,
					preview: "let needle = 1;".to_owned(),
				}],
				truncated: lines_cut,
			})),
		]);
		let case = format!("paths cut {paths_cut}, lines cut {lines_cut}");
		assert!(w.draws("src/needle.rs"), "{case}: the paths found are drawn: {:?}", w.texts());
		assert!(w.draws("let needle = 1;"), "{case}: the lines found are drawn");
		assert_eq!(w.draws(SEARCH_CUT), paths_cut || lines_cut, "{case}: {:?}", w.texts());
	}

	let files = w.panel.read_with(&*w.cx, |panel, _| panel.files().clone());
	w.cx
		.update(|_, cx| files.update(cx, |files, cx| files.open("src/lib.rs".to_owned(), None, cx)));
	w.requests();
	for truncated in [true, false] {
		w.apply(vec![HostEvent::Snapshot(SnapshotSection::FileContent(FileContentView {
			path: "src/lib.rs".to_owned(),
			content: "fn one() {}\n".to_owned(),
			size_bytes: 12,
			truncated,
			binary: false,
		}))]);
		assert!(w.draws("fn one() {}"), "the file draws what it holds: {:?}", w.texts());
		assert_eq!(w.draws(FILE_CUT), truncated, "file truncated {truncated}: {:?}", w.texts());
	}
}
