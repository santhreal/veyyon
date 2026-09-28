//! The composer: its height in the thread, what send does in each phase of a
//! turn, the refused prompt, the draft it reports and what it renders for.

use std::time::Duration;

use gpui::{TestAppContext, px};
use veyyon_desktop_app::{
	actions::composer::{Stop, Submit, ToggleQueueMode},
	composer::Composer,
};
use veyyon_desktop_model::{HostAction, HostEvent, QueueMode};
use veyyon_desktop_ui::{
	editor::actions::MoveLeft,
	theme::{size, text},
};

use super::{WINDOW, Win, refused, report, sid, streamed, window};

#[gpui::test]
fn the_first_frame_lays_the_composer_out_at_the_height_it_settles_to(app: &mut TestAppContext) {
	let mut w = window(app, Vec::new());
	let seed = Composer::min_height();
	assert_eq!(w.composer_height(), seed, "the empty composer drew at the height it was seeded at");
	let drawn = w.bounds("composer").expect("the composer is laid out");
	assert_eq!(drawn.size.height, seed);
	assert_eq!(drawn.bottom(), px(WINDOW.1), "the composer sits on the thread's bottom edge");
}

#[gpui::test]
fn the_editor_grows_from_three_rows_to_two_fifths_of_the_thread_and_the_thread_follows(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	let row = text::BODY.line_height;
	let seed = Composer::min_height();

	w.write("one\ntwo\nthree\nfour\nfive\nsix");
	assert_eq!(w.composer_height(), seed + row * 3.0, "six rows are three past the fewest");
	let drawn = w.bounds("composer").expect("the composer is laid out");
	assert_eq!(drawn.size.height, seed + row * 3.0);
	assert_eq!(drawn.bottom(), px(WINDOW.1), "the thread laid the grown composer out whole");

	let long: Vec<String> = (0..200).map(|line| line.to_string()).collect();
	w.write(&long.join("\n"));
	let rows = ((px(WINDOW.1) - size::HEADER) * 0.4 / row).floor();
	assert_eq!(
		w.composer_height(),
		seed + row * (rows - 3.0),
		"the editor stops at 40% and scrolls"
	);
	let drawn = w.bounds("composer").expect("the composer is laid out");
	assert_eq!(drawn.bottom(), px(WINDOW.1));

	w.write("");
	assert_eq!(w.composer_height(), seed, "an emptied draft shrinks back to three rows");
}

#[gpui::test]
fn send_starts_a_turn_and_a_running_turn_takes_a_steer_a_queued_prompt_or_a_stop(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	w.write("Index the repo.");
	w.dispatch(Submit);
	assert_eq!(w.sent(), vec![HostAction::SubmitPrompt {
		session:     sid(),
		text:        "Index the repo.".to_owned(),
		attachments: Vec::new(),
	}]);
	assert_eq!(w.draft(), "", "the sent prompt leaves the draft");

	w.apply(vec![streamed(2)]);
	w.dispatch(Submit);
	assert_eq!(w.sent(), Vec::new(), "an empty draft sends nothing into a running turn");
	w.write("Skip vendor.");
	w.dispatch(Submit);
	assert_eq!(w.sent(), vec![HostAction::Steer {
		session: sid(),
		text:    "Skip vendor.".to_owned(),
	}]);

	w.dispatch(ToggleQueueMode);
	assert_eq!(w.sent(), vec![HostAction::SetQueueMode {
		session: sid(),
		mode:    QueueMode::Queue,
	}]);
	w.write("Then run the tests.");
	w.dispatch(Submit);
	assert_eq!(w.sent(), vec![HostAction::FollowUp {
		session: sid(),
		text:    "Then run the tests.".to_owned(),
	}]);

	w.write("/steer Stop at the first failure.");
	w.dispatch(Submit);
	assert_eq!(
		w.sent(),
		vec![HostAction::Steer { session: sid(), text: "Stop at the first failure.".to_owned() }],
		"/steer steers whatever the queue mode",
	);

	w.dispatch(Stop);
	assert_eq!(w.sent(), vec![HostAction::AbortTurn { session: sid() }]);

	w.apply(vec![HostEvent::StreamingChanged(None)]);
	w.write("/queue Later.");
	w.dispatch(Submit);
	assert_eq!(
		w.sent(),
		vec![HostAction::FollowUp { session: sid(), text: "Later.".to_owned() }],
		"/queue queues on an idle session too",
	);
}

#[gpui::test]
fn a_prompt_the_host_refuses_goes_back_into_the_draft_and_is_offered_again(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	w.write("Index the repo.");
	w.dispatch(Submit);
	let request = w
		.requests()
		.first()
		.map(|request| request.id)
		.expect("the prompt was sent");
	assert!(!w.drew("Not sent"));

	w.apply(vec![refused(request)]);
	assert_eq!(w.draft(), "Index the repo.", "the refused prompt is back in the draft");
	assert!(w.drew("Not sent"), "the refused strip offers the prompt again");
}

#[gpui::test]
fn a_streamed_delta_renders_neither_region_and_a_keystroke_renders_only_the_composer(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	w.apply(vec![streamed(2)]);
	let started = w.renders();
	for revision in 3..30 {
		w.apply(vec![streamed(revision)]);
	}
	assert_eq!(w.renders(), started, "a streamed delta renders neither the composer nor the dock");

	w.typed("a");
	for key in ["b", "c", "d"] {
		let (composer, dock) = w.renders();
		w.typed(key);
		assert_eq!(w.renders(), (composer + 1, dock), "{key:?} rendered the composer once");
	}
	assert_eq!(w.draft(), "abcd");
}

/// The draft reports each request the harness drained, in order.
fn drained_reports(w: &mut Win<'_>) -> Vec<(String, u32)> {
	w.drain()
		.iter()
		.filter_map(|request| report(&request.action))
		.collect()
}

#[gpui::test]
fn the_draft_and_its_caret_reach_the_host_once_per_position(app: &mut TestAppContext) {
	let mut w = window(app, Vec::new());
	let shown = drained_reports(&mut w);
	assert_eq!(shown, vec![(String::new(), 0)], "the shown session's draft is reported");

	w.typed("ab");
	w.dispatch(MoveLeft);
	// Each caret blink phase repaints the editor; none of them moves the draft.
	w.cx.executor().advance_clock(Duration::from_secs(5));
	w.cx.run_until_parked();
	let reports = drained_reports(&mut w);
	assert!(reports.contains(&("ab".to_owned(), 2)), "the typed draft is reported: {reports:?}");
	assert_eq!(reports.last(), Some(&("ab".to_owned(), 1)), "a caret move alone is reported");
	assert!(
		reports.windows(2).all(|pair| pair[0] != pair[1]),
		"each position is reported once: {reports:?}"
	);
	assert!(!reports.contains(&(String::new(), 0)), "focusing the unchanged draft reports nothing");
}
