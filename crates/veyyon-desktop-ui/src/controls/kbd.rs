//! A keyboard shortcut drawn as key caps.

use veyyon_gpui::{
	App, IntoElement, InvalidKeystrokeError, Keystroke, RenderOnce, SharedString, Window, div,
	prelude::*,
};

use crate::theme::{ActiveTheme, TypeStyled, radius, space, text};

/// The modifier and key spelling a shortcut is written in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum KeyPlatform {
	/// Glyphs, joined: `⌃⌥⇧⌘`, then the key, as in `⇧⌘P`.
	Mac,
	/// Words, spaced: `Ctrl Alt Shift Super`, then the key, as in
	/// `Ctrl Shift P`.
	Other,
}

impl KeyPlatform {
	/// The spelling of the platform the binary is built for.
	pub const fn current() -> Self {
		if cfg!(target_os = "macos") {
			Self::Mac
		} else {
			Self::Other
		}
	}
}

/// A keyboard shortcut: one keystroke, or a chord of several pressed in turn.
#[derive(Clone, Debug, PartialEq, Eq, IntoElement)]
pub struct Kbd {
	keystrokes: Vec<Keystroke>,
	platform:   KeyPlatform,
}

impl Kbd {
	/// The shortcut `keystroke`, spelled for [`KeyPlatform::current`].
	pub fn new(keystroke: Keystroke) -> Self {
		Self { keystrokes: vec![keystroke], platform: KeyPlatform::current() }
	}

	/// Parses a chord of space-separated keystrokes in GPUI keymap syntax,
	/// such as `ctrl-k ctrl-s` or `cmd-shift-p`.
	///
	/// # Errors
	///
	/// Returns the first keystroke that does not parse.
	pub fn chord(source: &str) -> Result<Self, InvalidKeystrokeError> {
		let keystrokes = source
			.split_whitespace()
			.map(Keystroke::parse)
			.collect::<Result<Vec<_>, _>>()?;
		Ok(Self { keystrokes, platform: KeyPlatform::current() })
	}

	/// Spells the shortcut for `platform` instead of the current one.
	pub const fn platform(mut self, platform: KeyPlatform) -> Self {
		self.platform = platform;
		self
	}

	/// The text of each key cap, one cap per keystroke.
	pub fn caps(&self) -> Vec<SharedString> {
		self
			.keystrokes
			.iter()
			.map(|keystroke| cap(keystroke, self.platform).into())
			.collect()
	}

	/// The whole shortcut as one line of text, caps separated by a space.
	pub fn label(&self) -> String {
		self.caps().join(" ")
	}
}

/// The text of one keystroke's cap.
fn cap(keystroke: &Keystroke, platform: KeyPlatform) -> String {
	let modifiers = &keystroke.modifiers;
	let (names, separator): ([(bool, &str); 5], &str) = match platform {
		KeyPlatform::Mac => (
			[
				(modifiers.function, "fn"),
				(modifiers.control, "⌃"),
				(modifiers.alt, "⌥"),
				(modifiers.shift, "⇧"),
				(modifiers.platform, "⌘"),
			],
			"",
		),
		KeyPlatform::Other => (
			[
				(modifiers.function, "Fn"),
				(modifiers.control, "Ctrl"),
				(modifiers.alt, "Alt"),
				(modifiers.shift, "Shift"),
				(modifiers.platform, "Super"),
			],
			" ",
		),
	};
	let mut parts: Vec<&str> = names
		.iter()
		.filter(|(held, _)| *held)
		.map(|(_, name)| *name)
		.collect();
	let key = key_name(&keystroke.key, platform);
	parts.push(&key);
	parts.join(separator)
}

/// The spelling of a key: a named key by its word or glyph, any other key
/// upper-cased.
fn key_name(key: &str, platform: KeyPlatform) -> String {
	let mac = platform == KeyPlatform::Mac;
	let named = match key {
		"enter" => Some(if mac { "↩" } else { "Enter" }),
		"escape" => Some("Esc"),
		"backspace" => Some(if mac { "⌫" } else { "Backspace" }),
		"delete" => Some(if mac { "⌦" } else { "Del" }),
		"tab" => Some(if mac { "⇥" } else { "Tab" }),
		"space" => Some("Space"),
		"up" => Some("↑"),
		"down" => Some("↓"),
		"left" => Some("←"),
		"right" => Some("→"),
		"pageup" => Some("PgUp"),
		"pagedown" => Some("PgDn"),
		"home" => Some("Home"),
		"end" => Some("End"),
		_ => None,
	};
	named.map_or_else(|| key.to_uppercase(), str::to_owned)
}

impl RenderOnce for Kbd {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let palette = cx.theme().palette;
		div()
			.flex()
			.flex_none()
			.items_center()
			.gap(space::S1)
			.children(self.caps().into_iter().map(|cap| {
				div()
					.px(space::S1)
					.rounded(radius::SM)
					.border_1()
					.border_color(palette.border.subtle)
					.bg(palette.bg.hover)
					.type_style(text::MICRO)
					.text_color(palette.text.muted)
					.child(cap)
			}))
	}
}
