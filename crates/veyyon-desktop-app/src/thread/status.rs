//! The facts the thread header states about a session, as words: its mode,
//! model, pace, extension statuses, serving account, quota, tokens and
//! context use.

use std::fmt::Write as _;

use veyyon_desktop_model::{SessionId, SessionMode};

use crate::{AppState, transcript::turn::duration_words};

/// The words a mode chip reads, or `None` for a session in no mode.
#[must_use]
fn mode_label(mode: &SessionMode) -> Option<String> {
	match mode {
		SessionMode::Plan => Some("Plan".to_owned()),
		SessionMode::PlanPaused => Some("Plan paused".to_owned()),
		SessionMode::Goal => Some("Goal".to_owned()),
		SessionMode::Vibe => Some("Vibe".to_owned()),
		SessionMode::Loop => Some("Loop".to_owned()),
		SessionMode::Other(name) if name == "none" || name.is_empty() => None,
		SessionMode::Other(name) => Some(name.replace(['_', '-'], " ")),
	}
}

/// `12.3k`, `1.2M`, `950`.
#[must_use]
fn compact_count(count: u64) -> String {
	match count {
		0..1_000 => count.to_string(),
		1_000..1_000_000 => format!("{}.{}k", count / 1_000, (count % 1_000) / 100),
		_ => format!("{}.{}M", count / 1_000_000, (count % 1_000_000) / 100_000),
	}
}

/// The chips the header states about `session`, left to right, read at
/// render so a running duration needs no timer.
#[must_use]
pub fn status_chips(app: &AppState, session: &SessionId, now_ms: u64) -> Vec<String> {
	let store = app.store();
	let domains = &store.domains;
	let mut chips = Vec::new();
	if let Some(mode) = app.session_mode(session).and_then(mode_label) {
		chips.push(mode);
	}
	if let Some(current) = domains
		.models
		.as_ref()
		.and_then(|models| models.current.as_ref())
	{
		chips.push(current.id.clone());
	}
	if let Some(pace) = store.pace(session) {
		let worked = duration_words(pace.worked_ms_at(now_ms) / 1000);
		match pace.tokens_per_second_tenths {
			Some(rate) => chips.push(format!("{}.{} tok/s · {worked}", rate / 10, rate % 10)),
			None => chips.push(worked),
		}
	}
	if let Some(ui) = domains
		.extension_ui
		.get(session)
		.filter(|ui| !ui.statuses.is_empty())
	{
		let texts: Vec<&str> = ui
			.statuses
			.iter()
			.map(|status| status.text.as_str())
			.collect();
		chips.push(texts.join(" "));
	}
	if let Some(account) = store
		.serving_account(session)
		.filter(|account| account.logins >= 2)
	{
		let predicted = if account.predicted { "~" } else { "" };
		chips.push(format!("{predicted}{}", account.label));
	}
	if let Some(quota) = store.quota(session) {
		let window = |label: &str, window: Option<&veyyon_desktop_model::domain::QuotaWindowView>| {
			window.map(|window| format!("{label} {}%", window.used_permille / 10))
		};
		let parts: Vec<String> =
			[window("5h", quota.five_hour.as_ref()), window("7d", quota.seven_day.as_ref())]
				.into_iter()
				.flatten()
				.collect();
		if !parts.is_empty() {
			chips.push(parts.join(" · "));
		}
	}
	if let Some(usage) = domains.usage.get(session) {
		let mut words =
			format!("↑{} ↓{}", compact_count(usage.input_tokens), compact_count(usage.output_tokens));
		if let Some(cost) = usage.cost_microusd {
			let _ = write!(words, " · ${}.{:02}", cost / 1_000_000, (cost % 1_000_000) / 10_000);
		}
		chips.push(words);
	}
	if let Some(context) = domains.context.get(session)
		&& let Some(limit) = context.limit_tokens.filter(|limit| *limit > 0)
	{
		chips.push(format!("{}% context", context.total_tokens * 100 / limit));
	}
	chips
}

/// The wall clock in epoch milliseconds, the clock the host stamps a running
/// working window with.
pub fn now_ms() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}
