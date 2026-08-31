//! Formatting engine-owned measurements without manufacturing missing values.

/// Live elapsed labels change on minute boundaries. The shell may schedule the
/// returned deadline once; rendering never asks for an animation frame.
pub const ELAPSED_STEP_MS: u64 = 60_000;

pub fn elapsed_label(duration_ms: u64) -> String {
	let total_minutes = duration_ms / ELAPSED_STEP_MS;
	if total_minutes < 60 {
		return format!("{total_minutes}m");
	}
	let hours = total_minutes / 60;
	let minutes = total_minutes % 60;
	if minutes == 0 {
		format!("{hours}h")
	} else {
		format!("{hours}h {minutes}m")
	}
}

/// The first instant at which a live elapsed label can change.
pub fn next_elapsed_deadline(started_at_ms: u64, now_ms: u64) -> u64 {
	let elapsed = now_ms.saturating_sub(started_at_ms);
	started_at_ms.saturating_add(
		(elapsed / ELAPSED_STEP_MS)
			.saturating_add(1)
			.saturating_mul(ELAPSED_STEP_MS),
	)
}

pub fn token_label(tokens: u64) -> String {
	format!("{tokens} tokens")
}

pub fn context_label(tokens: u64, window: Option<u64>) -> String {
	match window {
		Some(window) => format!("{tokens} / {window} tokens"),
		None => token_label(tokens),
	}
}

pub fn request_label(requests: u64) -> String {
	match requests {
		1 => "1 request".to_owned(),
		count => format!("{count} requests"),
	}
}

pub fn tool_label(tools: u64) -> String {
	match tools {
		1 => "1 tool".to_owned(),
		count => format!("{count} tools"),
	}
}

pub fn cost_label(cost_microusd: Option<u64>) -> String {
	match cost_microusd {
		Some(microusd) => {
			let dollars = microusd / 1_000_000;
			let fraction = microusd % 1_000_000;
			format!("${dollars}.{fraction:06}")
		},
		None => "Pricing unavailable".to_owned(),
	}
}
