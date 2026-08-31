//! Shared stepped activity indicator.
//!
//! A visible indicator registers once with the window's eight-client activity
//! clock. It owns no continuous track. Its phase changes at one absolute 200 ms
//! boundary shared by every indicator, and becomes a static running glyph under
//! reduced motion or capacity overflow.

use gpui::{App, IntoElement, RenderOnce, Styled, Window};

use super::{Icon, icon};
use crate::{motion::RetainedKey, paint, theme::Theme};

#[derive(IntoElement)]
pub struct Spinner {
	owner:        RetainedKey,
	icon:         Icon,
	phase_offset: u8,
}

impl Spinner {
	pub fn new(owner: RetainedKey, icon: Icon) -> Self {
		Self { owner, icon, phase_offset: 0 }
	}

	pub fn phase_offset(mut self, offset: u8) -> Self {
		self.phase_offset = offset % 8;
		self
	}
}

impl RenderOnce for Spinner {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let now = paint::Clock::frame(cx);
		let registered = paint::registry(cx).activity_registered(self.owner);
		let phase = if registered {
			paint::registry(cx).activity_phase(self.owner, now)
		} else {
			0
		};
		let opacity = if phase < 4 { 1.0 } else { 0.52 };
		icon::at(self.icon, icon::scale::base(), theme.accent).opacity(opacity)
	}
}
