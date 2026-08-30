//! The status bar: what the session is doing, and what it has spent.
//!
//! One row, fixed height, on the status ground. Every segment names a
//! `status.*` role, which is the same vocabulary the terminal's status line
//! draws with, so a theme's status colours mean the same thing in both.

use gpui::{App, Div, ParentElement, Styled, div};
use veyyon_motion::{AnimationExt, WORKING_PULSE, phase};
use veyyon_presentation::{
	status::{ContextGauge, SessionActivity, SessionCost, StatusLineState, StatusNotice},
	transcript::Level as Weight,
};
use veyyon_theme::Role;
use veyyon_ui::{
	Level, surface,
	text::text_in,
	theme::ActiveTheme,
	tokens::{layout, radius, space, stroke, text},
};

use crate::chrome::{chip, duration, edge, row, tokens};

/// The status bar.
pub fn status_bar(state: &StatusLineState, cx: &App) -> Div {
	surface(Level::Window, cx)
		.bg(cx.color(Role::StatusBg))
		.w_full()
		.h(layout::STATUS_BAR)
		.px(space::BASE)
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.border_t(stroke::HAIRLINE)
		.border_color(cx.color(Role::StrokeSubtle))
		.child(left(state, cx))
		.child(right(state, cx))
}

/// What the session is doing, and where.
fn left(state: &StatusLineState, cx: &App) -> Div {
	let mut segments = row(space::SNUG)
		.child(activity(state.activity, state.elapsed_ms, cx))
		.child(separator(cx))
		.child(segment(state.working_directory.clone(), Role::StatusPath, cx));

	if let Some(branch) = &state.git_branch {
		segments = segments.child(segment(branch.clone(), Role::StatusGitClean, cx));
	}
	if state.queued_messages > 0 {
		segments =
			segments.child(chip(format!("{} queued", state.queued_messages), Role::StateInfo, cx));
	}
	match &state.notice {
		None => segments,
		Some(notice) => segments.child(separator(cx)).child(pinned(notice, cx)),
	}
}

/// What the session is costing.
fn right(state: &StatusLineState, cx: &App) -> Div {
	let mut segments = row(space::SNUG).child(segment(state.model.clone(), Role::StatusModel, cx));

	if let Some(effort) = &state.thinking_level {
		segments = segments.child(chip(effort.clone(), effort_role(effort), cx));
	}
	segments
		.child(separator(cx))
		.child(context(state.context, cx))
		.child(separator(cx))
		.child(spend(state.cost, cx))
}

/// The activity segment, pulsing while the session is working.
///
/// The pulse is a repeat, so it is capped and phase-locked to the app's shared
/// clock: every pulsing surface in the window rises and falls together, and an
/// idle session schedules no frames at all.
fn activity(value: SessionActivity, elapsed_ms: u64, cx: &App) -> Div {
	let color = cx.color(activity_role(value));
	let label = row(space::TIGHT)
		.child(div().size(space::SNUG).rounded(radius::SMALL).bg(color))
		.child(segment(activity_label(value), activity_role(value), cx));
	let label = if elapsed_ms == 0 {
		label
	} else {
		label.child(segment(duration(elapsed_ms), Role::StatusSep, cx))
	};

	if !value.is_busy() {
		return div().child(label);
	}
	div().child(label.with_animation("status-activity", WORKING_PULSE.repeating(), |el, t| {
		el.opacity(phase::between(0.55, 1.0, phase::triangle(t)))
	}))
}

/// Context-window occupancy, as a bar and a fraction.
fn context(gauge: ContextGauge, cx: &App) -> Div {
	let color = cx.color(Role::StatusContext);
	let Some(fraction) = gauge.fraction() else {
		return segment("context unknown", Role::TextMuted, cx);
	};

	#[expect(
		clippy::cast_possible_truncation,
		reason = "a percentage of a token count fits in a u32"
	)]
	let percent = (fraction * 100.0).round() as u32;
	row(space::TIGHT)
		.child(
			div()
				.w(space::WIDE * 2.0)
				.h(space::TIGHT)
				.rounded(radius::SMALL)
				.bg(edge(color))
				.child(
					div()
						.w(gpui::relative(fraction))
						.h_full()
						.rounded(radius::SMALL)
						.bg(color),
				),
		)
		.child(segment(format!("{percent}%"), Role::StatusContext, cx))
		.child(segment(
			format!("{} / {}", tokens(gauge.used), tokens(gauge.total)),
			if gauge.provider_reported {
				Role::StatusContext
			} else {
				Role::TextMuted
			},
			cx,
		))
}

/// Cumulative spend.
fn spend(cost: SessionCost, cx: &App) -> Div {
	row(space::TIGHT)
		.child(segment(format!("${:.2}", cost.total_usd), Role::StatusSpend, cx))
		.child(segment(
			format!("{} in / {} out", tokens(cost.input_tokens), tokens(cost.output_tokens)),
			Role::StatusCost,
			cx,
		))
}

/// A notice pinned to the bar.
fn pinned(notice: &StatusNotice, cx: &App) -> Div {
	let role = match notice.level {
		Weight::Info => Role::StateInfo,
		Weight::Warning => Role::StateWarning,
		Weight::Error => Role::StateError,
	};
	chip(notice.text.clone(), role, cx)
}

/// One segment of the bar.
fn segment(content: impl Into<gpui::SharedString>, role: Role, cx: &App) -> Div {
	text_in(content, role, text::SMALL, cx)
}

