//! Thread titles as the host wrote them, and the elapsed labels a tick of the
//! clock changes.
//!
//! WHY: a title is the operator's own text. A row that trims, collapses or
//! re-encodes it lists a thread under a name nobody gave it: two threads whose
//! titles differ only in inner spaces read as one, and one titled in a script
//! or an emoji the row mangles cannot be found by eye. A title with no text is
//! no name, and a row drawing it blank is a thread with no handle. A tick that
//! redraws the time since each thread was written changes those labels alone:
//! one that retitles or reorders a row moves the thread under the pointer. The
//! suite feeds the listing and the open thread's header, reads the rows the
//! sidebar lists and the text the window draws, and moves the sidebar's clock.
//!
//! Gap: a title wider than its row is truncated when drawn, and that is not
//! asserted; neither is where a label is drawn in its row.

use std::{
	sync::atomic::{AtomicU64, Ordering},
	time::Duration,
};

use gpui::{Entity, TestAppContext, VisualTestContext};
use veyyon_desktop_app::{
	AppState,
	sidebar::{Sidebar, listing::Item},
};
use veyyon_desktop_model::{
	HostEvent, SessionHeaderView, SessionSummary, SnapshotSection, Versioned,
};

use super::{items, listing, sid, sidebar, summary};

const MINUTE_MS: u64 = 60_000;
const HOUR_MS: u64 = 60 * MINUTE_MS;
/// The time the clock test's rows are first drawn at: a hundred days past
/// the epoch.
const T0_MS: u64 = 2_400 * HOUR_MS;

/// The time the clock test's sidebar reads, in milliseconds.
static CLOCK_MS: AtomicU64 = AtomicU64::new(T0_MS);

fn clock() -> u64 {
	CLOCK_MS.load(Ordering::SeqCst)
}

/// A thread under `/w/alpha` last written at `at` and titled `title`.
fn titled(id: &str, title: Option<&str>, at: u64) -> SessionSummary {
	SessionSummary { title: title.map(str::to_owned), ..summary(id, "/w/alpha", at, None) }
}

/// The host opening `id`, its header at `revision` stating `title`.
fn header(id: &str, title: Option<&str>, revision: u64) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
		revision,
		value: SessionHeaderView {
			id:             sid(id),
			schema_version: 1,
			title:          title.map(str::to_owned),
			title_source:   None,
			parent:         None,
			created_at_ms:  0,
			cwd:            "/w/alpha".to_owned(),
			mode:           None,
		},
	}))
}

/// The text the window draws now, in paint order.
fn drawn(cx: &mut VisualTestContext) -> Vec<String> {
	cx.update(|window, _| window.refresh());
	cx.run_until_parked();
	cx.update(|window, _| {
		window
			.rendered_text_runs()
			.iter()
			.map(|run| run.text.to_string())
			.collect()
	})
}

/// The titles of the thread rows the sidebar lists, in list order.
fn listed_titles(
	state: &Entity<AppState>,
	view: &Entity<Sidebar>,
	cx: &VisualTestContext,
) -> Vec<String> {
	let lines = items(view, cx);
	state.read_with(cx, |state, _| {
		lines
			.iter()
			.filter_map(|line| match *line {
				Item::Session { project, row, .. } => state
					.projects()
					.get(project)
					.and_then(|listed| listed.sessions.get(row))
					.map(|row| row.title.clone()),
				_ => None,
			})
			.collect()
	})
}

/// Whether `text` reads as an elapsed label: `now`, or a count of minutes,
/// hours or days.
fn is_elapsed(text: &str) -> bool {
	text == "now"
		|| text
			.strip_suffix(['m', 'h', 'd'])
			.is_some_and(|count| !count.is_empty() && count.bytes().all(|b| b.is_ascii_digit()))
}

/// The elapsed labels among `texts`, in order.
fn elapsed(texts: &[String]) -> Vec<&str> {
	texts
		.iter()
		.map(String::as_str)
		.filter(|text| is_elapsed(text))
		.collect()
}

/// `texts` with each elapsed label replaced by one marker.
fn masked(texts: &[String]) -> Vec<&str> {
	texts
		.iter()
		.map(|text| {
			if is_elapsed(text) {
				"<elapsed>"
			} else {
				text.as_str()
			}
		})
		.collect()
}

#[gpui::test]
fn titles_are_listed_and_drawn_as_the_host_wrote_them_and_one_with_no_text_as_new_session(
	app: &mut TestAppContext,
) {
	let (state, view, cx) = sidebar(app, vec![
		listing(vec![
			titled("path", Some("Review lib/network.rs"), 700),
			titled("script", Some("🚀 Deploy 修正"), 600),
			titled("spaced", Some("fix   the  build"), 500),
			titled("blank", Some("   "), 400),
			titled("breaks", Some("\t\n "), 300),
			titled("untitled", None, 200),
			titled("renamed", Some("to be blanked"), 100),
		]),
		// The open thread's header restates its title: a blank one for
		// `renamed`, then one written mid-turn for `spaced`.
		header("renamed", Some(" \t"), 1),
		header("spaced", Some("fix   the  build ✓"), 2),
	]);

	let verbatim = ["Review lib/network.rs", "🚀 Deploy 修正", "fix   the  build ✓"];
	let fallback = "new session";
	assert_eq!(
		listed_titles(&state, &view, cx),
		[verbatim[0], verbatim[1], verbatim[2], fallback, fallback, fallback, fallback],
		"a title keeps its script and its inner spaces, and one with no text reads new session"
	);
	let texts = drawn(cx);
	for title in verbatim {
		assert!(texts.iter().any(|text| text == title), "{title:?} is drawn as written: {texts:?}");
	}
	assert_eq!(
		texts.iter().filter(|text| *text == fallback).count(),
		4,
		"each thread with no title text is drawn as {fallback:?}: {texts:?}"
	);
}

#[gpui::test]
fn a_clock_tick_changes_the_elapsed_labels_and_leaves_titles_and_order_as_they_were(
	app: &mut TestAppContext,
) {
	let (state, view, cx) = sidebar(app, vec![listing(vec![
		summary("fresh", "/w/alpha", T0_MS - 30_000, None),
		summary("minutes", "/w/alpha", T0_MS - 5 * MINUTE_MS, None),
		summary("hours", "/w/alpha", T0_MS - 2 * HOUR_MS, None),
	])]);
	view.update(cx, |view, cx| view.set_clock(clock, cx));
	let before = drawn(cx);
	let lines = items(&view, cx);
	let titles = listed_titles(&state, &view, cx);
	assert_eq!(elapsed(&before), ["now", "5m", "2h"], "labels at the first frame: {before:?}");
	let renders = view.read_with(cx, |view, _| view.render_count());

	// Two minutes pass; the label timer is the only thing that redraws.
	CLOCK_MS.store(T0_MS + 2 * MINUTE_MS, Ordering::SeqCst);
	cx.executor()
		.advance_clock(Duration::from_millis(2 * MINUTE_MS));
	cx.run_until_parked();
	assert!(
		view.read_with(cx, |view, _| view.render_count()) > renders,
		"the label timer redraws the rows when a label changes"
	);

	let after = drawn(cx);
	assert_eq!(elapsed(&after), ["2m", "7m", "2h"], "labels after the tick: {after:?}");
	assert_eq!(masked(&after), masked(&before), "a tick changes nothing drawn but the labels");
	assert_eq!(items(&view, cx), lines, "a tick keeps the lines in their order");
	assert_eq!(listed_titles(&state, &view, cx), titles, "a tick retitles no thread");
}
