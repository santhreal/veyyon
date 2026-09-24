//! Vector icon primitives rendered on a 16px grid (§8.25).

use std::collections::HashSet;

use strum::{EnumIter, IntoEnumIterator};
use veyyon_gpui::{App, Hsla, IntoElement, Pixels, RenderOnce, Window, div, prelude::*, px, svg};

pub use crate::token_set::IconSize;
use crate::token_set::{ColorRole, StrokeStep, TokenSet};

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
	Cpu,
	Sparkles,
	Zap,
	Layers,
	Paperclip,
	Gauge,
	Image,
	Film,
	PanelLeft,
	PanelRight,
	Mic,
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
		(IconName::Cpu, "language model selection"),
		(IconName::Sparkles, "reasoning or thinking effort"),
		(IconName::Zap, "steer the running turn"),
		(IconName::Layers, "queue behind the running turn"),
		(IconName::Paperclip, "file attachment"),
		(IconName::Gauge, "context window occupancy"),
		(IconName::Image, "still picture attachment"),
		(IconName::Film, "video clip attachment"),
		(IconName::PanelLeft, "queue rail visibility"),
		(IconName::PanelRight, "right panel visibility"),
		(IconName::Mic, "speech dictated into the composer"),
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

/// Returns raw SVG bytes for the given icon.
#[must_use]
pub const fn icon_bytes(name: IconName) -> &'static [u8] {
	match name {
		IconName::ChevronDown => include_bytes!("../assets/icons/chevron-down.svg"),
		IconName::ChevronRight => include_bytes!("../assets/icons/chevron-right.svg"),
		IconName::ChevronLeft => include_bytes!("../assets/icons/chevron-left.svg"),
		IconName::ChevronUp => include_bytes!("../assets/icons/chevron-up.svg"),
		IconName::Search => include_bytes!("../assets/icons/search.svg"),
		IconName::Close => include_bytes!("../assets/icons/close.svg"),
		IconName::Check => include_bytes!("../assets/icons/check.svg"),
		IconName::Folder => include_bytes!("../assets/icons/folder.svg"),
		IconName::File => include_bytes!("../assets/icons/file.svg"),
		IconName::Terminal => include_bytes!("../assets/icons/terminal.svg"),
		IconName::Settings => include_bytes!("../assets/icons/settings.svg"),
		IconName::Refresh => include_bytes!("../assets/icons/refresh.svg"),
		IconName::Plus => include_bytes!("../assets/icons/plus.svg"),
		IconName::Minus => include_bytes!("../assets/icons/minus.svg"),
		IconName::Trash => include_bytes!("../assets/icons/trash.svg"),
		IconName::Edit => include_bytes!("../assets/icons/edit.svg"),
		IconName::Eye => include_bytes!("../assets/icons/eye.svg"),
		IconName::EyeOff => include_bytes!("../assets/icons/eye-off.svg"),
		IconName::Filter => include_bytes!("../assets/icons/filter.svg"),
		IconName::Play => include_bytes!("../assets/icons/play.svg"),
		IconName::Pause => include_bytes!("../assets/icons/pause.svg"),
		IconName::Stop => include_bytes!("../assets/icons/stop.svg"),
		IconName::ArrowRight => include_bytes!("../assets/icons/arrow-right.svg"),
		IconName::ArrowLeft => include_bytes!("../assets/icons/arrow-left.svg"),
		IconName::ArrowUp => include_bytes!("../assets/icons/arrow-up.svg"),
		IconName::ArrowDown => include_bytes!("../assets/icons/arrow-down.svg"),
		IconName::Pin => include_bytes!("../assets/icons/pin.svg"),
		IconName::Unpin => include_bytes!("../assets/icons/unpin.svg"),
		IconName::Lock => include_bytes!("../assets/icons/lock.svg"),
		IconName::Unlock => include_bytes!("../assets/icons/unlock.svg"),
		IconName::Info => include_bytes!("../assets/icons/info.svg"),
		IconName::Warning => include_bytes!("../assets/icons/warning.svg"),
		IconName::Help => include_bytes!("../assets/icons/help.svg"),
		IconName::Cpu => include_bytes!("../assets/icons/cpu.svg"),
		IconName::Sparkles => include_bytes!("../assets/icons/sparkles.svg"),
		IconName::Zap => include_bytes!("../assets/icons/zap.svg"),
		IconName::Layers => include_bytes!("../assets/icons/layers.svg"),
		IconName::Paperclip => include_bytes!("../assets/icons/paperclip.svg"),
		IconName::Gauge => include_bytes!("../assets/icons/gauge.svg"),
		IconName::Image => include_bytes!("../assets/icons/image.svg"),
		IconName::Film => include_bytes!("../assets/icons/film.svg"),
		IconName::PanelLeft => include_bytes!("../assets/icons/panel-left.svg"),
		IconName::PanelRight => include_bytes!("../assets/icons/panel-right.svg"),
		IconName::Mic => include_bytes!("../assets/icons/mic.svg"),
	}
}

