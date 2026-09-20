//! WHY THIS SUITE EXISTS
//!
//! Autonomous goal mode presents distinct operational phases (`Active`,
//! `Paused`, `BudgetLimited`, `Complete`, `Dropped`) in both the compact
//! composer footer chip and the expanded goal detail card. The operator must be
//! able to tell at a glance which phase the goal is in, and only valid controls
//! for that phase may be offered (e.g. no Pause on a paused goal, no Resume on
//! an active one).
//!
//! THE CLASS THIS CLOSES: a newly added `GoalStatus` variant rendering with
//! ambiguous or duplicated progress copy, offering illegal state transitions,
//! or silently slipping into the UI without an explicit control policy; and a
//! control that ends the goal drawn as the answer the card invites, which is
//! how a press meant for `Resume` discards the run instead.
//!
//! WHAT IT DOES NOT CATCH: host-side timer ticks, continuation turn generation,
//! or token accounting arithmetic in TypeScript runtime, and the inks the
//! answer row paints, which the colour sweep over the rasterised frames holds.

use std::collections::HashSet;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::TintRole;
use veyyon_desktop_model::{GoalControl, GoalStatus, GoalView};
use veyyon_desktop_surface::{
	Card,
	cards::{affirmative, format_duration, status_tint},
};

#[test]
fn every_goal_status_states_distinct_progress_and_chip_text() {
	let statuses: Vec<GoalStatus> = GoalStatus::iter().collect();

	assert_eq!(
		statuses.len(),
		5,
		"GoalStatus must define exactly 5 variants. An addition requires an explicit decision here."
	);

	let mut seen_chips = HashSet::new();
	let mut seen_labels = HashSet::new();

	for &status in &statuses {
		let view = GoalView {
			objective: "Ship the desktop parity work".to_string(),
			status,
			driving: matches!(status, GoalStatus::Active),
			tokens_used: 20_000,
			token_budget: Some(50_000),
			turns_completed: 3,
			time_used_seconds: 420,
			created_at_ms: 1_700_000_000_000,
			updated_at_ms: 1_700_000_002_000,
			stood_down: match status {
				GoalStatus::BudgetLimited => Some("token budget ceiling reached".to_string()),
				GoalStatus::Paused => Some("operator paused the run".to_string()),
				_ => None,
			},
		};

		let chip_text = view.chip_text();
		assert!(
			seen_chips.insert(chip_text.clone()),
			"GoalStatus::{status:?} produced duplicate chip text '{chip_text}', which collides with \
			 another status"
		);

		let label = status.label();
		assert!(
			seen_labels.insert(label),
			"GoalStatus::{status:?} produced duplicate label '{label}'"
		);

		// Every status states whether it is active, paused, budget-limited, complete or
		// dropped.
		let lower = chip_text.to_lowercase();
		match status {
			GoalStatus::Active => assert!(lower.contains("active"), "chip text must state active"),
			GoalStatus::Paused => assert!(lower.contains("paused"), "chip text must state paused"),
			GoalStatus::BudgetLimited => {
				assert!(lower.contains("budget limited"), "chip text must state budget limited");
			},
			GoalStatus::Complete => {
				assert!(lower.contains("complete"), "chip text must state complete");
			},
			GoalStatus::Dropped => assert!(lower.contains("dropped"), "chip text must state dropped"),
		}

		// Degradation under narrow widths sheds turn count first, then status:
		assert_eq!(view.chip_text_for_width(640.0), format!("Goal: {} · 3 turns", status.label()));
		assert_eq!(view.chip_text_for_width(560.0), format!("Goal: {}", status.label()));
		assert_eq!(view.chip_text_for_width(400.0), "Goal");
	}
}

#[test]
fn every_goal_status_control_set_is_pinned_by_exact_equality() {
	let statuses: Vec<GoalStatus> = GoalStatus::iter().collect();

	for status in statuses {
		let allowed = status.allowed_controls();

		let expected: &[GoalControl] = match status {
			GoalStatus::Active => &[GoalControl::Pause, GoalControl::Drop],
			GoalStatus::Paused => &[GoalControl::Resume, GoalControl::Drop],
			GoalStatus::BudgetLimited => &[GoalControl::Resume, GoalControl::Drop],
			GoalStatus::Complete => &[GoalControl::Drop],
			GoalStatus::Dropped => &[],
		};

		assert_eq!(
			allowed, expected,
			"GoalStatus::{status:?} allowed controls mismatch: expected {expected:?}, got {allowed:?}"
		);

		// Verify invariants:
		// 1. No Resume on an active goal.
		if status == GoalStatus::Active {
			assert!(!allowed.contains(&GoalControl::Resume), "an active goal must never offer Resume");
		}

		// 2. No Pause on a paused or budget-limited goal.
		if matches!(status, GoalStatus::Paused | GoalStatus::BudgetLimited) {
			assert!(
				!allowed.contains(&GoalControl::Pause),
				"a paused or budget-limited goal must never offer Pause"
			);
		}

		// 3. Dropped goals offer no controls.
		if status == GoalStatus::Dropped {
			assert!(allowed.is_empty(), "a dropped goal must offer no controls");
		}
	}
}