/// The divider between segments.
fn separator(cx: &App) -> Div {
	segment("·", Role::StatusSep, cx)
}

fn activity_label(value: SessionActivity) -> &'static str {
	match value {
		SessionActivity::Idle => "idle",
		SessionActivity::Thinking => "thinking",
		SessionActivity::Streaming => "streaming",
		SessionActivity::ToolRunning => "running a tool",
		SessionActivity::Compacting => "compacting",
		SessionActivity::WaitingApproval => "waiting for approval",
	}
}

fn activity_role(value: SessionActivity) -> Role {
	match value {
		SessionActivity::Idle => Role::TextMuted,
		SessionActivity::Thinking | SessionActivity::Streaming => Role::TextAccent,
		SessionActivity::ToolRunning => Role::StateInfo,
		SessionActivity::Compacting => Role::StatusSubagents,
		SessionActivity::WaitingApproval => Role::StateWarning,
	}
}

/// The role for a reasoning-effort label.
///
/// The theme has one colour per effort step, and the label arrives as the
/// string the session displays. An unrecognised value takes the neutral role
/// rather than a wrong one, because the effort vocabulary is the model
/// catalog's and can grow without this file.
fn effort_role(label: &str) -> Role {
	match label {
		"off" | "none" => Role::EffortOff,
		"minimal" => Role::EffortMinimal,
		"low" => Role::EffortLow,
		"medium" => Role::EffortMedium,
		"high" => Role::EffortHigh,
		"xhigh" | "max" => Role::EffortXhigh,
		_ => Role::TextSecondary,
	}
}

/// WHY THIS SUITE EXISTS.
///
/// The bar is the surface an operator glances at rather than reads, so its
/// failure mode is a state that looks like a different state: a busy session
/// that reads as idle, an effort step that takes another step's colour, a
/// context bar that shows a full window as empty.
///
/// WHAT IT DOES NOT CATCH. That the pulse actually animates, and the bar's
/// height and ordering on screen. Both need a window.
#[cfg(test)]
mod tests {
	use veyyon_presentation::fixtures;

	use super::*;

	/// Every activity has its own label, and a busy one never carries the idle
	/// role. An operator decides whether to wait from this segment alone.
	#[test]
	fn a_busy_session_never_reads_as_idle() {
		let all = [
			SessionActivity::Idle,
			SessionActivity::Thinking,
			SessionActivity::Streaming,
			SessionActivity::ToolRunning,
			SessionActivity::Compacting,
			SessionActivity::WaitingApproval,
		];

		let mut labels: Vec<&str> = all.iter().copied().map(activity_label).collect();
		labels.sort_unstable();
		let count = labels.len();
		labels.dedup();
		assert_eq!(labels.len(), count, "two activities share a label");

		let idle = activity_role(SessionActivity::Idle);
		for value in all.into_iter().filter(|value| value.is_busy()) {
			assert_ne!(activity_role(value), idle, "{value:?} reads as idle");
		}
	}

	/// Every effort step the settings offer resolves to its own role, and each
	/// of those roles is an `effort.*` one rather than a neighbouring text
	/// colour.
	#[test]
	fn every_effort_step_takes_its_own_role() {
		let steps = ["off", "minimal", "low", "medium", "high", "xhigh"];
		let roles: Vec<Role> = steps.iter().copied().map(effort_role).collect();
		assert_eq!(roles, [
			Role::EffortOff,
			Role::EffortMinimal,
			Role::EffortLow,
			Role::EffortMedium,
			Role::EffortHigh,
			Role::EffortXhigh,
		]);
		for role in &roles {
			assert!(role.key().starts_with("effort."), "{} is not an effort role", role.key());
		}
	}

	/// An effort label the catalog grows takes the neutral role rather than the
	/// nearest match. A wrong colour is worse than a plain one, because the
	/// colours mean severity.
	#[test]
	fn an_unknown_effort_label_is_neutral() {
		assert_eq!(effort_role("ultra"), Role::TextSecondary);
		assert_eq!(effort_role(""), Role::TextSecondary);
		assert_eq!(effort_role("HIGH"), Role::TextSecondary);
	}

	/// A window the provider did not report is drawn as unknown rather than as
	/// an empty one. Dividing by a zero total is the defect: it lays out as a
	/// zero-width bar, which reads as a fresh session.
	#[test]
	fn an_unmeasured_context_window_is_not_an_empty_one() {
		let unknown =
			ContextGauge { used: 42_000, total: 0, provider_reported: false };
		assert_eq!(unknown.fraction(), None);

		let measured = ContextGauge {
			used:              42_000,
			total:             200_000,
			provider_reported: true,
		};
		let fraction = measured
			.fraction()
			.expect("a measured window has a fraction");
		assert!((fraction - 0.21).abs() < 1e-6, "{fraction} is not 21% of the window");
	}

	/// Every fixture status line has a label for its activity and a resolvable
	/// effort, so the bar is exercised against all six activities rather than
	/// the one that happens to be first.
	#[test]
	fn every_fixture_line_resolves_its_segments() {
		let lines = fixtures::status_lines();
		assert_eq!(lines.len(), 6, "the fixtures no longer cover every activity");
		for line in lines {
			assert!(!activity_label(line.activity).is_empty());
			if let Some(effort) = &line.thinking_level {
				assert_eq!(effort_role(effort), Role::EffortHigh, "the fixture effort is 'high'");
			}
			assert!(line.context.fraction().is_some(), "the fixture window is measured");
		}
	}
}
