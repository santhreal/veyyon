//! Notification preferences settings group.
//!
//! Exposes controls for toggling audio chimes, operating system notifications,
//! and configuring whether error toasts persist on screen after being read.

use std::sync::LazyLock;

use gpui::{App, ParentElement};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{SettingPath, Value},
};
use veyyon_gui_kit::ui::{Field, Group};

use crate::act;

fn resolve_executable(name: &str) -> bool {
	let path_var = match std::env::var_os("PATH") {
		Some(var) => var,
		None => return false,
	};
	for dir in std::env::split_paths(&path_var) {
		let candidate = dir.join(name);
		if candidate.is_file() {
			return true;
		}
		#[cfg(target_os = "windows")]
		{
			let candidate_exe = dir.join(format!("{name}.exe"));
			if candidate_exe.is_file() {
				return true;
			}
		}
	}
	false
}

static CHIME_AVAILABLE: LazyLock<bool> = LazyLock::new(|| {
	#[cfg(target_os = "macos")]
	{
		if resolve_executable("afplay") {
			return true;
		}
	}
	#[cfg(not(target_os = "windows"))]
	{
		if resolve_executable("canberra-gtk-play")
			|| resolve_executable("paplay")
			|| resolve_executable("aplay")
			|| resolve_executable("afplay")
		{
			return true;
		}
	}
	#[cfg(target_os = "windows")]
	{
		if resolve_executable("powershell") {
			return true;
		}
	}
	false
});

/// Check whether a supported audio player exists on the host machine.
pub fn is_chime_player_available() -> bool {
	*CHIME_AVAILABLE
}

/// Render the notification preferences group.
pub fn render(store: &Store, _cx: &mut App) -> Group {
	group(store)
}

/// Build the Notification settings group for inclusion in settings pages.
pub fn group(store: &Store) -> Group {
	let chime_available = is_chime_player_available();
	let chime_enabled = chime_available && store.replica.notifications.settings.chime;
	let mut chime_switch = crate::settings::controls::switch("notification-chime", chime_enabled);
	if chime_available {
		chime_switch = chime_switch.on_click(act::click(UiCommand::EditSetting {
			path:  SettingPath("notifications.chime".to_string()),
			value: Value::Bool(!chime_enabled),
		}));
	} else {
		chime_switch = chime_switch.disabled("Host has no sound player");
	}

	let chime_note = if chime_available {
		"Plays an audio chime when background events or completions occur."
	} else {
		"Host has no sound player available (requires afplay, canberra-gtk-play, paplay, aplay, or \
		 powershell)."
	};

	let system_notice_enabled = store.replica.notifications.settings.system_notice;
	let mut system_notice_switch =
		crate::settings::controls::switch("notification-system-notice", system_notice_enabled);
	system_notice_switch = system_notice_switch.on_click(act::click(UiCommand::EditSetting {
		path:  SettingPath("notifications.system_notice".to_string()),
		value: Value::Bool(!system_notice_enabled),
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
			Field::new("Notification chime")
				.stacked()
				.note(chime_note)
				.child(chime_switch),
		)
		.child(
			Field::new("System notifications")
				.stacked()
				.note(
					"Posts notifications to the operating system notification center for background \
					 events.",
				)
				.child(system_notice_switch),
		)
		.child(
			Field::new("Keep error notifications")
				.stacked()
				.note("Retains error toasts on screen until explicitly dismissed.")
				.child(persist_switch),
		)
}
