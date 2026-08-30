//! Turning a theme file into a full set of colour roles.
//!
//! A theme file states the terminal's colours. The GUI needs those plus six
//! surfaces the terminal has no concept of, because a terminal has one ground
//! and a window has a stack of them. Every GUI role therefore has a source: a
//! colour the theme states, a colour derived from one it states, or an override
//! in the file's `gui` block.
//!
//! # Why derive rather than require
//!
//! There are 98 bundled themes and an unknown number of operator themes. A GUI
//! role that a theme has to state is a role that 98 files have to grow, and
//! that every operator theme lacks. So every role falls back, and the fallbacks
//! are ground-relative: a raised surface is its ground moved a few percent
//! toward whichever end of the greyscale axis the ground contrasts against.
//! That rule holds on a light theme and a dark one with no branch, and it is
//! the rule `ground-tints.ts` already applies in the terminal.
//!
//! # Why `export` is the surface source
//!
//! `export.{pageBg, cardBg, infoBg}` are the three grounds the HTML exporter
//! paints with, and all 98 bundled themes carry all three. They are already the
//! theme author's answer to "what are this theme's page, card and panel", so
//! the GUI uses them rather than asking the same question again under new
//! names.

use std::ops::Index;

use gpui::Hsla;

use crate::{
	color::Srgb,
	file::{Group, ThemeError, ThemeFile},
	role::Role,
};

/// Whether a theme is light or dark. Decided by the theme, not by the platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appearance {
	Light,
	Dark,
}

impl Appearance {
	pub const fn is_light(self) -> bool {
		matches!(self, Appearance::Light)
	}
}

/// A resolved theme: one colour per [`Role`].
///
/// Indexed by role, so a component reads `palette[Role::TextPrimary]` and there
/// is no lookup to fail at run time.
#[derive(Debug, Clone)]
pub struct Palette {
	/// The theme's name, as the file states it.
	pub name:       String,
	pub appearance: Appearance,
	colors:         [Hsla; Role::COUNT],
}

impl Index<Role> for Palette {
	type Output = Hsla;

	fn index(&self, role: Role) -> &Hsla {
		&self.colors[role as usize]
	}
}

impl Palette {
	/// Resolve a parsed theme file.
	///
	/// Fails on a colour the file states and this cannot read: a malformed hex
	/// string, an out-of-range palette index, a variable that does not exist or
	/// refers to itself, or a `gui` key that is not a role. It never fails on a
	/// colour the file omits.
	pub fn from_file(file: &ThemeFile) -> Result<Palette, ThemeError> {
		let derived = derive(file)?;
		let colors = std::array::from_fn(|index| Hsla::from(derived[index]));
		Ok(Palette {
			name: file.name.clone(),
			appearance: if file.is_light() {
				Appearance::Light
			} else {
				Appearance::Dark
			},
			colors,
		})
	}

	/// Parse and resolve in one step. `name` names the theme in errors.
	pub fn parse(name: &str, json: &str) -> Result<Palette, ThemeError> {
		Palette::from_file(&ThemeFile::parse(name, json)?)
	}

	/// The colour a role holds. Same as indexing; spelled out for call sites
	/// that read better as a call.
	pub fn color(&self, role: Role) -> Hsla {
		self[role]
	}
}

/// Fallback colours for a theme that states nothing at all.
///
/// Reached only by a theme file with an empty `colors` block, which no bundled
/// theme is. They exist so an operator's half-written theme renders a usable
/// window instead of a black one, and so this module has no `unwrap`.
mod fallback {
	use crate::color::Srgb;

