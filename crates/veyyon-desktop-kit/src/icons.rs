//! Vector icon primitives rendered on a 16px grid (§8.25).

use std::collections::HashSet;

use strum::{EnumIter, IntoEnumIterator};
use veyyon_gpui::{
	App, Bounds, Hsla, IntoElement, Path, Pixels, Point, RenderOnce, Window, canvas, div,
	prelude::*, px,
};

use crate::token_set::{ColorRole, TokenSet};

/// System icon identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter)]
pub enum IconName {
	ChevronDown,
	ChevronRight,
	ChevronLeft,
	ChevronUp,
	Search,
	Close,
	Check,
	Folder,
	File,
	Terminal,
	Settings,
	Refresh,
	Plus,
	Minus,
	Trash,
	Edit,
	Eye,
	EyeOff,
	Filter,
	Play,
	Pause,
	Stop,
	ArrowRight,
	ArrowLeft,
	ArrowUp,
	ArrowDown,
	Pin,
	Unpin,
	Lock,
	Unlock,
	Info,
	Warning,
	Help,
}

/// Permitted standard icon sizes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum IconSize {
	Size12,
	Size14,
	#[default]
	Size16,
	Size20,
}

impl IconSize {
	/// Resolves icon bounding box dimension in pixels.
	#[must_use]
	pub fn pixels(self) -> Pixels {
		match self {
			Self::Size12 => px(12.0),
			Self::Size14 => px(14.0),
			Self::Size16 => px(16.0),
			Self::Size20 => px(20.0),
		}
	}

	/// Resolves scale factor relative to 16px reference grid.
	#[must_use]
	pub fn scale(self) -> f32 {
		match self {
			Self::Size12 => 12.0 / 16.0,
			Self::Size14 => 14.0 / 16.0,
			Self::Size16 => 1.0,
			Self::Size20 => 20.0 / 16.0,
		}
	}
}

/// Semantic meaning mapping for icon uniqueness validation.
#[must_use]
pub fn icon_meanings() -> Vec<(IconName, &'static str)> {
	vec![
		(IconName::ChevronDown, "expand downward"),
		(IconName::ChevronRight, "expand rightward"),
		(IconName::ChevronLeft, "collapse leftward"),
		(IconName::ChevronUp, "collapse upward"),
		(IconName::Search, "search or filter queries"),
		(IconName::Close, "dismiss or cancel action"),
		(IconName::Check, "confirm or completed state"),
		(IconName::Folder, "directory or container"),
		(IconName::File, "document or leaf entry"),
		(IconName::Terminal, "command execution console"),
		(IconName::Settings, "system configuration"),
		(IconName::Refresh, "reload or re-synchronize"),
		(IconName::Plus, "create or append element"),
		(IconName::Minus, "collapse or decrement value"),
		(IconName::Trash, "delete or discard target"),
		(IconName::Edit, "modify in-place"),
		(IconName::Eye, "reveal hidden content"),
		(IconName::EyeOff, "conceal content"),
		(IconName::Filter, "narrow selection set"),
		(IconName::Play, "start or resume execution"),
		(IconName::Pause, "temporarily suspend execution"),
		(IconName::Stop, "terminate execution"),
		(IconName::ArrowRight, "navigate next"),
		(IconName::ArrowLeft, "navigate previous"),
		(IconName::ArrowUp, "navigate higher"),
		(IconName::ArrowDown, "navigate lower"),
		(IconName::Pin, "keep pinned at top"),
		(IconName::Unpin, "release pinned state"),
		(IconName::Lock, "access restricted"),
		(IconName::Unlock, "access permitted"),
		(IconName::Info, "informational notice"),
		(IconName::Warning, "advisory caution alert"),
		(IconName::Help, "documentation assistance"),
	]
}

/// Validates that every icon in `IconName` has a unique meaning and all
/// variants are mapped.
#[must_use]
pub fn validate_icon_uniqueness() -> bool {
	let meanings = icon_meanings();
	let mut seen_icons = HashSet::with_capacity(meanings.len());
	let mut seen_meanings = HashSet::with_capacity(meanings.len());

	for (icon, meaning) in meanings {
		if !seen_icons.insert(icon) || !seen_meanings.insert(meaning) {
			return false;
		}
	}

	for variant in IconName::iter() {
		if !seen_icons.contains(&variant) {
			return false;
		}
	}
	true
}

/// Vector path segment for rendering.
#[derive(Debug, Clone, Copy)]
pub enum PathSegment {
	MoveTo(f32, f32),
	LineTo(f32, f32),
}

