//! Semantic styling, tone mapping, and emblem resolution for `ToolView`.

use veyyon_desktop_kit::{ColorRole, IconName, TintRole, TokenSet};
use veyyon_desktop_model::tool_view::{ViewStatus, ViewTone};
use veyyon_gpui::Hsla;

/// Resolves semantic `ViewTone` to an HSLA color using the surface `TokenSet`.
#[must_use]
pub fn resolve_tone_color(tone: ViewTone, tokens: &TokenSet) -> Hsla {
	match tone {
		ViewTone::Title => tokens.color(ColorRole::Foreground),
		ViewTone::Accent => tokens.color(ColorRole::Accent),
		ViewTone::Output => tokens.color(ColorRole::Secondary),
		ViewTone::Link => tokens.color(ColorRole::Accent),
		ViewTone::Muted => tokens.color(ColorRole::Muted),
		ViewTone::Dim => {
			let mut c = tokens.color(ColorRole::Muted);
			c.a *= 0.65;
			c
		},
		ViewTone::DiffAdded => tokens.color(ColorRole::DoneInk),
		ViewTone::DiffRemoved => tokens.color(ColorRole::ErrorInk),
		ViewTone::Success => tokens.color(ColorRole::DoneInk),
		ViewTone::Warning => tokens.color(ColorRole::AttentionInk),
		ViewTone::Error => tokens.color(ColorRole::ErrorInk),
		ViewTone::Info => tokens.color(ColorRole::Accent),
		ViewTone::Cost => tokens.color(ColorRole::DueInk),
		ViewTone::Text => tokens.color(ColorRole::Foreground),
	}
}

/// Resolves semantic `ViewTone` to a kit `TintRole` for badges and indicators.
#[must_use]
pub const fn resolve_tone_tint(tone: ViewTone) -> TintRole {
	match tone {
		ViewTone::Title | ViewTone::Text | ViewTone::Output => TintRole::Done,
		ViewTone::Accent | ViewTone::Link | ViewTone::Info => TintRole::Plan,
		ViewTone::Muted | ViewTone::Dim => TintRole::Working,
		ViewTone::DiffAdded | ViewTone::Success => TintRole::Done,
		ViewTone::DiffRemoved | ViewTone::Error => TintRole::Error,
		ViewTone::Warning => TintRole::Attention,
		ViewTone::Cost => TintRole::Due,
	}
}

/// Resolves semantic `ViewStatus` to an HSLA color.
#[must_use]
pub const fn resolve_status_color(status: ViewStatus, tokens: &TokenSet) -> Hsla {
	match status {
		ViewStatus::Success | ViewStatus::Done => tokens.color(ColorRole::DoneInk),
		ViewStatus::Error => tokens.color(ColorRole::ErrorInk),
		ViewStatus::Warning => tokens.color(ColorRole::AttentionInk),
		ViewStatus::Info => tokens.color(ColorRole::Accent),
		ViewStatus::Pending => tokens.color(ColorRole::Muted),
		ViewStatus::Running => tokens.color(ColorRole::WorkingInk),
		ViewStatus::Aborted => tokens.color(ColorRole::Muted),
	}
}

/// Resolves semantic `ViewStatus` to a kit `TintRole`.
#[must_use]
pub const fn resolve_status_tint(status: ViewStatus) -> TintRole {
	match status {
		ViewStatus::Success | ViewStatus::Done => TintRole::Done,
		ViewStatus::Error => TintRole::Error,
		ViewStatus::Warning => TintRole::Attention,
		ViewStatus::Info => TintRole::Plan,
		ViewStatus::Pending => TintRole::Working,
		ViewStatus::Running => TintRole::Working,
		ViewStatus::Aborted => TintRole::Attention,
	}
}

/// Resolves semantic `ViewStatus` to a standard system icon.
#[must_use]
pub const fn resolve_status_icon(status: ViewStatus) -> IconName {
	match status {
		ViewStatus::Success | ViewStatus::Done => IconName::Check,
		ViewStatus::Error => IconName::Close,
		ViewStatus::Warning => IconName::Warning,
		ViewStatus::Info => IconName::Info,
		ViewStatus::Pending => IconName::Pause,
		ViewStatus::Running => IconName::Play,
		ViewStatus::Aborted => IconName::Stop,
	}
}

/// Resolves a string emblem or decorative symbol name to a kit `IconName`.
///
/// If the emblem name is unknown to the registry, returns `None`, allowing the
/// caller to fall back to the status icon or plain text.
#[must_use]
pub fn resolve_emblem_icon(emblem: &str) -> Option<IconName> {
	let normalized = emblem.trim().to_ascii_lowercase();
	match normalized.as_str() {
		"check" | "success" | "done" | "ok" => Some(IconName::Check),
		"close" | "error" | "failed" | "cancel" => Some(IconName::Close),
		"warning" | "alert" | "warn" => Some(IconName::Warning),
		"info" => Some(IconName::Info),
		"help" | "question" => Some(IconName::Help),
		"file" | "document" => Some(IconName::File),
		"folder" | "directory" | "dir" => Some(IconName::Folder),
		"terminal" | "bash" | "sh" | "shell" | "exec" | "cmd" => Some(IconName::Terminal),
		"edit" | "patch" | "write" | "modify" => Some(IconName::Edit),
		"search" | "find" | "grep" => Some(IconName::Search),
		"settings" | "config" | "gear" => Some(IconName::Settings),
		"sparkles" | "ai" | "model" => Some(IconName::Sparkles),
		"zap" | "bolt" | "flash" => Some(IconName::Zap),
		"paperclip" | "attachment" => Some(IconName::Paperclip),
		"layers" | "stack" => Some(IconName::Layers),
		"gauge" | "meter" | "stats" => Some(IconName::Gauge),
		"image" | "picture" | "photo" => Some(IconName::Image),
		"film" | "video" => Some(IconName::Film),
		"refresh" | "sync" | "reload" => Some(IconName::Refresh),
		"play" | "start" => Some(IconName::Play),
		"pause" => Some(IconName::Pause),
		"stop" => Some(IconName::Stop),
		"cpu" => Some(IconName::Cpu),
		"pin" => Some(IconName::Pin),
		"unpin" => Some(IconName::Unpin),
		"lock" => Some(IconName::Lock),
		"unlock" => Some(IconName::Unlock),
		"filter" => Some(IconName::Filter),
		"plus" | "add" => Some(IconName::Plus),
		"minus" | "remove" => Some(IconName::Minus),
		"trash" | "delete" => Some(IconName::Trash),
		"eye" => Some(IconName::Eye),
		"eyeoff" | "eye-off" => Some(IconName::EyeOff),
		_ => None,
	}
}
