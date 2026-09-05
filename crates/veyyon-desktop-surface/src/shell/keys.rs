//! Key context and action handlers for the window root and regions (§5.14).
//!
//! Registers the root `Global` key context along with global, queue and
//! transcript action listeners that dispatch typed `Intent`s into the shell
//! view.

use veyyon_gpui::{Context, Div, InteractiveElement};

use crate::{
	Intent, Overlay, PaletteState, Section, ShellView,
	composer::{QueueMode, SecondaryAction, ThinkingControl, TurnPhase, primary_action},
	keymap::actions::{
		AbortTurn, AttachFile, CloseTabOrPark, FilterQueue, FindInTranscript, FocusLive, ModelPicker,
		MoveSelection, NewSession, NextSession, NextTurn, OpenPalette, OpenSelectedSession,
		OpenSettings, PreviousSession, PreviousTurn, Scroll, SelectOption, SplitHalf,
		ThinkingLevel as CycleThinkingLevel, ToggleBlock, ToggleDeferSelected, ToggleDrawer,
		TogglePanel, ToggleParkSelected, TogglePinSelected, ToggleQueue, ToggleQueueMode,
	},
};

/// Binds the root `Shell` key context and registers action handlers.
#[must_use]
pub fn bind_global_keys(root: Div, cx: &Context<ShellView>) -> Div {
	root
		.key_context("Shell")
		.on_action(cx.listener(|view, _: &OpenPalette, _window, _cx| {
			view.dispatch(Intent::OpenOverlay(Box::new(Overlay::Palette(PaletteState::default()))));
		}))
		.on_action(cx.listener(|view, _: &NewSession, _window, _cx| {
			view.dispatch(Intent::NewSession);
		}))
		.on_action(cx.listener(|view, _: &OpenSettings, _window, _cx| {
			view.dispatch(Intent::OpenOverlay(Box::new(Overlay::Settings(Box::default()))));
		}))
		.on_action(cx.listener(|view, _: &ToggleQueue, _window, _cx| {
			view.dispatch(Intent::ToggleQueue);
		}))
		.on_action(cx.listener(|view, _: &ToggleDrawer, _window, _cx| {
			let open = !view.state().drawer_open;
			view.dispatch(Intent::SetDrawer { open });
		}))
		.on_action(cx.listener(|view, _: &TogglePanel, _window, _cx| {
			view.dispatch(Intent::TogglePanel);
		}))
		.on_action(cx.listener(|view, action: &FocusLive, _window, _cx| {
			if let Some((_, rows)) = view
				.state()
				.sections
				.iter()
				.find(|(section, _)| *section == Section::Live)
			{
				let idx = (action.index as usize).saturating_sub(1);
				if let Some(row) = rows.get(idx) {
					view.dispatch(Intent::SelectSession(row.id));
				}
			}
		}))
		.on_action(cx.listener(|view, _: &PreviousSession, _window, _cx| {
			view.dispatch(Intent::MoveQueueSelection(-1));
		}))
		.on_action(cx.listener(|view, _: &NextSession, _window, _cx| {
			view.dispatch(Intent::MoveQueueSelection(1));
		}))
		.on_action(cx.listener(|view, _: &CloseTabOrPark, _window, _cx| {
			view.dispatch(Intent::CloseTabOrPark);
		}))
		.on_action(cx.listener(|view, action: &MoveSelection, _window, _cx| {
			view.dispatch(Intent::MoveQueueSelection(action.delta));
		}))
		.on_action(cx.listener(|view, _: &OpenSelectedSession, _window, _cx| {
			let current = view.state().current_id;
			if current != 0 {
				view.dispatch(Intent::SelectSession(current));
			}
		}))
		.on_action(cx.listener(|view, _: &TogglePinSelected, _window, _cx| {
			let current = view.state().current_id;
			if current != 0 {
				view.dispatch(Intent::PinSession(current));
			}
		}))
		.on_action(cx.listener(|view, _: &ToggleDeferSelected, _window, _cx| {
			let current = view.state().current_id;
			if current != 0 {
				view.dispatch(Intent::DeferSession(current));
			}
		}))
		.on_action(cx.listener(|view, _: &ToggleParkSelected, _window, _cx| {
			let current = view.state().current_id;
			if current != 0 {
				view.dispatch(Intent::ParkSession(current));
			}
		}))
		.on_action(cx.listener(|view, _: &FilterQueue, _window, _cx| {
			view.dispatch(Intent::FilterQueue(String::new()));
		}))
		.on_action(cx.listener(|view, action: &Scroll, _window, _cx| {
			view.dispatch(Intent::ScrollTranscript(action.by));
		}))
		.on_action(cx.listener(|view, _: &FindInTranscript, _window, _cx| {
			view.dispatch(Intent::FindInTranscript);
		}))
		.on_action(cx.listener(|view, _: &PreviousTurn, _window, _cx| {
			view.dispatch(Intent::StepTurn(-1));
		}))
		.on_action(cx.listener(|view, _: &NextTurn, _window, _cx| {
			view.dispatch(Intent::StepTurn(1));
		}))
		.on_action(cx.listener(|view, _: &ToggleBlock, _window, _cx| {
			view.dispatch(Intent::ToggleBlock);
		}))
}

