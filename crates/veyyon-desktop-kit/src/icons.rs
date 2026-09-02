//! Vector icon primitives rendered on a 16px grid (§8.25).

use std::collections::HashSet;

use strum::{EnumIter, IntoEnumIterator};
use veyyon_gpui::{App, Hsla, IntoElement, Pixels, RenderOnce, Window, div, prelude::*, px, svg};

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
	}
}

/// Icon element rendered via vector SVG asset.
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
		let bytes = icon_bytes(self.name);

		div()
			.size(size_px)
			.flex()
			.items_center()
			.justify_center()
			.child(svg().data(bytes).size(size_px).text_color(fg))
	}
}
