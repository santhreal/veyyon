//! Senders the composer, the dock and the autoswarm console draw.
//!
//! The composer is reached with the keys it holds from the first frame: text
//! typed into its editor, Enter, its chords, and the palette rows that return
//! the keys to it before they run. Its footer chips and its strips are
//! clicked where they draw. The dock draws only what the host sent, so a
//! dock drive seeds the decision, the goal or the console first and then
//! clicks the control it draws.

mod dock;
mod editor;

use gpui::{Bounds, Pixels};
use veyyon_desktop_model::HostActionKind;

use crate::{Sender, harness::Win};

pub const SENDERS: &[Sender] = &[
	// The composer's editor and its keys.
	Sender {
		kind:    HostActionKind::SubmitPrompt,
		control: "Enter in the composer's editor on an idle thread",
		drive:   editor::submit_prompt,
	},
	Sender {
		kind:    HostActionKind::AbortTurn,
		control: "the composer's Stop chord during a running turn",
		drive:   editor::abort_turn,
	},
	Sender {
		kind:    HostActionKind::Steer,
		control: "Enter in the composer's editor during a running turn",
		drive:   editor::steer,
	},
	Sender {
		kind:    HostActionKind::FollowUp,
		control: "Enter on a `/queue` draft during a running turn",
		drive:   editor::follow_up,
	},
	Sender {
		kind:    HostActionKind::SearchPromptHistory,
		control: "Up in the composer's empty editor",
		drive:   editor::search_prompt_history,
	},
	Sender {
		kind:    HostActionKind::ReportComposerDraft,
		control: "typing in the composer's editor",
		drive:   editor::report_composer_draft,
	},
	Sender {
		kind:    HostActionKind::CompleteComposer,
		control: "typing in the composer's editor while an extension completes",
		drive:   editor::complete_composer,
	},
	Sender {
		kind:    HostActionKind::ListCommands,
		control: "a `/` typed at the start of the composer's draft",
		drive:   editor::list_commands,
	},
	Sender {
		kind:    HostActionKind::RunCommand,
		control: "Enter on a draft naming a command the host lists",
		drive:   editor::run_command,
	},
	Sender {
		kind:    HostActionKind::SearchFiles,
		control: "an `@` path typed in the composer's draft",
		drive:   editor::search_files,
	},
	// The composer's footer.
	Sender {
		kind:    HostActionKind::SetQueueMode,
		control: "the composer's Steer chip during a running turn",
		drive:   editor::set_queue_mode,
	},
	Sender {
		kind:    HostActionKind::SetSessionMode,
		control: "the mode chip's Vibe mode row",
		drive:   editor::set_session_mode,
	},
	Sender {
		kind:    HostActionKind::ReviewPlan,
		control: "the mode chip's Review the plan row in plan mode",
		drive:   editor::review_plan,
	},
	Sender {
		kind:    HostActionKind::SelectModel,
		control: "a model row of the model chip's picker",
		drive:   editor::select_model,
	},
	Sender {
		kind:    HostActionKind::RefreshModels,
		control: "the model chip's Refresh models row",
		drive:   editor::refresh_models,
	},
	Sender {
		kind:    HostActionKind::SetThinkingLevel,
		control: "a level row of the thinking chip's picker",
		drive:   editor::set_thinking_level,
	},
	Sender {
		kind:    HostActionKind::SetGoal,
		control: "the palette's Set goal from the draft row",
		drive:   editor::set_goal,
	},
	Sender {
		kind:    HostActionKind::ToggleDictation,
		control: "the palette's Dictate row",
		drive:   editor::toggle_dictation,
	},
	// The strips above the composer's frame.
	Sender {
		kind:    HostActionKind::DequeueQueuedPrompt,
		control: "the queued strip's Edit last button",
		drive:   editor::dequeue_queued_prompt,
	},
	Sender {
		kind:    HostActionKind::BackgroundCommand,
		control: "the running command strip's Background button",
		drive:   editor::background_command,
	},
	Sender {
		kind:    HostActionKind::CancelDictation,
		control: "the dictation strip's Cancel button",
		drive:   editor::cancel_dictation,
	},
	// The dock.
	Sender {
		kind:    HostActionKind::RespondToInteraction,
		control: "the approval card's Allow once button",
		drive:   dock::respond_to_interaction,
	},
	Sender {
		kind:    HostActionKind::ControlGoal,
		control: "the goal strip's Pause button",
		drive:   dock::control_goal,
	},
	Sender {
		kind:    HostActionKind::SetAutoswarmField,
		control: "an option of the autoswarm console's preset row",
		drive:   dock::set_autoswarm_field,
	},
	Sender {
		kind:    HostActionKind::RunAutoswarmAction,
		control: "the autoswarm console's Start swarm button",
		drive:   dock::run_autoswarm_action,
	},
	Sender {
		kind:    HostActionKind::SaveAutoswarmPreset,
		control: "the autoswarm console's Save preset button",
		drive:   dock::save_autoswarm_preset,
	},
	Sender {
		kind:    HostActionKind::DeleteAutoswarmPreset,
		control: "the autoswarm console's delete button beside a saved preset",
		drive:   dock::delete_autoswarm_preset,
	},
	Sender {
		kind:    HostActionKind::CloseAutoswarmConsole,
		control: "the autoswarm console's Close button",
		drive:   dock::close_autoswarm_console,
	},
];

/// The bounds of the first run a fresh frame draws reading `text` once
/// trimmed inside the driver target `region`, so a word another region also
/// draws is not the one found.
fn text_in(w: &mut Win<'_>, region: &str, text: &str) -> Bounds<Pixels> {
	w.cx.update(|window, _| window.refresh());
	w.cx.run_until_parked();
	let within = w
		.bounds(region)
		.unwrap_or_else(|| panic!("the window lays out {region}"));
	let found = w.cx.update(|window, _| {
		window
			.rendered_text_runs()
			.iter()
			.find(|run| run.text.trim() == text && within.contains(&run.bounds.center()))
			.map(|run| run.bounds)
	});
	found.unwrap_or_else(|| panic!("{region} draws {text:?}"))
}

/// Clicks the first run reading `text` inside the driver target `region`.
fn click_text_in(w: &mut Win<'_>, region: &str, text: &str) {
	let at = text_in(w, region, text).center();
	w.click_at(at);
}
