//! The time left before the host settles a dialog itself.
//!
//! An entity of its own, so its tick renders the one line it draws and not
//! the card around it. It ticks once a second while time is left and stops at
//! zero; a dialog with no deadline has no countdown.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{Context, IntoElement, Render, Task, Window, div, prelude::*};
use veyyon_desktop_ui::theme::{ActiveTheme, TypeStyled, text};

/// How often the line is redrawn.
const TICK: Duration = Duration::from_secs(1);

/// The countdown line.
pub struct Countdown {
	expires_at_ms: u64,
	_tick:         Option<Task<()>>,
}

impl Countdown {
	/// A countdown to `expires_at_ms`, milliseconds since the Unix epoch.
	pub fn new(expires_at_ms: u64, cx: &Context<Self>) -> Self {
		let tick = (remaining_seconds(expires_at_ms) > 0).then(|| {
			cx.spawn(async move |this, cx| {
				loop {
					cx.background_executor().timer(TICK).await;
					let running = this
						.update(cx, |this, cx| {
							cx.notify();
							remaining_seconds(this.expires_at_ms) > 0
						})
						.unwrap_or(false);
					if !running {
						break;
					}
				}
			})
		});
		Self { expires_at_ms, _tick: tick }
	}
}

/// Whole seconds from now until `at_ms`, zero once it has passed.
pub fn remaining_seconds(at_ms: u64) -> u64 {
	let now = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX));
	at_ms.saturating_sub(now).div_ceil(1000)
}

/// `seconds` as a line states it: `42s`, `3m 05s`, `2h 07m`.
pub fn spell(seconds: u64) -> String {
	if seconds < 60 {
		format!("{seconds}s")
	} else if seconds < 3600 {
		format!("{}m {:02}s", seconds / 60, seconds % 60)
	} else {
		format!("{}h {:02}m", seconds / 3600, seconds % 3600 / 60)
	}
}

impl Render for Countdown {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		let left = remaining_seconds(self.expires_at_ms);
		let line = if left == 0 {
			"Settling on the recommended answers".to_owned()
		} else {
			format!("Recommended answers in {}", spell(left))
		};
		div()
			.id("dock-countdown")
			.type_style(text::SMALL)
			.text_color(if left <= 10 {
				palette.status.waiting
			} else {
				palette.text.muted
			})
			.child(line)
	}
}