	pub const DARK_GROUND: Srgb = Srgb::opaque(0x10, 0x10, 0x14);
	pub const LIGHT_GROUND: Srgb = Srgb::opaque(0xfa, 0xfa, 0xf8);
	/// What the terminal resolves an empty text colour to on a dark theme.
	pub const DARK_TEXT: Srgb = Srgb::opaque(0xe5, 0xe5, 0xe7);
	/// And on a light one.
	pub const LIGHT_TEXT: Srgb = Srgb::BLACK;
	pub const DARK_ACCENT: Srgb = Srgb::opaque(0x7a, 0xa2, 0xf7);
	pub const LIGHT_ACCENT: Srgb = Srgb::opaque(0x0a, 0x58, 0xca);
	pub const SUCCESS: Srgb = Srgb::opaque(0x3f, 0xb9, 0x50);
	pub const WARNING: Srgb = Srgb::opaque(0xd2, 0x99, 0x22);
	pub const ERROR: Srgb = Srgb::opaque(0xf8, 0x51, 0x49);
}

/// How far a derived colour moves from the one it is stated against, as a
/// fraction.
///
/// Two families, and they are not interchangeable. The CONTRAST steps
/// (`HAIRLINE`, `BORDER`, `HOVER`, `ACTIVE`, `SELECTED`) move toward whichever
/// end of the axis the ground contrasts against, and match the terminal's
/// ground tints so an edge separates by the same amount in both front ends. The
/// DEPTH steps (`RAISED`, `PANEL`, `OVERLAY`, `SUNKEN`) move toward white or
/// black regardless of the ground, because a card is whiter than its page on a
/// light theme too.
mod step {
	/// A hairline against its ground. Contrast.
	pub const HAIRLINE: f32 = 0.12;
	/// A visible border against its ground. Contrast.
	pub const BORDER: f32 = 0.20;
	/// The wash under the pointer. Contrast.
	pub const HOVER: f32 = 0.05;
	/// The wash while pressed. Contrast.
	pub const ACTIVE: f32 = 0.09;
	/// The fill of a selected row. Contrast.
	pub const SELECTED: f32 = 0.07;

	/// A card lifted off its page. Depth.
	pub const RAISED: f32 = 0.05;
	/// A panel beside the page. Depth.
	pub const PANEL: f32 = 0.03;
	/// An overlay above a card. Depth.
	pub const OVERLAY: f32 = 0.04;
	/// A well set into the page. Depth.
	///
	/// Larger than the others: a well has to read as an input at a glance, and
	/// it is the one surface with no content of its own to give it away.
	pub const SUNKEN: f32 = 0.10;

	/// How much of a diff line's text colour tints its ground.
	pub const DIFF_GROUND: f32 = 0.14;
	/// How far a supporting text colour falls back toward its ground.
	pub const RECEDE: f32 = 0.35;
}

