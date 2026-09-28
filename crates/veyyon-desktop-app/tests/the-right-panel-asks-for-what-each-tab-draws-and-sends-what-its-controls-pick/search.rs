//! A search in the files tab asks the host for the paths and the lines that
//! hold the query, lists each line where it was found, `path:line` beside
//! the matched text, and a match row opens its file at that line. The rows
//! are the answer to the query the tab asked for, drawn over whatever the
//! tab showed when the search ran.
//!
//! WHY: the store holds one answer per search domain, and the host answers
//! requests as they finish rather than in the order they were sent. A slow
//! search answered after a newer one, or a mention lookup from the composer,
//! replaced the answer the tab drew, so the tab stated "0 matching lines"
//! for a query the host had matched. A search run while a file was open
//! drew nothing of its answer until the file was closed. Each query-keyed
//! section the tab draws is answered for another query after the tab's own,
//! and the tab's rows must stay.
//!
//! Gap: what the host's search finds, and the keystroke that submits the
//! field, which `FilesView::search` stands in for.

use gpui::TestAppContext;
use veyyon_desktop_app::panel::PanelTab;
use veyyon_desktop_model::{
	ContentMatch, ContentMatchesView, FileContentView, HostAction, HostEvent, SearchResultsView,
	SnapshotSection,
};

use super::harness::{SESSION, Win, open_file, opened, search, window};

const QUERY: &str = "needle";

/// The host's answer to a search for `query` by file name.
fn paths(query: &str, paths: &[&str]) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::SearchResults(SearchResultsView {
		query:     query.to_owned(),
		paths:     paths.iter().map(|&path| path.to_owned()).collect(),
		truncated: false,
	}))
}

/// The host's answer to a search for `query` by content.
fn lines(query: &str, lines: &[(&str, u32, &str)]) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ContentMatches(ContentMatchesView {
		query:     query.to_owned(),
		matches:   lines
			.iter()
			.map(|&(path, line, preview)| ContentMatch {
				path: path.to_owned(),
				line,
				preview: preview.to_owned(),
			})
			.collect(),
		truncated: false,
	}))
}

/// The host's answer to a search for `QUERY`.
fn found() -> Vec<HostEvent> {
	vec![
		paths(QUERY, &["src/needle.rs"]),
		lines(QUERY, &[("src/app.rs", 12, "  let needle = 1;  "), ("src/lib.rs", 150, "// needle")]),
	]
}

/// The rows the tab draws for `found`.
const ROWS: [&str; 5] = [
	"1 file",
	"src/needle.rs",
	"2 matching lines",
	"src/app.rs:12  let needle = 1;",
	"src/lib.rs:150  // needle",
];

/// Which of `ROWS` the last frame drew.
fn rows(w: &mut Win<'_>) -> Vec<&'static str> {
	ROWS
		.into_iter()
		.filter(|row| w.run_exact(row).is_some())
		.collect()
}

fn searching(app: &mut TestAppContext) -> Win<'_> {
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Files);
	w.requests();
	w
}

#[gpui::test]
fn a_search_lists_each_line_the_host_found_and_opens_it_at_that_line(app: &mut TestAppContext) {
	let mut w = searching(app);
	search(&mut w, &format!("  {QUERY} "));
	assert_eq!(
		w.sent(),
		[HostAction::SearchFiles { query: QUERY.to_owned() }, HostAction::SearchContent {
			query: QUERY.to_owned(),
		},],
		"a search asks for the paths and the lines that hold the trimmed query"
	);
	w.apply(found());
	assert_eq!(rows(&mut w), ROWS, "each path, and each line where it was found: {:?}", w.texts());

	w.click_text(ROWS[4]);
	assert_eq!(w.sent(), [HostAction::ReadFile { path: "src/lib.rs".to_owned() }]);
	let text = (1..=300)
		.map(|n| format!("row {n}"))
		.collect::<Vec<_>>()
		.join("\n");
	w.apply(vec![HostEvent::Snapshot(SnapshotSection::FileContent(FileContentView {
		path:       "src/lib.rs".to_owned(),
		size_bytes: text.len() as u64,
		content:    text,
		truncated:  false,
		binary:     false,
	}))]);
	assert!(w.run_exact("row 150").is_some(), "the matched line is in view: {:?}", w.texts());
	assert!(w.run_exact("row 2").is_none(), "the file is not drawn from its top");

	w.click("files.close");
	assert_eq!(rows(&mut w), ROWS, "closing the file returns to the search it came from");
}

#[gpui::test]
fn an_answer_for_another_query_leaves_the_rows_of_the_one_asked(app: &mut TestAppContext) {
	let mut w = searching(app);
	search(&mut w, QUERY);
	w.requests();
	w.apply(found());
	// A slower search the tab sent before, and a mention lookup the composer
	// sent after, answered once the tab's own answer is drawn.
	for (section, answer) in [
		("paths", paths("src", &["src/lib.rs", "src/app.rs"])),
		("lines", lines("need", &[("src/old.rs", 1, "need")])),
	] {
		w.apply(vec![answer]);
		assert_eq!(rows(&mut w), ROWS, "{section} answered for another query: {:?}", w.texts());
	}

	search(&mut w, "haystack");
	assert_eq!(
		rows(&mut w),
		Vec::<&str>::new(),
		"a query asked since draws none of the last one's rows"
	);
	search(&mut w, QUERY);
	w.apply(found());
	assert_eq!(rows(&mut w), ROWS, "asked again, the query's answer is drawn again");
}

#[gpui::test]
fn a_search_run_over_an_open_file_draws_its_answer(app: &mut TestAppContext) {
	let mut w = searching(app);
	open_file(&mut w, "src/main.rs");
	w.requests();
	search(&mut w, QUERY);
	w.apply(found());
	assert_eq!(rows(&mut w), ROWS, "the answer is drawn in place of the file: {:?}", w.texts());
}
