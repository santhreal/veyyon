//! Segmented control specialization of tabs.

use gpui::{App, IntoElement, RenderOnce, SharedString, Window};

use super::{Size, Tab, Tabs};

#[derive(IntoElement)]
pub struct SegmentedControl {
	tabs: Tabs,
}
impl SegmentedControl {
	pub fn new(id: impl Into<SharedString>) -> Self {
		Self { tabs: Tabs::new(id).size(Size::Small) }
	}

	pub fn segment(mut self, segment: Tab) -> Self {
		self.tabs = self.tabs.tab(segment);
		self
	}

	pub fn stretch(mut self) -> Self {
		self.tabs = self.tabs.stretch();
		self
	}
}
impl RenderOnce for SegmentedControl {
	fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
		self.tabs
	}
}