/// Binds the composer-scope chords (§5.14) on the composer's key context.
///
/// Each chord does what the footer or the action row does for the same
/// thing, and nothing the surface does not offer: a chord whose control is
/// absent propagates, so the keystroke reaches the editor as text.
#[must_use]
pub fn bind_composer_keys(composer: Div, cx: &Context<ShellView>) -> Div {
	composer
		.on_action(cx.listener(|view, _: &AbortTurn, _window, cx| {
			if view.state().turn.is_running() {
				view.dispatch(Intent::AbortTurn);
			} else {
				cx.propagate();
			}
		}))
		.on_action(cx.listener(|view, _: &ToggleQueueMode, _window, _cx| {
			let other = match view.state().composer.queue_mode {
				QueueMode::Steer => QueueMode::Queue,
				QueueMode::Queue => QueueMode::Steer,
			};
			view.dispatch(Intent::SetQueueMode(other));
		}))
		// The split button's second half exists only while a turn runs, where
		// it switches to the mode the primary is not.
		.on_action(cx.listener(|view, _: &SplitHalf, _window, cx| {
			let has_text = view.has_composer_text();
			match primary_action(&view.state().turn, has_text).1 {
				Some(SecondaryAction::Queue) => view.dispatch(Intent::SetQueueMode(QueueMode::Queue)),
				Some(SecondaryAction::Steer) => view.dispatch(Intent::SetQueueMode(QueueMode::Steer)),
				_ => cx.propagate(),
			}
		}))
		// A digit answers the open question while the composer is empty;
		// with text in it, the digit is text.
		.on_action(cx.listener(|view, action: &SelectOption, _window, cx| {
			let options = match &view.state().turn {
				TurnPhase::QuestionPending { options, .. } => *options,
				_ => 0,
			};
			let option = usize::from(action.index).wrapping_sub(1);
			if view.has_composer_text() || option >= options {
				cx.propagate();
				return;
			}
			view.dispatch(Intent::Answer { card: 0, option });
		}))
		.on_action(cx.listener(|view, _: &ModelPicker, _window, cx| {
			let palette = view
				.state()
				.composer
				.model
				.as_ref()
				.filter(|model| model.selectable && !model.options.is_empty())
				.map(PaletteState::from_models);
			match palette {
				Some(palette) => {
					view.dispatch(Intent::OpenOverlay(Box::new(Overlay::Palette(palette))));
				},
				None => cx.propagate(),
			}
		}))
		.on_action(cx.listener(|view, _: &CycleThinkingLevel, _window, cx| {
			let next = view
				.state()
				.composer
				.thinking
				.as_ref()
				.and_then(ThinkingControl::next)
				.map(crate::composer::ThinkingLevel::new);
			match next {
				Some(level) => view.dispatch(Intent::SetThinking(level)),
				None => cx.propagate(),
			}
		}))
		.on_action(cx.listener(|view, _: &AttachFile, _window, cx| view.pick_attachments(cx)))
}
