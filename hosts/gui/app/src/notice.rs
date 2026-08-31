//! Native platform notification and chime player bridge.
//!
//! Bridges core notification and chime effects to operating system
//! capabilities: posts notifications to the platform notification center via
//! GPUI, and plays semantic audio chimes via asynchronous platform process
//! execution.

use std::{
	path::PathBuf,
	process::{Command, Stdio},
	sync::{
		LazyLock, Mutex,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
};

use gpui::{App, SystemNotification};
use veyyon_gui_core::model::{NotificationKey, NotificationTone};

/// Result of attempting to play a chime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChimeStatus {
	/// Audio command was successfully spawned.
	Played,
	/// No sound player was resolved on this host.
	Unavailable,
	/// A resolved player failed to spawn.
	SpawnFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoundPlayerKind {
	Afplay,
	Canberra,
	Paplay,
	Aplay,
	Powershell,
}

#[derive(Debug, Clone)]
pub struct ChimePlayer {
	pub program: PathBuf,
	pub kind:    SoundPlayerKind,
}

impl ChimePlayer {
	/// Build arguments for the given notification tone.
	pub fn args_for(&self, tone: NotificationTone) -> Vec<String> {
		match self.kind {
			SoundPlayerKind::Afplay => {
				let sound = match tone {
					NotificationTone::Error => "/System/Library/Sounds/Basso.aiff",
					NotificationTone::Warn => "/System/Library/Sounds/Hero.aiff",
					NotificationTone::Info | NotificationTone::Ok => "/System/Library/Sounds/Tink.aiff",
				};
				vec![sound.to_string()]
			},
			SoundPlayerKind::Canberra => {
				let event_id = match tone {
					NotificationTone::Error => "dialog-error",
					NotificationTone::Warn => "dialog-warning",
					NotificationTone::Info => "message-new-instant",
					NotificationTone::Ok => "complete",
				};
				vec!["-i".to_string(), event_id.to_string()]
			},
			SoundPlayerKind::Paplay => {
				let sound = match tone {
					NotificationTone::Error => "/usr/share/sounds/freedesktop/stereo/dialog-error.oga",
					NotificationTone::Warn => "/usr/share/sounds/freedesktop/stereo/dialog-warning.oga",
					NotificationTone::Info => {
						"/usr/share/sounds/freedesktop/stereo/message-new-instant.oga"
					},
					NotificationTone::Ok => "/usr/share/sounds/freedesktop/stereo/complete.oga",
				};
				if std::path::Path::new(sound).exists() {
					vec![sound.to_string()]
				} else {
					vec!["/usr/share/sounds/freedesktop/stereo/bell.oga".to_string()]
				}
			},
			SoundPlayerKind::Aplay => {
				let sound = "/usr/share/sounds/alsa/Front_Center.wav";
				vec![sound.to_string()]
			},
			SoundPlayerKind::Powershell => {
				let (freq, duration_ms) = match tone {
					NotificationTone::Error => (400, 300),
					NotificationTone::Warn => (600, 200),
					NotificationTone::Info => (800, 150),
					NotificationTone::Ok => (1000, 150),
				};
				vec![
					"-NoProfile".to_string(),
					"-NonInteractive".to_string(),
					"-Command".to_string(),
					format!("[console]::beep({freq}, {duration_ms})"),
				]
			},
		}
	}

	/// Spawn sound playback asynchronously without blocking the UI frame.
	pub fn play(&self, tone: NotificationTone) -> Result<(), std::io::Error> {
		let mut cmd = Command::new(&self.program);
		cmd.args(self.args_for(tone));
		cmd.stdin(Stdio::null());
		cmd.stdout(Stdio::null());
		cmd.stderr(Stdio::null());
		cmd.spawn().map(|_| ())
	}
}

fn resolve_executable(name: &str) -> Option<PathBuf> {
	let p = std::path::Path::new(name);
	if p.is_absolute() || name.contains(std::path::MAIN_SEPARATOR) {
		if p.is_file() {
			return Some(p.to_path_buf());
		}
		return None;
	}

	let path_var = std::env::var_os("PATH")?;
	for dir in std::env::split_paths(&path_var) {
		let candidate = dir.join(name);
		if candidate.is_file() {
			return Some(candidate);
		}
		#[cfg(target_os = "windows")]
		{
			let candidate_exe = dir.join(format!("{name}.exe"));
			if candidate_exe.is_file() {
				return Some(candidate_exe);
			}
		}
	}
	None
}

/// Resolve a platform sound player in priority order once at startup.
pub fn resolve_sound_player() -> Option<ChimePlayer> {
	#[cfg(target_os = "macos")]
	{
		if let Some(path) = resolve_executable("afplay") {
			return Some(ChimePlayer { program: path, kind: SoundPlayerKind::Afplay });
		}
	}

	#[cfg(not(target_os = "windows"))]
	{
		if let Some(path) = resolve_executable("canberra-gtk-play") {
			return Some(ChimePlayer { program: path, kind: SoundPlayerKind::Canberra });
		}
		if let Some(path) = resolve_executable("paplay") {
			return Some(ChimePlayer { program: path, kind: SoundPlayerKind::Paplay });
		}
		if let Some(path) = resolve_executable("aplay") {
			return Some(ChimePlayer { program: path, kind: SoundPlayerKind::Aplay });
		}
		if let Some(path) = resolve_executable("afplay") {
			return Some(ChimePlayer { program: path, kind: SoundPlayerKind::Afplay });
		}
	}

	#[cfg(target_os = "windows")]
	{
		if let Some(path) = resolve_executable("powershell") {
			return Some(ChimePlayer { program: path, kind: SoundPlayerKind::Powershell });
		}
	}

	None
}

static RESOLVED_PLAYER: LazyLock<Option<ChimePlayer>> = LazyLock::new(resolve_sound_player);
static UNAVAILABLE_REPORTED: AtomicBool = AtomicBool::new(false);
static SPAWN_ERROR_REPORTED: AtomicBool = AtomicBool::new(false);
static UNAVAILABLE_COUNT: AtomicUsize = AtomicUsize::new(0);
static LAST_RESPONSE_TAG: Mutex<Option<String>> = Mutex::new(None);

/// Returns whether a chime player was successfully resolved on this host.
pub fn is_chime_available() -> bool {
	RESOLVED_PLAYER.is_some()
}

/// Post an OS notification to the platform notification center.
pub fn perform_system_notification(
	tag: &NotificationKey,
	title: &str,
	body: Option<&str>,
	cx: &App,
) {
	let notification = SystemNotification {
		tag:     tag.as_str().into(),
		title:   title.into(),
		body:    body.unwrap_or("").into(),
		actions: Vec::new(),
	};
	cx.show_system_notification(notification);
}

/// Perform audio chime playback using the resolved platform player.
pub fn perform_chime(tone: NotificationTone) -> ChimeStatus {
	perform_chime_with_state(
		RESOLVED_PLAYER.as_ref(),
		tone,
		&UNAVAILABLE_REPORTED,
		&SPAWN_ERROR_REPORTED,
		&UNAVAILABLE_COUNT,
	)
}

/// Perform audio chime with explicit state references (used for testing).
pub fn perform_chime_with_state(
	player: Option<&ChimePlayer>,
	tone: NotificationTone,
	unavailable_reported: &AtomicBool,
	spawn_error_reported: &AtomicBool,
	unavailable_count: &AtomicUsize,
) -> ChimeStatus {
	let Some(player) = player else {
		let first_time = !unavailable_reported.swap(true, Ordering::Relaxed);
		if first_time {
			unavailable_count.fetch_add(1, Ordering::Relaxed);
			eprintln!("No supported sound player available on host for notification chime");
		}
		return ChimeStatus::Unavailable;
	};

	match player.play(tone) {
		Ok(()) => ChimeStatus::Played,
		Err(err) => {
			let first_time = !spawn_error_reported.swap(true, Ordering::Relaxed);
			if first_time {
				eprintln!("Failed to spawn chime player: {err}");
			}
			ChimeStatus::SpawnFailed
		},
	}
}

/// Initialise platform notification identity and response listener.
pub fn init(cx: &mut App) {
	cx.set_app_identity("dev.veyyon.gui", "Veyyon");
	cx.on_system_notification_response(|response, _cx| {
		if let Ok(mut last) = LAST_RESPONSE_TAG.lock() {
			*last = Some(response.tag.to_string());
		}
	});
}

/// Read the last system notification response tag received.
pub fn last_response_tag() -> Option<String> {
	LAST_RESPONSE_TAG
		.lock()
		.ok()
		.and_then(|guard| guard.clone())
}

/// Clear the recorded system notification response tag.
pub fn clear_last_response_tag() {
	if let Ok(mut last) = LAST_RESPONSE_TAG.lock() {
		*last = None;
	}
}
