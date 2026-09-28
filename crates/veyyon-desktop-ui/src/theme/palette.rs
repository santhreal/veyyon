//! The color roles of one appearance, read from an embedded TOML file.
//!
//! Every role is a required key and an unknown key is an error, so a palette
//! file cannot drift from the roles the views read.

use serde::{Deserialize, Deserializer, de::Error as _};
use veyyon_gpui::{Hsla, Rgba};

/// Declares one table of color roles, each deserialized from a hex string.
macro_rules! roles {
	($(#[$doc:meta])* $name:ident { $($(#[$fattr:meta])* $field:ident),+ $(,)? }) => {
		$(#[$doc])*
		#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
		#[serde(deny_unknown_fields)]
		pub struct $name {
			$(
				$(#[$fattr])*
				#[serde(deserialize_with = "color")]
				pub $field: Hsla,
			)+
		}
	};
}

roles! {
	/// Backgrounds, from the window ground up to a raised surface.
	Bg {
		/// The window ground and the transcript.
		app,
		/// The sidebar column.
		sidebar,
		/// A user message, the composer, a code block's frame.
		surface,
		/// Popovers, menus, the command palette.
		elevated,
		/// A hovered row, translucent over whatever is under it.
		hover,
		/// The selected row, translucent over whatever is under it.
		selected,
	}
}

roles! {
	/// Foreground text, from the strongest to the weakest.
	Text {
		/// Titles and prose.
		primary,
		/// Secondary labels.
		secondary,
		/// Timestamps, hints, metadata.
		muted,
		/// Disabled text and placeholders.
		faint,
	}
}

roles! {
	/// One-pixel rules and outlines.
	Border {
		/// Dividers between regions.
		subtle,
		/// Inputs and the composer frame.
		default,
		/// A focused or hovered outline.
		strong,
	}
}

roles! {
	/// The brand color and what sits on it.
	Accent {
		/// The accent fill.
		base,
		/// Text and icons on an accent fill.
		fg,
		/// The keyboard focus ring.
		focus_ring,
	}
}

roles! {
	/// Run and outcome states.
	Status {
		/// A turn in progress.
		running,
		/// Waiting on the operator.
		waiting,
		/// A failure.
		error,
		/// A success.
		success,
		/// Neutral information.
		info,
	}
}

roles! {
	/// Added and removed lines of a diff.
	Diff {
		/// Background of an added line.
		add_bg,
		/// Text of an added line.
		add_fg,
		/// Background of a removed line.
		del_bg,
		/// Text of a removed line.
		del_fg,
	}
}

roles! {
	/// Code blocks.
	Code {
		/// Background of a code block and of inline code.
		bg,
	}
}

roles! {
	/// Syntax highlighting classes; a highlighter maps its scopes onto these.
	Syntax {
		/// Language keywords.
		keyword,
		/// String literals.
		string,
		/// Numeric literals.
		number,
		/// Comments.
		comment,
		/// Function and method names.
		function,
		/// Type names.
		#[serde(rename = "type")]
		type_name,
		/// Constants and enum members.
		constant,
		/// Variables and plain identifiers.
		variable,
		/// Operators.
		operator,
		/// Brackets, commas, separators.
		punctuation,
		/// Markup tags.
		tag,
		/// Markup attributes and annotations.
		attribute,
	}
}

/// Every color role of one appearance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Palette {
	/// Backgrounds.
	pub bg:     Bg,
	/// Foreground text.
	pub text:   Text,
	/// Rules and outlines.
	pub border: Border,
	/// The brand color.
	pub accent: Accent,
	/// Run and outcome states.
	pub status: Status,
	/// Diff lines.
	pub diff:   Diff,
	/// Code blocks.
	pub code:   Code,
	/// Syntax highlighting.
	pub syntax: Syntax,
}

/// Parses a `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` string.
fn color<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Hsla, D::Error> {
	let hex = String::deserialize(deserializer)?;
	Rgba::try_from(hex.as_str())
		.map(Hsla::from)
		.map_err(|error| D::Error::custom(format!("{hex:?} is not a hex color: {error}")))
}
