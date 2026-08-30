//! A link into a sub-agent's own transcript.

use gpui::{App, Div, ParentElement, SharedString, Styled};
use veyyon_gui_contract::view::Agent;
use veyyon_gui_kit::{
	chrome::{chip, column, row},
	text::{caption, text_in},
	tokens::{space, text},
};
use veyyon_gui_motion::{AnimationExt, WORKING_PULSE, phase};
use veyyon_gui_theme::Role;

use crate::tone;

pub fn agent(value: &Agent, cx: &App) -> Div {
	let mut heading = row(space::SNUG).items_baseline().child(text_in(
		value.name.clone(),
		Role::TextLink,
		text::BODY,
		cx,
	));
	if let Some(kind) = &value.kind {
		heading = heading.child(chip(kind.clone(), Role::TextSecondary, cx));
	}
	heading = heading.child(chip(status_label(value), tone::role(status_tone(value)), cx));
	heading = heading.children(
		value
			.badges
			.iter()
			.map(|badge| chip(badge.text.clone(), tone::role(badge.tone), cx)),
	);

	let stack = match &value.summary {
		None => column(space::HAIR).child(heading),
		Some(summary) => column(space::HAIR)
			.child(heading)
			.child(caption(summary.clone(), cx)),
	};
	if !value.running {
		return stack;
	}
	// A running agent pulses. The whole row rather than the name alone: gpui's
	// animation wraps one element, and wrapping the name would put an animated
	// element where the row expects a `Div`.
	column(space::HAIR).child(stack.with_animation(
		SharedString::from(format!("agent-{}", value.id)),
		WORKING_PULSE.repeating(),
		|element, t| element.opacity(pulse(t)),
	))
}

/// How far through the pulse a running agent's name is.
///
/// The name does not fade to nothing: an agent that is working must stay
/// readable, so the trough is well above zero.
pub fn pulse(t: f32) -> f32 {
	const TROUGH: f32 = 0.55;
	TROUGH + (1.0 - TROUGH) * phase::triangle(t)
}

/// What the chip beside an agent's name says.
pub fn status_label(value: &Agent) -> &'static str {
	if value.running { "running" } else { "done" }
}

/// The verdict the chip carries.
///
/// A finished agent takes the tone it reported. A running one takes none: it
/// has not concluded, and colouring it as a success is a verdict on work in
/// flight.
pub fn status_tone(value: &Agent) -> Option<veyyon_gui_contract::view::Tone> {
	if value.running { None } else { value.tone }
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A running agent carries no verdict, and drawing one on it is a claim
	//! about work that has not finished — a green chip on an agent that is about
	//! to fail. The pulse is the other half: an opacity that reaches zero makes
	//! the name of a working agent disappear for part of every cycle, which
	//! reads as a rendering fault rather than as activity.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the link opens the sub-agent's
	//! transcript. Nothing is wired to open one yet.

	use veyyon_gui_contract::{fixtures, view::Tone};

	use super::*;

	#[test]
	fn a_running_agent_carries_no_verdict() {
		let running = fixtures::views::agent();
		assert!(running.running);
		assert_eq!(status_tone(&running), None);
		assert_eq!(status_label(&running), "running");
	}

	#[test]
	fn a_finished_agent_keeps_the_verdict_it_reported() {
		let failed = Agent::new("Lane", "Lane").tone(Tone::Err);
		assert_eq!(status_tone(&failed), Some(Tone::Err));
		assert_eq!(status_label(&failed), "done");
	}

	#[test]
	fn a_running_agent_never_reports_the_verdict_it_was_given() {
		let running = Agent::new("Lane", "Lane").tone(Tone::Ok).running();
		assert_eq!(status_tone(&running), None, "a verdict was drawn on work in flight");
	}

	#[test]
	fn the_pulse_never_makes_the_name_invisible() {
		let mut t = 0.0f32;
		while t <= 1.0 {
			let opacity = pulse(t);
			assert!(opacity >= 0.5, "the name faded to {opacity} at t={t}");
			assert!(opacity <= 1.0, "the name overshot to {opacity} at t={t}");
			t += 0.05;
		}
	}
}
