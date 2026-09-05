//! Key context and action handlers for the window root and regions (§5.14).
//!
//! Registers the root `Global` key context along with global, queue and
//! transcript action listeners that dispatch typed `Intent`s into the shell
//! view.

use veyyon_gpui::{Context, Div, InteractiveElement, KeyDownEvent};

use crate::{
	Intent, Overlay, Section, ShellView,
	composer::{QueueMode, ThinkingControl, TurnPhase},
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
		.capture_key_down(cx.listener(|view, event: &KeyDownEvent, _window, cx| {
			if let Some(palette) = view
				.state_mut()
				.overlay
				.as_mut()
				.and_then(Overlay::as_palette_mut)
			{
				let delta = match event.keystroke.key.as_str() {
					"up" => -1,
					"down" => 1,
					_ => return,
				};
				palette.move_selection(delta);
				cx.stop_propagation();
				cx.notify();
			}
		}))
		.on_action(cx.listener(|view, _: &OpenPalette, window, cx| {
			view.open_command_palette(window, cx);
		}))
		.on_action(cx.listener(|view, _: &NewSession, _window, cx| {
			view.dispatch(Intent::NewSession, cx);
		}))
		.on_action(cx.listener(|view, _: &OpenSettings, _window, cx| {
			view.dispatch(Intent::OpenOverlay(Box::new(Overlay::Settings(Box::default()))), cx);
		}))
		.on_action(cx.listener(|view, _: &ToggleQueue, _window, cx| {
			view.dispatch(Intent::ToggleQueue, cx);
		}))
		.on_action(cx.listener(|view, _: &ToggleDrawer, _window, cx| {
			let open = !view.state().drawer_open;
			view.dispatch(Intent::SetDrawer { open }, cx);
		}))
		.on_action(cx.listener(|view, _: &TogglePanel, _window, cx| {
			view.dispatch(Intent::TogglePanel, cx);
		}))
		.on_action(cx.listener(|view, action: &FocusLive, _window, cx| {
			if let Some((_, rows)) = view
				.state()
				.sections
				.iter()
				.find(|(section, _)| *section == Section::Live)
			{
				let idx = (action.index as usize).saturating_sub(1);
				if let Some(row) = rows.get(idx) {
					view.dispatch(Intent::SelectSession(row.id), cx);
				}
			}
		}))
		.on_action(cx.listener(|view, _: &PreviousSession, _window, cx| {
			view.dispatch(Intent::MoveQueueSelection(-1), cx);
		}))
		.on_action(cx.listener(|view, _: &NextSession, _window, cx| {
			view.dispatch(Intent::MoveQueueSelection(1), cx);
		}))
		.on_action(cx.listener(|view, _: &CloseTabOrPark, _window, cx| {
			view.dispatch(Intent::CloseTabOrPark, cx);
		}))
		.on_action(cx.listener(|view, action: &MoveSelection, _window, cx| {
			view.dispatch(Intent::MoveQueueSelection(action.delta), cx);
		}))
		.on_action(cx.listener(|view, _: &OpenSelectedSession, _window, cx| {
			let current = view.state().current_id;
			if current != 0 {
				view.dispatch(Intent::SelectSession(current), cx);
			}
		}))
		.on_action(cx.listener(|view, _: &TogglePinSelected, _window, cx| {
			let current = view.state().current_id;
			if current != 0 {
				view.dispatch(Intent::PinSession(current), cx);
			}
		}))
		.on_action(cx.listener(|view, _: &ToggleDeferSelected, _window, cx| {
			let current = view.state().current_id;
			if current != 0 {
				view.dispatch(Intent::DeferSession(current), cx);
			}
		}))
		.on_action(cx.listener(|view, _: &ToggleParkSelected, _window, cx| {
			let current = view.state().current_id;
			if current != 0 {
				view.dispatch(Intent::ParkSession(current), cx);
			}
		}))
		.on_action(cx.listener(|view, _: &FilterQueue, _window, cx| {
			view.dispatch(Intent::FilterQueue(String::new()), cx);
		}))
		.on_action(cx.listener(|view, action: &Scroll, _window, cx| {
			view.dispatch(Intent::ScrollTranscript(action.by), cx);
		}))
		.on_action(cx.listener(|view, _: &FindInTranscript, _window, cx| {
			view.dispatch(Intent::FindInTranscript, cx);
		}))
		.on_action(cx.listener(|view, _: &PreviousTurn, _window, cx| {
			view.dispatch(Intent::StepTurn(-1), cx);
		}))
		.on_action(cx.listener(|view, _: &NextTurn, _window, cx| {
			view.dispatch(Intent::StepTurn(1), cx);
		}))
		.on_action(cx.listener(|view, _: &ToggleBlock, _window, cx| {
			view.dispatch(Intent::ToggleBlock, cx);
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
				view.dispatch(Intent::AbortTurn, cx);
			} else {
				cx.propagate();
			}
		}))
		.on_action(cx.listener(|view, _: &ToggleQueueMode, _window, cx| {
			let other = match view.state().composer.queue_mode {
				QueueMode::Steer => QueueMode::Queue,
				QueueMode::Queue => QueueMode::Steer,
			};
			view.dispatch(Intent::SetQueueMode(other), cx);
		}))
		.on_action(cx.listener(|view, _: &SplitHalf, _window, cx| {
			view.submit_alternate_turn_action(cx);
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
			view.dispatch(Intent::Answer { card: 0, option }, cx);
		}))
		.on_action(cx.listener(|view, _: &ModelPicker, window, cx| {
			view.open_model_picker(window, cx);
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
				Some(level) => view.dispatch(Intent::SetThinking(level), cx),
				None => cx.propagate(),
			}
		}))
		.on_action(cx.listener(|view, _: &AttachFile, _window, cx| view.pick_attachments(cx)))
}
