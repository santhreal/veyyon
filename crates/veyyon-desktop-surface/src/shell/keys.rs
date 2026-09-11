//! Key context and action handlers for the window root and regions (§5.14).
//!
//! Registers the root `Global` key context along with global, queue and
//! transcript action listeners that dispatch typed `Intent`s into the shell
//! view.

use veyyon_desktop_kit::input::editor::actions::{Backspace, Escape, MoveDown, MoveUp};
use veyyon_gpui::{Context, Div, InteractiveElement, KeyDownEvent};

use crate::{
	Intent, Overlay, Section, ShellView,
	composer::{ThinkingControl, TurnPhase},
	keymap::actions::{
		AbortTurn, AttachFile, CloseTabOrPark, Dismiss, FilterQueue, FindInTranscript, FocusLive,
		ModelPicker, MoveSelection, NewSession, NextSession, NextTurn, OpenPalette,
		OpenSelectedSession, OpenSettings, PreviousSession, PreviousTurn, Scroll, SelectOption,
		SplitHalf, TakeBackQueuedPrompt, ThinkingLevel as CycleThinkingLevel, ToggleBlock,
		ToggleDeferSelected, ToggleDrawer, TogglePanel, ToggleParkSelected, TogglePinSelected,
		ToggleQueue, ToggleQueueMode,
	},
};

/// The intent a partition chord dispatches for the session the rail has
/// selected.
///
/// `P`, `D` and `K` are toggles (§5.14): a session already in the partition
/// the chord names comes back out to `Live`, and one anywhere else moves in.
/// The comparison is against the row's placement, not the section it is drawn
/// in, because a row holding a draft draws under `Unsent`, which is no
/// partition to come back out of. Returns `None` when no session is selected,
/// and for a partition no chord names, since there is nothing to move.
fn partition_toggle(view: &ShellView, into: Section) -> Option<Intent> {
	let current = view.state().current_id;
	if current == 0 {
		return None;
	}
	let held = view.state().row(current).map(|row| row.placement) == Some(into);
	match (into, held) {
		(Section::Pinned, false) => Some(Intent::PinSession(current)),
		(Section::Pinned, true) => Some(Intent::UnpinSession(current)),
		(Section::Deferred, false) => Some(Intent::DeferSession(current)),
		(Section::Deferred, true) => Some(Intent::RecallSession(current)),
		(Section::Parked, false) => Some(Intent::ParkSession(current)),
		(Section::Parked, true) => Some(Intent::UnparkSession(current)),
		(Section::Unsent | Section::Live, _) => None,
	}
}

/// Dismisses the topmost thing over the transcript, one rung per press.
///
/// A menu floated at the pointer closes first, a routed overlay steps back one
/// surface, an unrouted one closes, and a queue floated over the transcript at
/// a narrow width closes last, since it is the only rung that is not an
/// overlay in `state.overlay`. Nothing over the transcript propagates, so the
/// editor below keeps its own Escape.
fn dismiss_topmost(view: &mut ShellView, cx: &mut Context<ShellView>) {
	// A menu is floated over every other rung, including a routed overlay, so
	// it is the rung Escape takes first and alone: dismissing the surface under
	// an open menu would take two rungs on one press.
	if view.signal_menu().is_some() || view.turn_menu().is_some() || view.row_menu().is_some() {
		view.close_signal_menu();
		view.close_turn_menu();
		view.close_row_menu();
		cx.stop_propagation();
		cx.notify();
		return;
	}
	let routed = view
		.state()
		.overlay
		.as_ref()
		.and_then(Overlay::route)
		.is_some();
	if routed {
		view.back_surface(cx);
	} else if view.state().overlay.is_some() {
		view.close_palette(cx);
	} else if !view.close_queue_float() {
		cx.propagate();
		return;
	}
	cx.stop_propagation();
	cx.notify();
}

