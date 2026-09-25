//! The console state the autoswarm sweep renders against.
//!
//! Every measure `surface/autoswarm.toml` authors has to be on the frame, so
//! the console carries more than one setup row, more than one logged run, a
//! note and an action: a row height and a row gap are invisible with one row,
//! and a ledger row height is invisible with none.

use veyyon_desktop_model::{
	AutoswarmAction, AutoswarmActionView, AutoswarmConsoleView, AutoswarmFieldKind,
	AutoswarmFieldView, AutoswarmNoteView, AutoswarmOptionView, AutoswarmRunView,
	AutoswarmSwarmView,
};

/// A text row, which is what the goal and the model chain are drawn as.
fn text_row(id: &str, label: &str, text: &str) -> AutoswarmFieldView {
	AutoswarmFieldView {
		id:          id.to_owned(),
		kind:        AutoswarmFieldKind::Text,
		label:       label.to_owned(),
		hint:        "Return sends the line".to_owned(),
		display:     text.to_owned(),
		text:        Some(text.to_owned()),
		placeholder: Some("Say what to optimize".to_owned()),
		number:      None,
		min:         None,
		max:         None,
		on:          None,
		options:     Vec::new(),
	}
}

/// A stepper row, which is what breadth and the attempt count are drawn as.
fn stepper_row(id: &str, label: &str, number: i64) -> AutoswarmFieldView {
	AutoswarmFieldView {
		id:          id.to_owned(),
		kind:        AutoswarmFieldKind::Stepper,
		label:       label.to_owned(),
		hint:        "Left and right step the number".to_owned(),
		display:     format!("{number} arms"),
		text:        None,
		placeholder: None,
		number:      Some(number),
		min:         Some(1),
		max:         Some(8),
		on:          None,
		options:     Vec::new(),
	}
}

/// The segmented row the presets are chosen from, one of them removable so the
/// delete control beside it is on the frame too.
fn preset_row() -> AutoswarmFieldView {
	AutoswarmFieldView {
		id:          "preset".to_owned(),
		kind:        AutoswarmFieldKind::Segmented,
		label:       "Preset".to_owned(),
		hint:        "Left and right take the next one".to_owned(),
		display:     "Balanced".to_owned(),
		text:        Some("balanced".to_owned()),
		placeholder: None,
		number:      None,
		min:         None,
		max:         None,
		on:          None,
		options:     vec![
			AutoswarmOptionView {
				value:     "balanced".to_owned(),
				label:     "Balanced".to_owned(),
				selected:  true,
				removable: false,
			},
			AutoswarmOptionView {
				value:     "overnight".to_owned(),
				label:     "Overnight".to_owned(),
				selected:  false,
				removable: true,
			},
		],
	}
}

/// One logged run of the ledger.
fn run(label: &str, metric: &str, delta: Option<&str>, best: bool) -> AutoswarmRunView {
	AutoswarmRunView {
		label:   label.to_owned(),
		arm:     Some("arm-a".to_owned()),
		metric:  metric.to_owned(),
		delta:   delta.map(ToOwned::to_owned),
		outcome: if best { "best".to_owned() } else { "kept".to_owned() },
		best,
		detail:  vec!["cargo bench --bench parse".to_owned()],
	}
}

/// A console with a swarm recorded on the branch, four setup rows, a note, two
/// actions and two logged runs.
#[must_use]
pub fn console(session: &str) -> AutoswarmConsoleView {
	AutoswarmConsoleView {
		session:    session.to_owned(),
		swarm:      Some(AutoswarmSwarmView {
			name:    Some("parse-throughput".to_owned()),
			branch:  Some("swarm/parse-throughput".to_owned()),
			goal:    "Cut the parse pass below 40ms".to_owned(),
			runs:    2,
			best:    Some("38.1ms".to_owned()),
			running: None,
		}),
		fields:     vec![
			text_row("goal", "Goal", "Cut the parse pass below 40ms"),
			preset_row(),
			stepper_row("breadth", "Breadth", 3),
			text_row("save", "Save as", "overnight"),
		],
		notes:      vec![AutoswarmNoteView {
			id:   "cost".to_owned(),
			text: "Three arms over eight attempts, measured against the recorded baseline."
				.to_owned(),
		}],
		actions:    vec![
			AutoswarmActionView {
				action:  AutoswarmAction::Start,
				label:   "Start".to_owned(),
				verb:    "Runs the swarm on the setup above".to_owned(),
				primary: true,
				blocker: None,
			},
			AutoswarmActionView {
				action:  AutoswarmAction::Reset,
				label:   "Reset".to_owned(),
				verb:    "Returns the worktree to the recorded baseline".to_owned(),
				primary: false,
				blocker: Some("The worktree holds changes the baseline does not.".to_owned()),
			},
		],
		runs:       vec![
			run("Run 2", "38.1ms", Some("-9%"), true),
			run("Run 1", "41.9ms", Some("-0.2%"), false),
		],
		save_field: Some("save".to_owned()),
	}
}