#[test]
fn goal_card_ring_tint_matches_status_family() {
	let statuses: Vec<GoalStatus> = GoalStatus::iter().collect();

	for status in statuses {
		let tint = status_tint(status);
		match status {
			GoalStatus::Active => {
				assert_eq!(tint, TintRole::Working, "active goal card ring must be tint.working");
			},
			GoalStatus::Paused | GoalStatus::BudgetLimited => {
				assert_eq!(
					tint,
					TintRole::Attention,
					"paused / budget limited goal card ring must be tint.attention"
				);
			},
			GoalStatus::Complete => {
				assert_eq!(tint, TintRole::Done, "complete goal card ring must be tint.done");
			},
			GoalStatus::Dropped => {
				assert_eq!(tint, TintRole::Input, "dropped goal card ring must be tint.input");
			},
		}
	}
}

#[test]
fn card_answer_count_matches_status_allowed_controls() {
	for status in GoalStatus::iter() {
		let card = Card::Goal {
			view: GoalView {
				objective: "Verify answer count".to_string(),
				status,
				driving: false,
				tokens_used: 100,
				token_budget: None,
				turns_completed: 1,
				time_used_seconds: 10,
				created_at_ms: 0,
				updated_at_ms: 0,
				stood_down: None,
			},
		};

		assert_eq!(
			card.answer_count(),
			status.allowed_controls().len(),
			"Card::answer_count for Goal in status {status:?} must match allowed_controls count"
		);
	}
}

#[test]
fn goal_card_duration_formatting_covers_ranges() {
	assert_eq!(format_duration(0), "0s");
	assert_eq!(format_duration(45), "45s");
	assert_eq!(format_duration(60), "1m 0s");
	assert_eq!(format_duration(125), "2m 5s");
	assert_eq!(format_duration(3600), "1h 0m");
	assert_eq!(format_duration(7325), "2h 2m");
}

#[test]
fn every_goal_control_states_its_words_and_whether_it_ends_the_goal() {
	// The sweep is the enum, so a control added to it arrives here without an
	// edit and fails until its row is written.
	let stated: Vec<(&str, bool)> = GoalControl::iter()
		.map(|c| (c.label(), c.ends_the_goal()))
		.collect();

	assert_eq!(
		stated,
		vec![("Pause", false), ("Resume", false), ("Drop", true)],
		"a control added to GoalControl must state its words and whether it ends the goal"
	);
}

#[test]
fn no_goal_status_hands_the_accent_to_a_control_that_ends_the_goal() {
	for status in GoalStatus::iter() {
		let controls = status.allowed_controls();
		let invited = affirmative(controls.iter().map(|c| c.ends_the_goal()));

		let expected = match status {
			GoalStatus::Active => Some("Pause"),
			GoalStatus::Paused | GoalStatus::BudgetLimited => Some("Resume"),
			GoalStatus::Complete | GoalStatus::Dropped => None,
		};
		assert_eq!(
			invited.map(|index| controls[index].label()),
			expected,
			"GoalStatus::{status:?} invites the wrong answer"
		);

		assert!(
			invited.is_none_or(|index| !controls[index].ends_the_goal()),
			"GoalStatus::{status:?} hands the accent to a control that ends the goal"
		);
	}
}

#[test]
fn the_accent_falls_on_the_last_answer_that_does_not_end_the_subject() {
	assert_eq!(affirmative([]), None, "an empty row invites nothing");
	assert_eq!(affirmative([true]), None, "a row of one destructive answer invites nothing");
	assert_eq!(affirmative([true, true]), None, "a row of destructive answers invites nothing");
	assert_eq!(affirmative([false, true]), Some(0), "the accent skips back over the last answer");
	assert_eq!(affirmative([false, false, true]), Some(1), "the accent takes the later quiet one");
	assert_eq!(affirmative([true, false]), Some(1), "a quiet answer last takes the accent");
}
