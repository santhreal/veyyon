//! The composer: the well the operator types into.
//!
//! It draws what the session says it is showing. Text entry itself is not here
//! yet — the composer has no keyboard path until a transport exists to send a
//! `UiEvent::ComposerChange`, and a text field that accepts input and discards
//! it would be worse than one that plainly shows state.

use gpui::{App, Div, ParentElement, Styled, div};
use veyyon_presentation::composer::{CompletionState, ComposerMode, ComposerState};
use veyyon_theme::Role;
use veyyon_ui::{
	ActiveTypography, Level, surface,
	text::{caption, label},
	theme::ActiveTheme,
	tokens::{layout, space, text},
};

use crate::chrome::{chip, column, row};

/// The composer region: the well, its mode chip, and whatever sits under it.
pub fn composer(state: &ComposerState, cx: &App) -> Div {
	let mut region = column(space::SNUG)
		.w_full()
		.max_w(layout::READING)
		.child(well(state, cx));

	if let Some(completion) = &state.completion {
		region = region.child(completions(completion, cx));
	}
	if let Some(hint) = &state.hint {
		region = region.child(caption(hint.clone(), cx));
	}
	if state.queue_on_submit {
		region = region.child(caption("Enter queues this until the turn finishes.", cx));
	}
	region
}

/// The input well itself.
fn well(state: &ComposerState, cx: &App) -> Div {
	let empty = state.text.is_empty();
	let content = if empty {
		state.placeholder.clone()
	} else {
		state.text.clone()
	};
	let role = if empty {
		Role::TextMuted
	} else {
		Role::TextPrimary
	};

	surface(Level::Sunken, cx)
		.w_full()
		.p(space::BASE)
		.flex()
		.flex_col()
		.gap(space::SNUG)
		.child(
			row(space::TIGHT)
				.child(chip(mode_label(state.mode), mode_role(state.mode), cx))
				.children(
					state
						.attachments
						.iter()
						.map(|file| chip(file.name.clone(), Role::TextMuted, cx)),
				),
		)
		.child(
			div()
				.w_full()
				.font_family(cx.mono_family())
				.text_size(text::BODY)
				.text_color(cx.color(role))
				.child(content),
		)
}

/// The completion list, on an overlay ground because it covers the transcript
/// rather than sitting in the composer.
fn completions(state: &CompletionState, cx: &App) -> Div {
	let selected = state.selected();
	surface(Level::Overlay, cx)
		.w_full()
		.p(space::TIGHT)
		.flex()
		.flex_col()
		.gap(space::HAIR)
		.child(caption(format!("completing {}", state.prefix), cx))
		.children(state.candidates.iter().map(|candidate| {
			let chosen = selected.is_some_and(|it| it.value == candidate.value);
			let shown = candidate
				.label
				.clone()
				.unwrap_or_else(|| candidate.value.clone());
			let mut line = row(space::SNUG)
				.w_full()
				.justify_between()
				.px(space::TIGHT)
				.py(space::HAIR)
				.rounded(veyyon_ui::tokens::radius::SMALL)
				.child(label(shown, cx).text_color(cx.color(if chosen {
					Role::TextPrimary
				} else {
					Role::TextSecondary
				})));
			if chosen {
				line = line.bg(cx.color(Role::InteractionSelected));
			}
			match &candidate.detail {
				None => line,
				Some(detail) => line.child(caption(detail.clone(), cx)),
			}
		}))
}

fn mode_label(mode: ComposerMode) -> &'static str {
	match mode {
		ComposerMode::Input => "ask",
		ComposerMode::Disabled => "disabled",
		ComposerMode::AwaitingApproval => "waiting for approval",
		ComposerMode::Shell => "shell",
		ComposerMode::Search => "search",
	}
}

fn mode_role(mode: ComposerMode) -> Role {
	match mode {
		ComposerMode::Input => Role::TextAccent,
		ComposerMode::Disabled => Role::TextMuted,
		ComposerMode::AwaitingApproval => Role::StateWarning,
		ComposerMode::Shell => Role::ModeBash,
		ComposerMode::Search => Role::StateInfo,
	}
}

/// WHY THIS SUITE EXISTS.
///
/// The composer's appearance is decided by two tables keyed on
/// [`ComposerMode`], and the failure it closes is a mode that reads as another
/// one — a disabled composer that looks ready, a shell prompt that looks like
/// an ordinary turn.
///
/// WHAT IT DOES NOT CATCH. Whether the well is actually reachable, focusable or
/// typed into. There is no keyboard path yet, and when there is, it is a
/// behavioural test rather than a table one.
#[cfg(test)]
mod tests {
	use veyyon_presentation::fixtures;

	use super::*;

	/// Every mode has its own label and its own role. A shared label is a mode
	/// the operator cannot see they are in.
	#[test]
	fn every_mode_is_distinguishable() {
		let modes = [
			ComposerMode::Input,
			ComposerMode::Disabled,
			ComposerMode::AwaitingApproval,
			ComposerMode::Shell,
			ComposerMode::Search,
		];

		let mut labels: Vec<&str> = modes.iter().copied().map(mode_label).collect();
		labels.sort_unstable();
		let count = labels.len();
		labels.dedup();
		assert_eq!(labels.len(), count, "two modes share a label");

		let mut roles: Vec<Role> = modes.iter().copied().map(mode_role).collect();
		roles.sort_unstable_by_key(|role| role.key());
		let count = roles.len();
		roles.dedup();
		assert_eq!(roles.len(), count, "two modes share a role");
	}

	/// A composer that is not accepting input never carries the role a ready one
	/// does. This is the one pair an operator acts on wrongly: typing into a
	/// composer that will not send.
	#[test]
	fn a_composer_that_cannot_send_never_looks_ready() {
		for mode in [ComposerMode::Disabled, ComposerMode::AwaitingApproval] {
			assert_ne!(mode_role(mode), mode_role(ComposerMode::Input), "{mode:?} looks ready");
		}
	}

	/// Every fixture composer state has a mode this file has a label for, which
	/// the compiler guarantees, and a non-empty label, which it does not.
	#[test]
	fn every_fixture_state_has_a_label() {
		for state in fixtures::composer_states() {
			assert!(!mode_label(state.mode).is_empty(), "{:?} has no label", state.mode);
		}
	}

	/// The highlighted candidate is the one the selection index points at, and
	/// the sentinel highlights nothing. Getting this wrong highlights the first
	/// candidate when none is chosen, which is what an operator then accepts.
	#[test]
	fn only_the_selected_candidate_is_highlighted() {
		let state = fixtures::composer_states()
			.into_iter()
			.find(|state| state.completion.is_some())
			.expect("a fixture composer offers completions");
		let completion = state.completion.expect("checked above");

		let selected = completion
			.selected()
			.expect("the fixture highlights a candidate");
		assert_eq!(selected.value, completion.candidates[0].value);

		let none = CompletionState { selected_index: -1, ..completion };
		assert!(none.selected().is_none());
	}
}