/// Resolve every role, in dependency order.
///
/// One function rather than one per group: the roles form a shallow chain
/// (ground, then surfaces off the ground, then text against the surfaces), and
/// splitting it would mean passing half-built state between functions.
#[allow(clippy::too_many_lines)]
fn derive(file: &ThemeFile) -> Result<[Srgb; Role::COUNT], ThemeError> {
	let light = file.is_light();
	let colors = |role: &str| file.color(Group::Colors, role);
	let export = |role: &str| file.color(Group::Export, role);

	let default_ground = if light {
		fallback::LIGHT_GROUND
	} else {
		fallback::DARK_GROUND
	};
	let default_text = if light {
		fallback::LIGHT_TEXT
	} else {
		fallback::DARK_TEXT
	};
	let default_accent = if light {
		fallback::LIGHT_ACCENT
	} else {
		fallback::DARK_ACCENT
	};

	let status_bg = colors("statusLineBg")?;

	// Grounds first: everything below is stated against one of them.
	//
	// An exported ground is used only when it differs from the page. Three
	// bundled themes (`dark`, `light`, `titanium`) export the same colour for
	// all three, which is one flat ground — correct for a terminal, and in a
	// window a card with no edge against the page it sits on. A colour equal to
	// the page carries no more information than an absent one, so it takes the
	// same path.
	let window = export("pageBg")?.or(status_bg).unwrap_or(default_ground);
	let canvas = export("pageBg")?.unwrap_or(window);
	let distinct = |exported: Option<Srgb>| exported.filter(|ground| *ground != window);
	let raised = distinct(export("cardBg")?).unwrap_or_else(|| window.lift(step::RAISED));
	let panel = distinct(export("infoBg")?).unwrap_or_else(|| window.lift(step::PANEL));
	let overlay = raised.lift(step::OVERLAY);
	let sunken = window.sink(step::SUNKEN);

	let accent = colors("accent")?.unwrap_or(default_accent);
	let primary = colors("text")?.unwrap_or(default_text);
	let secondary = colors("muted")?.unwrap_or_else(|| primary.mix(window, step::RECEDE));
	let muted = colors("dim")?.unwrap_or_else(|| secondary.mix(window, step::RECEDE));

	let stroke_subtle = colors("borderMuted")?.unwrap_or_else(|| window.tint(step::HAIRLINE));
	let stroke_default = colors("border")?.unwrap_or_else(|| window.tint(step::BORDER));

	let success = colors("success")?.unwrap_or(fallback::SUCCESS);
	let warning = colors("warning")?.unwrap_or(fallback::WARNING);
	let error = colors("error")?.unwrap_or(fallback::ERROR);

	let diff_added = colors("toolDiffAdded")?.unwrap_or(success);
	let diff_removed = colors("toolDiffRemoved")?.unwrap_or(error);

	let mut out = [Srgb::BLACK; Role::COUNT];
	let mut set = |role: Role, color: Srgb| out[role as usize] = color;

	set(Role::SurfaceWindow, window);
	set(Role::SurfacePanel, panel);
	set(Role::SurfaceCanvas, canvas);
	set(Role::SurfaceRaised, raised);
	set(Role::SurfaceOverlay, overlay);
	set(Role::SurfaceSunken, sunken);

	set(Role::StrokeSubtle, stroke_subtle);
	set(Role::StrokeDefault, stroke_default);
	set(Role::StrokeStrong, colors("borderAccent")?.unwrap_or(accent));
	set(Role::StrokeFocus, accent);

	set(Role::TextPrimary, primary);
	set(Role::TextSecondary, secondary);
	set(Role::TextMuted, muted);
	set(Role::TextInverted, window);
	set(Role::TextAccent, accent);
	set(Role::TextLink, colors("link")?.unwrap_or(accent));

	set(Role::StateSuccess, success);
	set(Role::StateWarning, warning);
	set(Role::StateError, error);
	set(Role::StateInfo, accent);

	set(Role::InteractionHover, raised.tint(step::HOVER));
	set(Role::InteractionActive, raised.tint(step::ACTIVE));
	set(
		Role::InteractionSelected,
		colors("selectedBg")?.unwrap_or_else(|| raised.tint(step::SELECTED)),
	);
	set(Role::InteractionRing, accent);

	set(Role::MessageUserBg, colors("userMessageBg")?.unwrap_or(raised));
	set(Role::MessageUserText, colors("userMessageText")?.unwrap_or(primary));
	set(Role::MessageCustomBg, colors("customMessageBg")?.unwrap_or(raised));
	set(Role::MessageCustomText, colors("customMessageText")?.unwrap_or(primary));
	set(Role::MessageCustomLabel, colors("customMessageLabel")?.unwrap_or(accent));
	set(Role::MessageThinkingText, colors("thinkingText")?.unwrap_or(muted));

	set(Role::ToolName, colors("toolTitle")?.unwrap_or(primary));
	set(Role::ToolOutput, colors("toolOutput")?.unwrap_or(secondary));
	set(Role::ToolPendingBg, colors("toolPendingBg")?.unwrap_or(raised));
	set(Role::ToolSuccessBg, colors("toolSuccessBg")?.unwrap_or(raised));
	set(Role::ToolErrorBg, colors("toolErrorBg")?.unwrap_or(raised));

	set(Role::DiffAdded, diff_added);
	set(Role::DiffRemoved, diff_removed);
	set(Role::DiffContext, colors("toolDiffContext")?.unwrap_or(muted));
	set(Role::DiffAddedBg, window.mix(diff_added, step::DIFF_GROUND));
	set(Role::DiffRemovedBg, window.mix(diff_removed, step::DIFF_GROUND));

	set(Role::MdHeading, colors("mdHeading")?.unwrap_or(accent));
	set(Role::MdLink, colors("mdLink")?.unwrap_or(accent));
	set(Role::MdLinkUrl, colors("mdLinkUrl")?.unwrap_or(muted));
	set(Role::MdCode, colors("mdCode")?.unwrap_or(accent));
	set(Role::MdCodeBlock, colors("mdCodeBlock")?.unwrap_or(primary));
	set(Role::MdCodeBlockBorder, colors("mdCodeBlockBorder")?.unwrap_or(stroke_subtle));
	set(Role::MdQuote, colors("mdQuote")?.unwrap_or(secondary));
	set(Role::MdQuoteBorder, colors("mdQuoteBorder")?.unwrap_or(stroke_default));
	set(Role::MdRule, colors("mdHr")?.unwrap_or(stroke_subtle));
	set(Role::MdBullet, colors("mdListBullet")?.unwrap_or(accent));

	set(Role::StatusBg, status_bg.unwrap_or(window));
	set(Role::StatusSep, colors("statusLineSep")?.unwrap_or(stroke_subtle));
	set(Role::StatusModel, colors("statusLineModel")?.unwrap_or(primary));
	set(Role::StatusPath, colors("statusLinePath")?.unwrap_or(accent));
	set(Role::StatusContext, colors("statusLineContext")?.unwrap_or(secondary));
	set(Role::StatusCost, colors("statusLineCost")?.unwrap_or(secondary));
	set(Role::StatusSpend, colors("statusLineSpend")?.unwrap_or(secondary));
	set(Role::StatusOutput, colors("statusLineOutput")?.unwrap_or(secondary));
	set(Role::StatusSubagents, colors("statusLineSubagents")?.unwrap_or(accent));
	set(Role::StatusGitClean, colors("statusLineGitClean")?.unwrap_or(success));
	set(Role::StatusGitDirty, colors("statusLineGitDirty")?.unwrap_or(warning));
	set(Role::StatusGitStaged, colors("statusLineStaged")?.unwrap_or(success));
	set(Role::StatusGitUntracked, colors("statusLineUntracked")?.unwrap_or(secondary));

	set(Role::EffortOff, colors("thinkingOff")?.unwrap_or(muted));
	set(Role::EffortMinimal, colors("thinkingMinimal")?.unwrap_or(muted));
	set(Role::EffortLow, colors("thinkingLow")?.unwrap_or(secondary));
	set(Role::EffortMedium, colors("thinkingMedium")?.unwrap_or(accent));
	set(Role::EffortHigh, colors("thinkingHigh")?.unwrap_or(warning));
	set(Role::EffortXhigh, colors("thinkingXhigh")?.unwrap_or(error));

	set(Role::ModeBash, colors("bashMode")?.unwrap_or(accent));
	set(Role::ModePython, colors("pythonMode")?.unwrap_or(accent));

	set(Role::SyntaxKeyword, colors("syntaxKeyword")?.unwrap_or(accent));
	set(Role::SyntaxString, colors("syntaxString")?.unwrap_or(success));
	set(Role::SyntaxNumber, colors("syntaxNumber")?.unwrap_or(accent));
	set(Role::SyntaxComment, colors("syntaxComment")?.unwrap_or(muted));
	set(Role::SyntaxFunction, colors("syntaxFunction")?.unwrap_or(accent));
	set(Role::SyntaxType, colors("syntaxType")?.unwrap_or(accent));
	set(Role::SyntaxVariable, colors("syntaxVariable")?.unwrap_or(primary));
	set(Role::SyntaxOperator, colors("syntaxOperator")?.unwrap_or(secondary));
	set(Role::SyntaxPunctuation, colors("syntaxPunctuation")?.unwrap_or(secondary));

	// `set` borrows `out` mutably; its last use is above, so the borrow has
	// ended by here.
	apply_overrides(file, &mut out)?;
	Ok(out)
}