/// Returns normalized path segments on a 16x16 reference grid.
#[must_use]
pub fn icon_segments(icon: IconName, _size: IconSize) -> &'static [PathSegment] {
	match icon {
		IconName::ChevronDown => &[
			PathSegment::MoveTo(4.0, 6.0),
			PathSegment::LineTo(8.0, 10.0),
			PathSegment::LineTo(12.0, 6.0),
		],
		IconName::ChevronRight => &[
			PathSegment::MoveTo(6.0, 4.0),
			PathSegment::LineTo(10.0, 8.0),
			PathSegment::LineTo(6.0, 12.0),
		],
		IconName::ChevronLeft => &[
			PathSegment::MoveTo(10.0, 4.0),
			PathSegment::LineTo(6.0, 8.0),
			PathSegment::LineTo(10.0, 12.0),
		],
		IconName::ChevronUp => &[
			PathSegment::MoveTo(4.0, 10.0),
			PathSegment::LineTo(8.0, 6.0),
			PathSegment::LineTo(12.0, 10.0),
		],
		IconName::Search => &[
			PathSegment::MoveTo(7.0, 3.0),
			PathSegment::LineTo(11.0, 7.0),
			PathSegment::LineTo(7.0, 11.0),
			PathSegment::LineTo(3.0, 7.0),
			PathSegment::LineTo(7.0, 3.0),
			PathSegment::MoveTo(10.0, 10.0),
			PathSegment::LineTo(13.5, 13.5),
		],
		IconName::Close => &[
			PathSegment::MoveTo(4.0, 4.0),
			PathSegment::LineTo(12.0, 12.0),
			PathSegment::MoveTo(12.0, 4.0),
			PathSegment::LineTo(4.0, 12.0),
		],
		IconName::Check => &[
			PathSegment::MoveTo(3.5, 8.5),
			PathSegment::LineTo(6.5, 11.5),
			PathSegment::LineTo(12.5, 4.5),
		],
		IconName::Plus => &[
			PathSegment::MoveTo(8.0, 3.0),
			PathSegment::LineTo(8.0, 13.0),
			PathSegment::MoveTo(3.0, 8.0),
			PathSegment::LineTo(13.0, 8.0),
		],
		IconName::Minus => &[PathSegment::MoveTo(3.0, 8.0), PathSegment::LineTo(13.0, 8.0)],
		IconName::Terminal => &[
			PathSegment::MoveTo(3.0, 4.0),
			PathSegment::LineTo(7.0, 8.0),
			PathSegment::LineTo(3.0, 12.0),
			PathSegment::MoveTo(8.0, 12.0),
			PathSegment::LineTo(13.0, 12.0),
		],
		IconName::Folder => &[
			PathSegment::MoveTo(2.0, 4.0),
			PathSegment::LineTo(6.0, 4.0),
			PathSegment::LineTo(8.0, 6.0),
			PathSegment::LineTo(14.0, 6.0),
			PathSegment::LineTo(14.0, 13.0),
			PathSegment::LineTo(2.0, 13.0),
			PathSegment::LineTo(2.0, 4.0),
		],
		IconName::File => &[
			PathSegment::MoveTo(3.0, 2.0),
			PathSegment::LineTo(9.0, 2.0),
			PathSegment::LineTo(13.0, 6.0),
			PathSegment::LineTo(13.0, 14.0),
			PathSegment::LineTo(3.0, 14.0),
			PathSegment::LineTo(3.0, 2.0),
		],
		_ => &[
			PathSegment::MoveTo(2.0, 2.0),
			PathSegment::LineTo(14.0, 2.0),
			PathSegment::LineTo(14.0, 14.0),
			PathSegment::LineTo(2.0, 14.0),
			PathSegment::LineTo(2.0, 2.0),
		],
	}
}

/// Icon element rendered via vector path canvas.
#[derive(IntoElement)]
pub struct Icon {
	name:  IconName,
	size:  IconSize,
	color: Option<Hsla>,
}

impl Icon {
	/// Creates an icon element.
	#[must_use]
	pub fn new(name: IconName) -> Self {
		Self { name, size: IconSize::default(), color: None }
	}

	/// Sets the icon size.
	#[must_use]
	pub fn size(mut self, size: IconSize) -> Self {
		self.size = size;
		self
	}

	/// Sets explicit foreground color override.
	#[must_use]
	pub fn color(mut self, color: Hsla) -> Self {
		self.color = Some(color);
		self
	}
}

impl RenderOnce for Icon {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);
		let fg = self
			.color
			.unwrap_or_else(|| tokens.color(ColorRole::Foreground));
		let size_px = self.size.pixels();
		let scale = self.size.scale();
		let name = self.name;
		let size = self.size;

		div()
			.size(size_px)
			.flex()
			.items_center()
			.justify_center()
			.child(
				canvas(
					move |bounds: Bounds<Pixels>, _window: &mut Window, _cx: &mut App| bounds,
					move |bounds: Bounds<Pixels>, _, window: &mut Window, _cx: &mut App| {
						let segments = icon_segments(name, size);
						let mut path = Path::new(Point::new(bounds.origin.x, bounds.origin.y));

						for segment in segments {
							match *segment {
								PathSegment::MoveTo(x, y) => {
									path.move_to(Point::new(
										bounds.origin.x + px(x * scale),
										bounds.origin.y + px(y * scale),
									));
								},
								PathSegment::LineTo(x, y) => {
									path.line_to(Point::new(
										bounds.origin.x + px(x * scale),
										bounds.origin.y + px(y * scale),
									));
								},
							}
						}
						window.paint_path(path, fg);
					},
				)
				.size(size_px),
			)
	}
}
