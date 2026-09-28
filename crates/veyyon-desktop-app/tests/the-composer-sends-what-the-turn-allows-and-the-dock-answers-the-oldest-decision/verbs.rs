//! The composer answers the verbs the terminal binds a key to: it copies the
//! draft, steps the model through the host's list and holds a model for the
//! shown thread only.
//!
//! WHY: each verb had no desktop surface, so the key reached for did nothing.
//! A step or a thread-only pick sent as the default rewrites the model every
//! later thread starts on. A step that does not wrap stops at the end of the
//! list, and one taken from the wrong place skips a model. A copy of an empty
//! draft empties a clipboard the operator filled elsewhere.
//!
//! Gap: the palette rows for these verbs are not driven here, and a model is
//! picked with the keys, not a click.

use gpui::{ClipboardItem, TestAppContext};
use veyyon_desktop_app::actions::composer::OpenModelPicker;
use veyyon_desktop_model::{
	HostAction, HostActionKind, HostEvent, ModelRef, ModelView, ModelsView, SnapshotSection,
	action_to_capability,
};

use super::{capability, window};

/// The catalog listing `ids` in order, the host running `current`.
fn catalog(ids: &[&str], current: &str) -> HostEvent {
	let model = |id: &&str| ModelView {
		provider:       "anthropic".to_owned(),
		id:             (*id).to_owned(),
		name:           format!("Model {id}"),
		reasoning:      true,
		context_window: 200_000,
		max_output:     64_000,
		input:          Vec::new(),
	};
	HostEvent::Snapshot(SnapshotSection::Models(ModelsView {
		models:          ids.iter().map(model).collect(),
		current:         Some(ModelRef {
			provider: "anthropic".to_owned(),
			id:       current.to_owned(),
		}),
		thinking_level:  None,
		thinking_levels: Vec::new(),
	}))
}

/// The host taking a model.
fn takes_models() -> HostEvent {
	capability(action_to_capability(HostActionKind::SelectModel), None)
}

fn select(id: &str, persist: bool) -> HostAction {
	HostAction::SelectModel { provider: "anthropic".to_owned(), model: id.to_owned(), persist }
}

#[gpui::test]
fn the_draft_is_copied_as_it_reads_and_an_empty_draft_copies_nothing(app: &mut TestAppContext) {
	let mut w = window(app, Vec::new());
	w.write("line one\n\tline two");
	w.focus();
	w.keys("alt-shift-c");
	let copied = w.cx.read_from_clipboard().and_then(|item| item.text());
	assert_eq!(copied.as_deref(), Some("line one\n\tline two"));

	w.cx
		.write_to_clipboard(ClipboardItem::new_string("kept".to_owned()));
	w.write("");
	w.focus();
	w.keys("alt-shift-c");
	let copied = w.cx.read_from_clipboard().and_then(|item| item.text());
	assert_eq!(copied.as_deref(), Some("kept"), "an empty draft leaves the clipboard");
	assert_eq!(w.sent(), Vec::new(), "copying asks the host nothing");
}

#[gpui::test]
fn a_step_holds_the_neighbouring_model_for_this_thread_and_wraps_at_either_end(
	app: &mut TestAppContext,
) {
	let mut w = window(app, vec![takes_models(), catalog(&["a", "b", "c"], "b")]);
	w.focus();
	w.keys("ctrl-p");
	w.keys("ctrl-alt-p");
	assert_eq!(w.sent(), vec![select("c", false), select("a", false)]);

	w.apply(vec![catalog(&["a", "b", "c"], "c")]);
	w.keys("ctrl-p");
	w.apply(vec![catalog(&["a", "b", "c"], "a")]);
	w.keys("ctrl-alt-p");
	assert_eq!(w.sent(), vec![select("a", false), select("c", false)], "each end wraps");

	w.apply(vec![catalog(&["a", "b", "c"], "gone")]);
	w.keys("ctrl-p");
	assert_eq!(w.sent(), vec![select("b", false)], "a model the list lacks steps from the first");

	w.apply(vec![catalog(&["a"], "a")]);
	w.keys("ctrl-p");
	w.keys("ctrl-alt-p");
	assert_eq!(w.sent(), Vec::new(), "a list of one model steps nowhere");

	w.apply(vec![
		catalog(&["a", "b"], "a"),
		capability(action_to_capability(HostActionKind::SelectModel), Some("no provider")),
	]);
	w.keys("ctrl-p");
	assert_eq!(w.sent(), Vec::new(), "no step is sent while the host takes no model");
}

#[gpui::test]
fn a_model_picked_for_this_thread_is_held_and_one_picked_as_the_default_persists(
	app: &mut TestAppContext,
) {
	let mut w = window(app, vec![takes_models(), catalog(&["a", "b"], "a")]);
	w.focus();
	w.keys("alt-p");
	w.keys("down down enter");
	assert_eq!(w.sent(), vec![select("b", false)], "the thread's picker persists nothing");

	w.dispatch(OpenModelPicker);
	w.keys("down down enter");
	assert_eq!(w.sent(), vec![select("b", true)], "the default picker persists its pick");
}
