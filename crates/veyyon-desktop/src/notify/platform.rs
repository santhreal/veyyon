//! The carrier that reaches the operator's own desktop.
//!
//! Each platform already has the two programs this needs, and neither is
//! reimplemented here: the sound is whatever the desktop's alert player is,
//! and the notification is whatever its notification service accepts. The
//! command is spawned rather than run to completion, because a notification
//! service that is not answering blocks for its own timeout and the window
//! draws frames in the meantime. A binary that is not installed fails at the
//! spawn, which is the failure worth stating.

use std::{
	io,
	process::{Command, Stdio},
	thread,
};

use veyyon_desktop_model::{Notification, NotificationPriority};

use super::NoticeCarrier;

/// The name the desktop's notification service groups the window's
/// announcements under.
pub const APP_NAME: &str = "veyyon";

/// The carrier that spawns the platform's own notifier.
#[derive(Debug, Clone, Copy, Default)]
pub struct DesktopCarrier;

/// How urgent the platform's notification service is told this is.
#[must_use]
const fn urgency(priority: NotificationPriority) -> &'static str {
	match priority {
		NotificationPriority::Low => "low",
		NotificationPriority::Normal => "normal",
		NotificationPriority::Urgent => "critical",
	}
}

/// Spawns one command and reaps it on a thread of its own.
fn spawn(argv: &[&str]) -> io::Result<()> {
	let (program, rest) = argv
		.split_first()
		.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "a command with no program"))?;
	let mut child = Command::new(program)
		.args(rest)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()?;
	// Nothing reads the result: what the operator would learn from it, they
	// learn from whether they heard it. The wait is only so the process is
	// not left for the window to collect.
	thread::spawn(move || {
		let _ = child.wait();
	});
	Ok(())
}

/// Spawns each candidate until one starts, stating every one that did not.
///
/// The sound players are alternatives, not a fallback chain with a preferred
/// member: a desktop has whichever of them its session installed.
fn spawn_first(candidates: &[&[&str]]) -> Result<(), String> {
	let mut refusals: Vec<String> = Vec::new();
	for argv in candidates {
		match spawn(argv) {
			Ok(()) => return Ok(()),
			Err(error) => refusals.push(format!("{program}: {error}", program = argv[0])),
		}
	}
	Err(refusals.join("; "))
}

#[cfg(target_os = "linux")]
fn sound_candidates() -> Vec<Vec<String>> {
	vec![vec!["canberra-gtk-play".to_owned(), "-i".to_owned(), "message".to_owned()], vec![
		"paplay".to_owned(),
		"/usr/share/sounds/freedesktop/stereo/message.oga".to_owned(),
	]]
}

#[cfg(target_os = "macos")]
fn sound_candidates() -> Vec<Vec<String>> {
	vec![vec!["afplay".to_owned(), "/System/Library/Sounds/Ping.aiff".to_owned()]]
}

#[cfg(target_os = "windows")]
fn sound_candidates() -> Vec<Vec<String>> {
	vec![vec![
		"powershell".to_owned(),
		"-NoProfile".to_owned(),
		"-Command".to_owned(),
		"[System.Media.SystemSounds]::Exclamation.Play()".to_owned(),
	]]
}

#[cfg(target_os = "linux")]
fn post_command(notification: &Notification) -> Vec<String> {
	vec![
		"notify-send".to_owned(),
		format!("--app-name={APP_NAME}"),
		format!("--urgency={}", urgency(notification.priority)),
		notification.title.clone(),
		notification.detail.clone().unwrap_or_default(),
	]
}

#[cfg(target_os = "macos")]
fn post_command(notification: &Notification) -> Vec<String> {
	// A literal quote in either field would end the AppleScript string, so
	// both are stated without one.
	let title = notification.title.replace('"', "'");
	let detail = notification
		.detail
		.clone()
		.unwrap_or_default()
		.replace('"', "'");
	vec![
		"osascript".to_owned(),
		"-e".to_owned(),
		format!(r#"display notification "{detail}" with title "{APP_NAME}" subtitle "{title}""#),
	]
}

#[cfg(target_os = "windows")]
fn post_command(notification: &Notification) -> Vec<String> {
	let title = notification.title.replace('\'', "''");
	let detail = notification
		.detail
		.clone()
		.unwrap_or_default()
		.replace('\'', "''");
	vec![
		"powershell".to_owned(),
		"-NoProfile".to_owned(),
		"-Command".to_owned(),
		format!(
			"[reflection.assembly]::LoadWithPartialName('System.Windows.Forms')>$null; $n=New-Object \
			 System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; \
			 $n.Visible=$true; \
			 $n.ShowBalloonTip(5000,'{title}','{detail}',[System.Windows.Forms.ToolTipIcon]::Info)"
		),
	]
}

/// Every candidate as the borrowed argv `spawn_first` takes.
fn borrowed(candidates: &[Vec<String>]) -> Vec<Vec<&str>> {
	candidates
		.iter()
		.map(|argv| argv.iter().map(String::as_str).collect())
		.collect()
}

impl NoticeCarrier for DesktopCarrier {
	fn ring(&self) -> Result<(), String> {
		let owned = sound_candidates();
		let borrowed = borrowed(&owned);
		let candidates: Vec<&[&str]> = borrowed.iter().map(Vec::as_slice).collect();
		spawn_first(&candidates)
	}

	fn post(&self, notification: &Notification) -> Result<(), String> {
		let owned = [post_command(notification)];
		let borrowed = borrowed(&owned);
		let candidates: Vec<&[&str]> = borrowed.iter().map(Vec::as_slice).collect();
		spawn_first(&candidates)
	}
}
