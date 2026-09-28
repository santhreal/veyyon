//! The footer states what the host reported, the model, the thinking level
//! and the share of the context window, and opens a picker only while the
//! host takes what it picks.
//!
//! WHY: the footer is where the model and the level are read before a prompt
//! is sent. A chip that reads the id where the catalog names the model, a
//! level the host did not report, or a share taken against the wrong limit
//! states a session the host is not running. A models frame that reset the
//! window's state dropped the queue mode and the files chosen here. A picker
//! or a key that opens rows while the host refuses what they pick offers
//! choices nothing can send.
//!
//! Gap: the chips are opened by their actions and keys, not clicked, and
//! their tooltips are not read.

use std::fs;

use gpui::TestAppContext;
use veyyon_desktop_app::actions::composer::{
	CycleThinkingLevel, OpenModelPicker, OpenThinkingPicker,
};
use veyyon_desktop_model::{
	ContextBreakdownView, HostAction, HostActionKind, HostEvent, ModelRef, ModelView, ModelsView,
	QueueMode, SnapshotSection, action_to_capability,
};
use veyyon_test_scratch::scratch_dir;

use super::{Win, capability, sid, streamed, window};

const MODEL: &str = "Claude Sonnet 4.5";

/// The catalog of one model, `current` the id the host runs, at `level`.
pub fn models(current: &str, level: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Models(ModelsView {
		models:          vec![ModelView {
			provider:       "anthropic".to_owned(),
			id:             "claude-sonnet-4.5".to_owned(),
			name:           MODEL.to_owned(),
			reasoning:      true,
			context_window: 200_000,
			max_output:     64_000,
			input:          Vec::new(),
		}],
		current:         Some(ModelRef {
			provider: "anthropic".to_owned(),
			id:       current.to_owned(),
		}),
		thinking_level:  Some(level.to_owned()),
		thinking_levels: ["off", "low", "medium", "high"].map(str::to_owned).to_vec(),
	}))
}

/// Session `s` filling `total` tokens of `limit`.
fn context(total: u64, limit: Option<u64>) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ContextBreakdown(ContextBreakdownView {
		session:      sid(),
		total_tokens: total,
		limit_tokens: limit,
		categories:   Vec::new(),
	}))
}

fn queue_mode(w: &Win<'_>) -> QueueMode {
	w.composer
		.read_with(&*w.cx, |composer, _| composer.queue_mode())
}

#[gpui::test]
fn the_footer_states_the_model_level_and_context_the_host_reported(app: &mut TestAppContext) {
	let tree = scratch_dir("footer-keeps-the-tray");
	let notes = tree.join("notes.txt");
	fs::write(&notes, b"a note").expect("the scratch directory is writable");
	let mut w = window(app, vec![streamed(2)]);
	assert!(w.drew("Select model"), "no catalog has arrived");
	w.focus();
	w.keys("alt-q");
	w.attach(vec![notes]);
	w.drain();

	w.apply(vec![models("claude-sonnet-4.5", "high"), context(82_400, Some(200_000))]);
	assert!(w.drew(MODEL), "the chip names the model the catalog lists");
	assert!(w.drew("Thinking: high"));
	assert!(w.drew("41%"), "82.4k of 200k tokens is 41%");
	assert_eq!(queue_mode(&w), QueueMode::Queue, "the frame left the chord's mode");
	assert_eq!(w.tray(), vec![("notes.txt".to_owned(), b"a note".to_vec())]);

	w.apply(vec![models("claude-opus-5", "low"), context(82_400, None)]);
	assert!(w.drew("claude-opus-5"), "a model the catalog does not list reads as its id");
	assert!(!w.drew(MODEL));
	assert!(w.drew("Thinking: low"));
	assert!(w.drew("82.4k"), "a context with no limit reads as its tokens");
}

#[gpui::test]
fn a_picker_opens_and_a_level_cycles_only_while_the_host_takes_what_they_pick(
	app: &mut TestAppContext,
) {
	let model = action_to_capability(HostActionKind::SelectModel);
	let level = action_to_capability(HostActionKind::SetThinkingLevel);
	let mut w = window(app, vec![
		models("claude-sonnet-4.5", "high"),
		capability(model, Some("no provider is configured")),
		capability(level, Some("no provider is configured")),
	]);
	w.dispatch(OpenModelPicker);
	w.dispatch(OpenThinkingPicker);
	w.dispatch(CycleThinkingLevel);
	assert_eq!(w.count(MODEL), 1, "only the chip names the model");
	assert!(!w.drew("medium"), "the level picker is not open");
	assert_eq!(w.sent(), Vec::new());

	w.apply(vec![capability(model, None), capability(level, None)]);
	w.dispatch(OpenModelPicker);
	assert_eq!(w.count(MODEL), 2, "the chip and the picker's row name the model");
	w.dispatch(OpenThinkingPicker);
	assert!(w.drew("medium"), "the level picker lists the levels");
	w.dispatch(CycleThinkingLevel);
	assert_eq!(
		w.sent(),
		vec![HostAction::SetThinkingLevel { level: "off".to_owned() }],
		"the level after the last is the first"
	);
}