/// Optical shape classification for perceptual volume balancing (§8.25).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconOpticalShape {
	/// Circular/rounded glyphs (occupy ~78% of bounding box, need optical
	/// boost).
	Circular,
	/// Square/boxy glyphs (occupy ~100% of bounding box, need optical
	/// reduction).
	Square,
	/// Open, slender, or directional glyphs (neutral baseline).
	Slender,
}

impl IconOpticalShape {
	/// Perceptual optical scale factor to balance visual weight against square
	/// glyphs.
	#[must_use]
	pub const fn optical_scale(self) -> f32 {
		match self {
			Self::Circular => 1.02,
			Self::Square => 0.88,
			Self::Slender => 0.96,
		}
	}
}

/// Classifies an icon into its optical shape category.
#[must_use]
pub const fn icon_optical_shape(name: IconName) -> IconOpticalShape {
	match name {
		IconName::Stop
		| IconName::File
		| IconName::Folder
		| IconName::Terminal
		| IconName::Film
		| IconName::PanelLeft
		| IconName::PanelRight
		| IconName::Lock
		| IconName::Unlock
		| IconName::Cpu => IconOpticalShape::Square,

		IconName::Help
		| IconName::Info
		| IconName::Search
		| IconName::Settings
		| IconName::Refresh
		| IconName::Eye
		| IconName::EyeOff
		| IconName::Gauge => IconOpticalShape::Circular,

		_ => IconOpticalShape::Slender,
	}
}

/// Returns dynamic SVG byte data with the exact SVG coordinate stroke width
/// needed to render the requested target stroke in physical screen pixels.
#[must_use]
pub fn icon_svg_data(name: IconName, stroke_width_in_svg: f32) -> Vec<u8> {
	let raw = icon_bytes(name);
	let Ok(raw_str) = std::str::from_utf8(raw) else {
		return raw.to_vec();
	};
	let needle = "stroke-width=\"1.5\"";
	let replacement = format!("stroke-width=\"{stroke_width_in_svg:.3}\"");
	raw_str.replace(needle, &replacement).into_bytes()
}

/// Icon element rendered via vector SVG asset.
#[derive(IntoElement)]
pub struct Icon {
	name:       IconName,
	size:       IconSize,
	pixel_size: Option<Pixels>,
	color:      Option<Hsla>,
	stroke:     Option<StrokeStep>,
}

impl Icon {
	/// Creates an icon element.
	pub fn new(name: IconName) -> Self {
		Self { name, size: IconSize::default(), pixel_size: None, color: None, stroke: None }
	}

	/// Sets explicit pixel size override.
	#[must_use]
	pub fn pixel_size(mut self, size: Pixels) -> Self {
		self.pixel_size = Some(size);
		self
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

	/// Sets the stroke step from the stroke scale.
	#[must_use]
	pub fn stroke(mut self, stroke: StrokeStep) -> Self {
		self.stroke = Some(stroke);
		self
	}
}

impl RenderOnce for Icon {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;
		let fg = self
			.color
			.unwrap_or_else(|| tokens.color(ColorRole::Foreground));
		let stroke_step = self.stroke.unwrap_or(StrokeStep::Icon);
		let target_stroke = f32::from(tokens.stroke(stroke_step));
		let size_px = self
			.pixel_size
			.unwrap_or_else(|| tokens.icon_size(self.size));
		let outer_d = f32::from(size_px);

		let shape = icon_optical_shape(self.name);
		let raw_optical = outer_d * shape.optical_scale();
		// Round to half-pixel boundaries for crisp device-pixel snapping at 1x and 2x
		// scale.
		let optical_d = (raw_optical * 2.0).round() / 2.0;
		let svg_stroke = target_stroke * (24.0 / optical_d);

		let bytes = icon_svg_data(self.name, svg_stroke);
		let optical_size = px(optical_d);

		div()
			.size(size_px)
			.flex()
			.items_center()
			.justify_center()
			.child(svg().data(&bytes).size(optical_size).text_color(fg))
	}
}