/// Binds the root `Shell` key context and registers action handlers.
#[must_use]
pub fn bind_global_keys(root: Div, cx: &Context<ShellView>) -> Div {
	root
		.key_context("Shell")
		.capture_action(cx.listener(|view, _: &MoveUp, _window, cx| {
			if let Some(palette) = view
				.state_mut()
				.overlay
				.as_mut()
				.and_then(Overlay::as_palette_mut)
			{
				palette.move_selection(-1);
				cx.stop_propagation();
				cx.notify();
			} else {
				cx.propagate();
			}
		}))
		.capture_action(cx.listener(|view, _: &MoveDown, _window, cx| {
			if let Some(palette) = view
				.state_mut()
				.overlay
				.as_mut()
				.and_then(Overlay::as_palette_mut)
			{
				palette.move_selection(1);
				cx.stop_propagation();
				cx.notify();
			} else {
				cx.propagate();
			}
		}))
		.capture_action(cx.listener(|view, _: &Dismiss, _window, cx| {
			dismiss_topmost(view, cx);
		}))
		.capture_action(cx.listener(|view, _: &Escape, _window, cx| {
			dismiss_topmost(view, cx);
		}))
		.capture_action(cx.listener(|view, _: &Backspace, _window, cx| {
			let empty = view
				.state()
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.is_some_and(|p| p.query().is_empty());
			if empty {
				view.back_surface(cx);
				cx.stop_propagation();
			} else {
				cx.propagate();
			}
		}))
		.capture_key_down(cx.listener(|view, event: &KeyDownEvent, _window, cx| {
			let key = event.keystroke.key.as_str();
			let empty_search = view
				.state()
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.is_some_and(|palette| palette.query().is_empty());
			if key.eq_ignore_ascii_case("backspace") && empty_search {
				view.back_surface(cx);
				cx.stop_propagation();
				cx.notify();
				return;
			}
			if let Some(palette) = view
				.state_mut()
				.overlay
				.as_mut()
				.and_then(Overlay::as_palette_mut)
			{
				let delta = match key {
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
			view.navigate_surface(crate::navigation::SurfaceRoute::Settings, cx);
		}))
		.on_action(cx.listener(|view, _: &ToggleQueue, _window, cx| {
			view.toggle_queue(cx);
		}))
		.on_action(cx.listener(|view, _: &ToggleDrawer, _window, cx| {
			let open = !view.state().drawer_open;
			view.dispatch(Intent::SetDrawer { open }, cx);
		}))
		.on_action(cx.listener(|view, _: &TogglePanel, _window, cx| {
			let open = view.state().keymap.panel_collapsed;
			view.dispatch(Intent::SetPanel { open }, cx);
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
			if let Some(intent) = partition_toggle(view, Section::Pinned) {
				view.dispatch(intent, cx);
			}
		}))
		.on_action(cx.listener(|view, _: &ToggleDeferSelected, _window, cx| {
			if let Some(intent) = partition_toggle(view, Section::Deferred) {
				view.dispatch(intent, cx);
			}
		}))
		.on_action(cx.listener(|view, _: &ToggleParkSelected, _window, cx| {
			if let Some(intent) = partition_toggle(view, Section::Parked) {
				view.dispatch(intent, cx);
			}
		}))
		.on_action(cx.listener(|view, _: &FilterQueue, window, cx| {
			view.open_queue_search(window, cx);
		}))
		.on_action(cx.listener(|view, action: &Scroll, _window, cx| {
			view.dispatch(Intent::ScrollTranscript(action.by), cx);
		}))
		.on_action(cx.listener(|view, _: &FindInTranscript, window, cx| {
			view.open_transcript_find(window, cx);
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
			if view.state().turn.is_stoppable() {
				view.dispatch(Intent::AbortTurn, cx);
			} else {
				cx.propagate();
			}
		}))
		.on_action(cx.listener(|view, _: &ToggleQueueMode, _window, cx| {
			view.toggle_queue_mode(cx);
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
		.on_action(cx.listener(|view, _: &TakeBackQueuedPrompt, _window, cx| {
			// Nothing held, nothing to take back: the chord belongs to whatever
			// else claims it rather than emptying the queue of another surface.
			if view.state().composer.queued.is_empty() {
				cx.propagate();
			} else {
				view.dispatch(Intent::DequeueQueuedPrompt, cx);
			}
		}))
}
