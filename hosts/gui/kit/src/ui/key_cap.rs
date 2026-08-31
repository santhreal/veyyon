//! Single keyboard key cap.

use gpui::{App, IntoElement, RenderOnce, SharedString, Window};

use super::kbd;
use crate::theme::Theme;

#[derive(IntoElement)]
pub struct KeyCap {
	key: SharedString,
}
impl KeyCap {
	pub fn new(key: impl Into<SharedString>) -> Self {
		Self { key: key.into() }
	}
}
impl RenderOnce for KeyCap {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		kbd::caps(self.key.as_ref(), &Theme::get(cx))
	}
}
