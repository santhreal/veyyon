//! State models and presentation parameters (§8.25).

use veyyon_gpui::SharedString;

use crate::icons::IconName;

/// General interactive state for clickable and focusable components.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum InteractiveState {
	#[default]
	Default,
	Hovered,
	Focused,
	Active,
	Disabled,
}

/// General selection state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum SelectionState {
	#[default]
	None,
	Selected,
	Active,
}

/// Row visual presentation shapes in list containers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ListRowShape {
	#[default]
	Card,
	Line,
}

/// Interactive state flags for selectable and draggable rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum RowInteractiveState {
	#[default]
	Rest,
	Hover,
	Focused,
	Selected,
	Open,
	Dragging,
}

/// Semantic badge kind indicating task or session execution state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RowBadgeKind {
	Approval,
	Input,
	Plan,
	Failed,
	Due,
	Done,
	Working,
	Watching,
}

/// Structured specification for a badge rendered in a list row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowBadgeSpec {
	pub kind:   RowBadgeKind,
	pub label:  SharedString,
	pub detail: Option<SharedString>,
}

impl RowBadgeSpec {
	/// Creates a badge specification with kind and label.
	#[must_use]
	pub fn new(kind: RowBadgeKind, label: impl Into<SharedString>) -> Self {
		Self { kind, label: label.into(), detail: None }
	}

	/// Attaches optional secondary detail string to the badge.
	#[must_use]
	pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
		self.detail = Some(detail.into());
		self
	}
}

/// Visual presentation variant for button controls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ButtonVariant {
	#[default]
	Default,
	Primary,
	Ghost,
	Danger,
}

/// Control sizing steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ControlSize {
	Micro,
	Small,
	#[default]
	Medium,
	Large,
}

/// Badge visual presentation variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum BadgeVariant {
	#[default]
	Default,
	Subtle,
	Solid,
	Outline,
}

/// Option entry for `Select` dropdown controls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectOption {
	pub value: SharedString,
	pub label: SharedString,
}

impl SelectOption {
	/// Creates a select option with value and label.
	#[must_use]
	pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
		Self { value: value.into(), label: label.into() }
	}
}

/// Segment entry for `SegmentedControl`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentItem {
	pub label: SharedString,
	pub icon:  Option<IconName>,
}

impl SegmentItem {
	/// Creates a segment item with text label.
	#[must_use]
	pub fn new(label: impl Into<SharedString>) -> Self {
		Self { label: label.into(), icon: None }
	}

	/// Attaches icon to the segment item.
	#[must_use]
	pub fn icon(mut self, icon: IconName) -> Self {
		self.icon = Some(icon);
		self
	}
}

/// Tree hierarchy node coordinate index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TreeIndex {
	pub depth:  usize,
	pub row:    usize,
	pub parent: Option<usize>,
}

/// Item specification for dropdown and context menus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuItem {
	pub label:        SharedString,
	pub icon:         Option<IconName>,
	pub shortcut:     Option<SharedString>,
	pub is_disabled:  bool,
	pub is_danger:    bool,
	pub is_separator: bool,
}

impl MenuItem {
	/// Creates a menu item with label.
	#[must_use]
	pub fn new(label: impl Into<SharedString>) -> Self {
		Self {
			label:        label.into(),
			icon:         None,
			shortcut:     None,
			is_disabled:  false,
			is_danger:    false,
			is_separator: false,
		}
	}

	/// Creates a separator item.
	#[must_use]
	pub fn separator() -> Self {
		Self {
			label:        SharedString::default(),
			icon:         None,
			shortcut:     None,
			is_disabled:  false,
			is_danger:    false,
			is_separator: true,
		}
	}

	/// Attaches leading icon to the menu item.
	#[must_use]
	pub fn icon(mut self, icon: IconName) -> Self {
		self.icon = Some(icon);
		self
	}

	/// Attaches keyboard shortcut string.
	#[must_use]
	pub fn shortcut(mut self, shortcut: impl Into<SharedString>) -> Self {
		self.shortcut = Some(shortcut.into());
		self
	}

	/// Sets whether item is disabled.
	#[must_use]
	pub fn disabled(mut self, disabled: bool) -> Self {
		self.is_disabled = disabled;
		self
	}

	/// Sets whether item is destructive.
	#[must_use]
	pub fn danger(mut self, danger: bool) -> Self {
		self.is_danger = danger;
		self
	}
}

/// Button specification for modal dialog action rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogButtonSpec {
	pub label:   SharedString,
	pub variant: ButtonVariant,
}

impl DialogButtonSpec {
	/// Creates a dialog button specification.
	#[must_use]
	pub fn new(label: impl Into<SharedString>, variant: ButtonVariant) -> Self {
		Self { label: label.into(), variant }
	}
}

/// Keyboard shortcut chord representation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyChord {
	pub key:   SharedString,
	pub ctrl:  bool,
	pub alt:   bool,
	pub shift: bool,
	pub meta:  bool,
}

impl KeyChord {
	/// Creates a single key chord with no modifiers.
	#[must_use]
	pub fn key(key: impl Into<SharedString>) -> Self {
		Self { key: key.into(), ctrl: false, alt: false, shift: false, meta: false }
	}

	/// Reads a chord in the keymap grammar: modifiers and the key joined by
	/// `-`, as in `ctrl-shift-k` or `cmd-,`. The key is the last part;
	/// `primary` is read as the platform's command modifier, and a chord that
	/// ends in `-` has `-` as its key.
	#[must_use]
	pub fn parse(chord: &str) -> Self {
		let (modifiers, key) = match chord.rsplit_once('-') {
			Some((modifiers, "")) => (modifiers.trim_end_matches('-'), "-"),
			Some((modifiers, key)) => (modifiers, key),
			None => ("", chord),
		};
		let mut parsed = Self::key(key.to_owned());
		for modifier in modifiers.split('-').filter(|part| !part.is_empty()) {
			match modifier.to_ascii_lowercase().as_str() {
				"ctrl" | "control" => parsed.ctrl = true,
				"alt" | "option" => parsed.alt = true,
				"shift" => parsed.shift = true,
				"cmd" | "meta" | "super" => parsed.meta = true,
				"primary" if cfg!(target_os = "macos") => parsed.meta = true,
				"primary" => parsed.ctrl = true,
				_ => {},
			}
		}
		parsed
	}

	/// Attaches command/meta modifier.
	#[must_use]
	pub fn meta(mut self) -> Self {
		self.meta = true;
		self
	}

	/// Attaches ctrl modifier.
	#[must_use]
	pub fn ctrl(mut self) -> Self {
		self.ctrl = true;
		self
	}

	/// Attaches alt modifier.
	#[must_use]
	pub fn alt(mut self) -> Self {
		self.alt = true;
		self
	}

	/// Attaches shift modifier.
	#[must_use]
	pub fn shift(mut self) -> Self {
		self.shift = true;
		self
	}

	/// Returns active modifier strings.
	#[must_use]
	pub fn modifiers(&self) -> Vec<&'static str> {
		let mut list = Vec::new();
		if self.ctrl {
			list.push("Ctrl");
		}
		if self.alt {
			list.push("Alt");
		}
		if self.shift {
			list.push("Shift");
		}
		if self.meta {
			list.push("Cmd");
		}
		list
	}
}

/// Image source descriptor for avatars.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageSource {
	pub uri: SharedString,
}

impl ImageSource {
	/// Creates an image source with URI.
	#[must_use]
	pub fn from_uri(uri: impl Into<SharedString>) -> Self {
		Self { uri: uri.into() }
	}
}
