//! Enter goes to the row the keyboard is on: nothing is sent for the leaf,
//! an unsummarized navigation when the host offers no summary, and each of
//! the terminal's three summary choices when it does. Escape steps back one
//! step, stops a summary being written once, and closes the sheet from the
//! rows; a navigation the host takes closes it and one it refuses returns to
//! the rows in the host's words.

use gpui::TestAppContext;
use veyyon_desktop_model::HostAction;

use super::harness::{Win, abort, branched, browsing, navigate, refused, succeeded};

/// The question the summary choices answer.
const QUESTION: &str = "Summarize the branch you leave?";

/// The field the custom summary's instructions are written in.
const INSTRUCTIONS: &str = "Custom summarization instructions";

impl Win<'_> {
	/// Has the host refuse the one request queued, which must be `expected`,
	/// as `why`.
	fn refuse(&mut self, expected: &HostAction, why: &str) {
		let request = self.one();
		assert_eq!(&request.action, expected);
		self.apply(vec![refused(request.id, why)]);
	}
}

#[gpui::test]
fn enter_on_the_leaf_sends_nothing_and_states_it(app: &mut TestAppContext) {
	let mut w = browsing(app, branched(true));
	w.keys("enter");
	assert!(w.sent().is_empty(), "Enter on the leaf sends nothing");
	assert!(w.draws("Already at this point"), "and states why: {:?}", w.texts());
	assert!(!w.draws(QUESTION), "no summary is offered for the leaf");
	assert_eq!(w.closed(), 0);
}

#[gpui::test]
fn enter_elsewhere_without_a_summary_offered_goes_there_unsummarized(app: &mut TestAppContext) {
	let mut w = browsing(app, branched(false));
	w.keys("up enter");
	assert_eq!(w.one().action, navigate("u2", false, None));
	assert!(!w.draws(QUESTION), "no summary is asked for");
	w.keys("enter");
	assert!(w.sent().is_empty(), "nothing more is sent while the navigation is pending");
}

#[gpui::test]
fn each_summary_choice_sends_its_navigation(app: &mut TestAppContext) {
	let mut w = browsing(app, branched(true));
	w.keys("up");
	// (keys that pick the choice, what the field is given, what is sent)
	let cases: [(&str, Option<&str>, HostAction); 5] = [
		("enter", None, navigate("u2", false, None)),
		("down enter", None, navigate("u2", true, None)),
		("down down enter", Some("  keep the tests  "), navigate("u2", true, Some("keep the tests"))),
		("up enter", Some("   "), navigate("u2", true, None)),
		("down down down enter", None, navigate("u2", false, None)),
	];
	for (keys, instructions, expected) in cases {
		w.keys("enter");
		assert!(w.draws(QUESTION), "a summary is offered: {:?}", w.texts());
		assert!(w.sent().is_empty(), "nothing is sent before a choice");
		w.keys(keys);
		if let Some(instructions) = instructions {
			assert!(w.draws(INSTRUCTIONS), "the custom prompt asks for instructions");
			assert!(w.sent().is_empty(), "nothing is sent before they are written");
			w.write(instructions);
			w.keys("enter");
		}
		w.refuse(&expected, "the branch moved");
		assert!(w.draws("try the other branch"), "a refused navigation returns to the rows");
	}
	w.keys("enter");
	w.click_text("Summarize", 1);
	w.refuse(&navigate("u2", true, None), "the branch moved");
}

#[gpui::test]
fn escape_steps_back_one_step_and_closes_from_the_rows(app: &mut TestAppContext) {
	let mut w = browsing(app, branched(true));
	w.keys("up enter down down enter");
	assert!(w.draws(INSTRUCTIONS));
	w.write("half written");
	w.keys("escape");
	assert!(w.draws(QUESTION), "Escape in the field returns to the choices");
	w.keys("enter");
	assert!(w.draws(INSTRUCTIONS), "with the keyboard on the custom prompt");
	w.keys("escape escape");
	assert!(w.draws("try the other branch"), "Escape on the choices returns to the rows");
	assert!(w.sent().is_empty(), "stepping back sends nothing");
	assert_eq!(w.closed(), 0, "and keeps the sheet");
	w.keys("escape");
	assert_eq!(w.closed(), 1, "Escape on the rows closes the sheet");
	assert!(w.sent().is_empty());
}

#[gpui::test]
fn escape_while_a_summary_is_written_stops_it_once_and_keeps_the_sheet(app: &mut TestAppContext) {
	let mut w = browsing(app, branched(true));
	w.keys("up enter down enter");
	let pending = w.one();
	assert_eq!(pending.action, navigate("u2", true, None));
	assert!(w.draws("Summarizing the branch"), "the sheet states the summary is written");
	w.keys("escape");
	assert_eq!(w.sent(), [abort()], "Escape asks the host to stop the summary");
	assert!(w.draws("Stopping the summary"));
	w.keys("escape escape");
	assert!(w.sent().is_empty(), "the stop is sent once");
	assert_eq!(w.closed(), 0, "and the sheet stays over the navigation in flight");
	w.apply(vec![refused(pending.id, "The branch summary was stopped")]);
	assert!(w.draws("The branch summary was stopped"), "the host's answer is stated");
	assert!(w.draws("try the other branch"), "on the rows");
	w.keys("escape");
	assert!(w.sent().is_empty(), "with nothing pending Escape sends nothing");
	assert_eq!(w.closed(), 1, "and closes the sheet");
}

#[gpui::test]
fn escape_during_an_unsummarized_navigation_sends_nothing(app: &mut TestAppContext) {
	let mut w = browsing(app, branched(false));
	w.keys("up enter");
	let pending = w.one();
	w.keys("escape");
	assert!(w.sent().is_empty(), "there is no summary to stop");
	assert_eq!(w.closed(), 0, "and the navigation in flight keeps the sheet");
	w.apply(vec![succeeded(pending.id)]);
	assert_eq!(w.closed(), 1);
}

#[gpui::test]
fn a_refused_navigation_returns_to_the_rows_in_the_hosts_words(app: &mut TestAppContext) {
	let mut w = browsing(app, branched(false));
	w.keys("up enter");
	w.refuse(&navigate("u2", false, None), "A turn is streaming in this session");
	assert!(w.draws("A turn is streaming in this session"), "{:?}", w.texts());
	assert!(w.draws("try the other branch"), "the rows are drawn again");
	assert_eq!(w.closed(), 0);
	w.keys("enter");
	assert_eq!(w.one().action, navigate("u2", false, None), "the row can be picked again");
	assert!(!w.draws("A turn is streaming"), "sending again clears the refusal");
}

#[gpui::test]
fn a_navigation_the_host_takes_closes_the_sheet(app: &mut TestAppContext) {
	let mut w = browsing(app, branched(false));
	w.keys("home");
	w.click_text("abandoned idea", 1);
	assert_eq!(w.selected().as_deref(), Some("b1"), "a click puts the keyboard on the row");
	assert!(w.sent().is_empty(), "and sends nothing");
	w.click_text("plan the parser", 2);
	let request = w.one();
	assert_eq!(request.action, navigate("u1", false, None), "a double click goes there");
	assert_eq!(w.closed(), 0, "the sheet waits for the host");
	w.apply(vec![succeeded(request.id)]);
	assert_eq!(w.closed(), 1, "and closes once the host took it");
}

#[gpui::test]
fn the_close_button_closes_the_sheet(app: &mut TestAppContext) {
	let mut w = browsing(app, branched(false));
	w.click("tree.close");
	assert_eq!(w.closed(), 1);
	assert!(w.sent().is_empty());
}