/// Apply the file's `gui` block over the derived roles.
///
/// A key that is not a role is an error, not a skip. A theme author who writes
/// `surface.raize` and gets no error has a theme that silently ignores the line
/// they came to write, and no way to find out why.
fn apply_overrides(file: &ThemeFile, out: &mut [Srgb; Role::COUNT]) -> Result<(), ThemeError> {
	for key in file.gui.keys() {
		let role = Role::from_key(key)
			.ok_or_else(|| ThemeError::UnknownRole { theme: file.name.clone(), key: key.clone() })?;
		// An empty value means "leave the derived colour", which is how a theme
		// comments a line out without deleting it.
		if let Some(color) = file.color(Group::Gui, key)? {
			out[role as usize] = color;
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::color::Srgb;

	/// A theme with grounds, an accent and a status line: enough to exercise
	/// every derivation branch that has a source, while leaving most roles on
	/// their fallback.
	const MINIMAL: &str = r##"{
		"name": "minimal",
		"colors": { "statusLineBg": "#1d2021", "accent": "#fe8019", "text": "" },
		"export": { "pageBg": "#1d2021", "cardBg": "#282828", "infoBg": "#3c3836" }
	}"##;

	fn palette(json: &str) -> Palette {
		Palette::parse("test", json).expect("resolves")
	}

	fn hex(palette: &Palette, role: Role) -> String {
		let rgba = gpui::Rgba::from(palette[role]);
		Srgb {
			r: (rgba.r * 255.0).round() as u8,
			g: (rgba.g * 255.0).round() as u8,
			b: (rgba.b * 255.0).round() as u8,
			a: (rgba.a * 255.0).round() as u8,
		}
		.to_hex()
	}

	/// The three exported grounds land on the three surfaces that name them.
	/// This is the mapping the whole surface stack rests on.
	#[test]
	fn the_export_block_supplies_the_surfaces() {
		let palette = palette(MINIMAL);
		assert_eq!(hex(&palette, Role::SurfaceWindow), "#1d2021");
		assert_eq!(hex(&palette, Role::SurfaceCanvas), "#1d2021");
		assert_eq!(hex(&palette, Role::SurfaceRaised), "#282828");
		assert_eq!(hex(&palette, Role::SurfacePanel), "#3c3836");
	}

	/// A theme with no `export` block still gets a full surface stack, derived
	/// from the status line. Operator themes written for the terminal have no
	/// `export` block.
	#[test]
	fn surfaces_derive_when_the_export_block_is_absent() {
		let palette = palette(r##"{ "name": "t", "colors": { "statusLineBg": "#1d2021" } }"##);
		assert_eq!(hex(&palette, Role::SurfaceWindow), "#1d2021");
		// Raised and panel move off the window rather than equalling it: a card
		// that matches its page is a card with no edge.
		assert_ne!(hex(&palette, Role::SurfaceRaised), "#1d2021");
		assert_ne!(hex(&palette, Role::SurfacePanel), "#1d2021");
	}

	/// The surface stack runs one way on both appearances: the well is darker
	/// than the page, and each surface above it is at least as light as the one
	/// below.
	///
	/// One rule for both, which is the point of deriving depth from white and
	/// black rather than from the contrast pole. Under a pole-relative rule a
	/// light theme's card moved away from white, so a white card on an off-white
	/// page — which `alabaster` states in its own export block — read as an
	/// inversion.
	#[test]
	fn the_surface_stack_runs_one_way_on_both_appearances() {
		let light = r##"{ "name": "t", "colors": { "statusLineBg": "#fafaf8" }, "export": { "pageBg": "#fafaf8" } }"##;
		for source in [MINIMAL, light] {
			let palette = palette(source);
			let luma = |role: Role| {
				let rgba = gpui::Rgba::from(palette[role]);
				0.2126 * rgba.r + 0.7152 * rgba.g + 0.0722 * rgba.b
			};
			let appearance = palette.appearance;

			assert!(
				luma(Role::SurfaceSunken) < luma(Role::SurfaceWindow),
				"{appearance:?}: the well is not set in"
			);
			assert!(
				luma(Role::SurfaceWindow) <= luma(Role::SurfaceRaised),
				"{appearance:?}: the card is not lifted"
			);
			assert!(
				luma(Role::SurfaceRaised) <= luma(Role::SurfaceOverlay),
				"{appearance:?}: the overlay is not above the card"
			);
		}
	}

	/// Both minimal sources above are classified as intended, so the sweep is
	/// actually covering two appearances rather than the same one twice.
	#[test]
	fn the_minimal_sources_cover_both_appearances() {
		assert_eq!(palette(MINIMAL).appearance, Appearance::Dark);
		let light = r##"{ "name": "t", "colors": { "statusLineBg": "#fafaf8" }, "export": { "pageBg": "#fafaf8" } }"##;
		assert_eq!(palette(light).appearance, Appearance::Light);
	}

	/// An empty `text` resolves to the appearance's default foreground, matching
	/// what the terminal paints. Half the bundled themes leave `text` empty.
	#[test]
	fn an_empty_text_colour_falls_back_by_appearance() {
		assert_eq!(hex(&palette(MINIMAL), Role::TextPrimary), "#e5e5e7");

		let light =
			palette(r##"{ "name": "t", "colors": { "statusLineBg": "#fafaf8", "text": "" } }"##);
		assert_eq!(hex(&light, Role::TextPrimary), "#000000");
	}

	/// Text that recedes actually recedes: secondary is closer to the ground
	/// than primary, and muted closer still.
	#[test]
	fn receding_text_moves_toward_its_ground() {
		let palette = palette(MINIMAL);
		let distance = |role: Role| {
			let text = gpui::Rgba::from(palette[role]);
			let ground = gpui::Rgba::from(palette[Role::SurfaceWindow]);
			(text.r - ground.r).abs() + (text.g - ground.g).abs() + (text.b - ground.b).abs()
		};
		assert!(distance(Role::TextPrimary) > distance(Role::TextSecondary));
		assert!(distance(Role::TextSecondary) > distance(Role::TextMuted));
	}

	/// Every role resolves for a theme that states almost nothing. A role left
	/// at the array's initial black would be an invisible surface, and the
	/// initial value is black, so this is the test that no slot is missed.
	#[test]
	fn every_role_resolves_for_a_near_empty_theme() {
		let palette = palette(r##"{ "name": "t", "colors": { "statusLineBg": "#1d2021" } }"##);
		for role in Role::ALL {
			let color = hex(&palette, *role);
			assert_ne!(
				color,
				"#000000",
				"{} is black, which is this array's uninitialised value",
				role.key()
			);
		}
	}

	/// A `gui` block overrides the derived colour.
	#[test]
	fn a_gui_override_replaces_a_derived_role() {
		let palette = palette(
			r##"{
				"name": "t",
				"colors": { "statusLineBg": "#1d2021" },
				"export": { "cardBg": "#282828" },
				"gui": { "surface.raised": "#ff0000" }
			}"##,
		);
		assert_eq!(hex(&palette, Role::SurfaceRaised), "#ff0000");
	}

	/// An override may name a variable, like any other colour in the file.
	#[test]
	fn a_gui_override_resolves_variables() {
		let palette = palette(
			r##"{
				"name": "t",
				"vars": { "brand": "#00ff88" },
				"colors": { "statusLineBg": "#1d2021" },
				"gui": { "text.accent": "brand" }
			}"##,
		);
		assert_eq!(hex(&palette, Role::TextAccent), "#00ff88");
	}

	/// Every role is settable from a `gui` block. A role that cannot be
	/// overridden is one the operator cannot theme, and there is no reason for
	/// one to exist — so this sweeps the enumeration rather than sampling it.
	#[test]
	fn every_role_is_settable_from_a_gui_block() {
		for role in Role::ALL {
			let json = format!(
				r##"{{ "name": "t", "colors": {{ "statusLineBg": "#1d2021" }}, "gui": {{ "{}": "#ff00ff" }} }}"##,
				role.key()
			);
			let palette = Palette::parse("test", &json)
				.unwrap_or_else(|error| panic!("{} could not be overridden: {error}", role.key()));
			assert_eq!(hex(&palette, *role), "#ff00ff", "{} did not take the override", role.key());
		}
	}

	/// A misspelled role is reported, naming the key and the theme. Silently
	/// ignoring it is the failure mode this exists to prevent.
	#[test]
	fn an_unknown_gui_key_is_reported() {
		let error = Palette::parse(
			"mine",
			r##"{ "name": "mine", "colors": { "statusLineBg": "#1d2021" }, "gui": { "surface.raize": "#ff0000" } }"##,
		)
		.expect_err("unknown role");
		let ThemeError::UnknownRole { theme, key } = error else {
			panic!("wrong error")
		};
		assert_eq!(theme, "mine");
		assert_eq!(key, "surface.raize");
	}

	/// An empty override leaves the derived colour, so a theme can keep the line
	/// without applying it.
	#[test]
	fn an_empty_gui_override_leaves_the_derived_colour() {
		let derived = hex(&palette(MINIMAL), Role::SurfaceRaised);
		let overridden = palette(
			r##"{
				"name": "minimal",
				"colors": { "statusLineBg": "#1d2021", "accent": "#fe8019", "text": "" },
				"export": { "pageBg": "#1d2021", "cardBg": "#282828", "infoBg": "#3c3836" },
				"gui": { "surface.raised": "" }
			}"##,
		);
		assert_eq!(hex(&overridden, Role::SurfaceRaised), derived);
	}

	/// A colour the file states and this cannot read fails the build. A theme
	/// that renders with one role quietly wrong is worse than one that reports
	/// the line.
	#[test]
	fn a_stated_colour_that_cannot_be_read_fails_the_build() {
		for broken in [
			r##"{ "name": "t", "colors": { "statusLineBg": "#1d2021", "accent": "#zzzzzz" } }"##,
			r##"{ "name": "t", "colors": { "statusLineBg": "#1d2021", "accent": 999 } }"##,
			r##"{ "name": "t", "colors": { "statusLineBg": "#1d2021", "accent": "missingVar" } }"##,
			r##"{ "name": "t", "vars": { "a": "b", "b": "a" }, "colors": { "statusLineBg": "#1d2021", "accent": "a" } }"##,
			r##"{ "name": "t", "colors": { "statusLineBg": "#1d2021" }, "export": { "pageBg": "#nope" } }"##,
		] {
			assert!(Palette::parse("t", broken).is_err(), "{broken} resolved");
		}
	}

	/// Appearance comes from the theme, and the palette carries it: a component
	/// that needs to know which way to shade asks the palette, not the platform.
	#[test]
	fn the_palette_carries_the_appearance_and_the_name() {
		let palette = palette(MINIMAL);
		assert_eq!(palette.name, "minimal");
		assert_eq!(palette.appearance, Appearance::Dark);
		assert!(!palette.appearance.is_light());
	}

	/// `Role as usize` indexes the array, and `Role::ALL` is in declaration
	/// order, so the two have to agree. They do only because no variant carries
	/// an explicit discriminant — this is what catches someone adding one.
	#[test]
	fn role_discriminants_match_their_position() {
		for (position, role) in Role::ALL.iter().enumerate() {
			assert_eq!(*role as usize, position, "{} is out of position", role.key());
		}
	}
}
