//! Notification preferences settings group.
//!
//! Exposes controls for toggling notification chime sounds and configuring
//! whether error toasts persist on screen after being read.

use gpui::{App, ParentElement};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{SettingPath, Value},
};
use veyyon_gui_kit::ui::{Field, Group};

use crate::act;

/// Render the notification preferences group.
pub fn render(store: &Store, _cx: &mut App) -> Group {
	group(store)
}

/// Build the Notification settings group for inclusion in settings pages.
pub fn group(store: &Store) -> Group {
	let sound_enabled = store.replica.notifications.settings.sound;
	let mut sound_switch = crate::settings::controls::switch("notification-sound", sound_enabled);
	sound_switch = sound_switch.on_click(act::click(UiCommand::EditSetting {
		path:  SettingPath("notifications.sound".to_string()),
		value: Value::Bool(!sound_enabled),
	}));

	let persist_errors = store.replica.notifications.settings.persist_errors;
	let mut persist_switch =
		crate::settings::controls::switch("notification-persist-errors", persist_errors);
	persist_switch = persist_switch.on_click(act::click(UiCommand::EditSetting {
		path:  SettingPath("notifications.persist_errors".to_string()),
		value: Value::Bool(!persist_errors),
	}));

	Group::new("Notifications")
		.child(
			Field::new("Notification sound")
				.stacked()
				.note("Plays an audio chime when events or completions occur.")
				.child(sound_switch),
		)
		.child(
			Field::new("Keep error notifications")
				.stacked()
				.note("Retains error toasts on screen until explicitly dismissed.")
				.child(persist_switch),
		)
}
