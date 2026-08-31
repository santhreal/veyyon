//! Exhaustive task and phase status presentation.

use veyyon_gui_core::model::TaskStatus;
use veyyon_gui_kit::ui::{Icon, Tone};

pub fn status_label(status: &TaskStatus) -> &'static str {
	match status {
		TaskStatus::Pending => "Pending",
		TaskStatus::Running => "Running",
		TaskStatus::Waiting => "Waiting",
		TaskStatus::Completed => "Completed",
		TaskStatus::Cancelled => "Aborted",
		TaskStatus::Failed => "Failed",
	}
}

pub fn status_tone(status: &TaskStatus) -> Tone {
	match status {
		TaskStatus::Pending => Tone::Muted,
		TaskStatus::Running => Tone::Accent,
		TaskStatus::Waiting => Tone::Warn,
		TaskStatus::Completed => Tone::Ok,
		TaskStatus::Cancelled | TaskStatus::Failed => Tone::Danger,
	}
}

pub fn status_icon(status: &TaskStatus) -> Icon {
	match status {
		TaskStatus::Pending => Icon::Notice,
		TaskStatus::Running => Icon::Running,
		TaskStatus::Waiting => Icon::Notice,
		TaskStatus::Completed => Icon::Check,
		TaskStatus::Cancelled | TaskStatus::Failed => Icon::Failed,
	}
}

pub fn progress(status: &TaskStatus, reported_milli: Option<u16>) -> Option<f32> {
	match (status, reported_milli) {
		(TaskStatus::Completed, _) => Some(1.0),
		(_, Some(value)) => Some(f32::from(value.min(1_000)) / 1_000.0),
		_ => None,
	}
}
