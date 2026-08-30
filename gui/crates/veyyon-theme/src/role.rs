//! The colour roles a veyyon surface draws with.
//!
//! A component names a role, never a colour. Swapping the theme then changes
//! every surface at once, and a theme author has a fixed vocabulary to write
//! against.
//!
//! The list covers every colour a theme file states, plus the surfaces the GUI
//! derives. A theme colour with no role here would be one the terminal honours
//! and the GUI drops, which is the same theme looking like two products.
//!
//! The enum, the enumeration of it, and the string key a theme file uses are
//! generated together by one macro invocation. Adding a role is one line, and
//! it is impossible to add one that cannot be enumerated or cannot be named in
//! a theme file — which is what would otherwise make a `gui` override block
//! silently ignore it.

macro_rules! roles {
	($( $(#[$doc:meta])* $variant:ident => $key:literal, )+) => {
		/// One colour slot. See the module docs.
		#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
		pub enum Role {
			$( $(#[$doc])* $variant, )+
		}

		impl Role {
			/// Every role, in declaration order.
			pub const ALL: &'static [Role] = &[ $( Role::$variant, )+ ];

			/// How many roles there are. The palette is an array of this length.
			pub const COUNT: usize = Role::ALL.len();

			/// The name a theme file uses for this role.
			pub const fn key(self) -> &'static str {
				match self {
					$( Role::$variant => $key, )+
				}
			}

			/// The role a theme file's name refers to, or `None` when it names
			/// nothing. A caller reports the `None` rather than skipping it: a
			/// misspelled role that is silently dropped is a theme that looks
			/// wrong with no error.
			pub fn from_key(key: &str) -> Option<Role> {
				match key {
					$( $key => Some(Role::$variant), )+
					_ => None,
				}
			}
		}
	};
}

roles! {
	// Surfaces. The GUI derives these; a theme file states at most three of
	// them, in its `export` block.
	/// The outermost ground. Everything else sits on it.
	SurfaceWindow => "surface.window",
	/// Sidebar and rail.
	SurfacePanel => "surface.panel",
	/// The transcript's ground.
	SurfaceCanvas => "surface.canvas",
	/// A card on the canvas: a message, a tool call.
	SurfaceRaised => "surface.raised",
	/// A popover, menu or dialog, above everything.
	SurfaceOverlay => "surface.overlay",
	/// A well: the composer input, a code block.
	SurfaceSunken => "surface.sunken",

	/// Hairline between rows of one surface.
	StrokeSubtle => "stroke.subtle",
	/// The outline of a card.
	StrokeDefault => "stroke.default",
	/// An outline that has to be seen: an active pane, a selected card.
	StrokeStrong => "stroke.strong",
	/// Keyboard focus.
	StrokeFocus => "stroke.focus",

	/// Body text.
	TextPrimary => "text.primary",
	/// Supporting text: a timestamp, a byte count.
	TextSecondary => "text.secondary",
	/// Text that is present but not being read.
	TextMuted => "text.muted",
	/// Text on an accent fill.
	TextInverted => "text.inverted",
	/// Text carrying the accent colour.
	TextAccent => "text.accent",
	/// A hyperlink.
	TextLink => "text.link",

	StateSuccess => "state.success",
	StateWarning => "state.warning",
	StateError => "state.error",
	StateInfo => "state.info",

	/// Wash under the pointer.
	InteractionHover => "interaction.hover",
	/// Wash while pressed.
	InteractionActive => "interaction.active",
	/// Fill of the selected row.
	InteractionSelected => "interaction.selected",
	/// Focus ring.
	InteractionRing => "interaction.ring",

	/// Ground of the operator's own turns.
	MessageUserBg => "message.user.bg",
	/// Text of the operator's own turns.
	MessageUserText => "message.user.text",
	/// Ground of a turn the harness inserted: a hook, a system notice.
	MessageCustomBg => "message.custom.bg",
	/// Text of such a turn.
	MessageCustomText => "message.custom.text",
	/// Its label.
	MessageCustomLabel => "message.custom.label",
	/// Reasoning the model exposed.
	MessageThinkingText => "message.thinking.text",

	/// A tool's name in its header.
	ToolName => "tool.name",
	/// A tool's output body.
	ToolOutput => "tool.output",
	/// Ground of a tool call still running.
	ToolPendingBg => "tool.pending.bg",
	/// Ground of a tool call that finished.
	ToolSuccessBg => "tool.success.bg",
	/// Ground of a tool call that failed.
	ToolErrorBg => "tool.error.bg",

	/// An added line's text.
	DiffAdded => "diff.added",
	/// A removed line's text.
	DiffRemoved => "diff.removed",
	/// An unchanged line's text.
	DiffContext => "diff.context",
	/// An added line's ground.
	DiffAddedBg => "diff.added.bg",
	/// A removed line's ground.
	DiffRemovedBg => "diff.removed.bg",

	MdHeading => "md.heading",
	MdLink => "md.link",
	MdLinkUrl => "md.link.url",
	MdCode => "md.code",
	MdCodeBlock => "md.code.block",
	MdCodeBlockBorder => "md.code.border",
	MdQuote => "md.quote",
	MdQuoteBorder => "md.quote.border",
	/// A horizontal rule.
	MdRule => "md.rule",
	/// A list marker.
	MdBullet => "md.bullet",

	/// Ground of the status bar. Also what decides whether a theme is light.
	StatusBg => "status.bg",
	/// Separator between status segments.
	StatusSep => "status.sep",
	StatusModel => "status.model",
	StatusPath => "status.path",
	StatusContext => "status.context",
	StatusCost => "status.cost",
	StatusSpend => "status.spend",
	StatusOutput => "status.output",
	StatusSubagents => "status.subagents",
	/// A clean working tree.
	StatusGitClean => "status.git.clean",
	/// A dirty working tree.
	StatusGitDirty => "status.git.dirty",
	StatusGitStaged => "status.git.staged",
	StatusGitUntracked => "status.git.untracked",

	/// Reasoning effort, off through highest. The status bar and the effort
	/// picker both use these.
	EffortOff => "effort.off",
	EffortMinimal => "effort.minimal",
	EffortLow => "effort.low",
	EffortMedium => "effort.medium",
	EffortHigh => "effort.high",
	EffortXhigh => "effort.xhigh",

	/// The composer in shell mode.
	ModeBash => "mode.bash",
	/// The composer in python mode.
	ModePython => "mode.python",

	SyntaxKeyword => "syntax.keyword",
	SyntaxString => "syntax.string",
	SyntaxNumber => "syntax.number",
	SyntaxComment => "syntax.comment",
	SyntaxFunction => "syntax.function",
	SyntaxType => "syntax.type",
	SyntaxVariable => "syntax.variable",
	SyntaxOperator => "syntax.operator",
	SyntaxPunctuation => "syntax.punctuation",
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeSet;

	use super::*;

	/// Every role's key round-trips. A role whose key does not resolve back to
	/// it cannot be set in a theme file, and the macro is what makes that
	/// impossible — this is the test that the macro does it.
	#[test]
	fn every_role_key_round_trips() {
		for role in Role::ALL {
			assert_eq!(
				Role::from_key(role.key()),
				Some(*role),
				"{role:?} keyed {:?} did not round-trip",
				role.key()
			);
		}
	}

	/// No two roles share a key. A duplicate would make one of them
	/// unreachable, and match arm order would decide which — silently.
	#[test]
	fn role_keys_are_unique() {
		let keys: BTreeSet<&str> = Role::ALL.iter().map(|role| role.key()).collect();
		assert_eq!(keys.len(), Role::COUNT, "{} roles share keys", Role::COUNT - keys.len());
	}

	/// Keys are dotted, lowercase and two or three segments. A theme file is
	/// hand-written, so the vocabulary has to be predictable.
	#[test]
	fn role_keys_follow_one_shape() {
		for role in Role::ALL {
			let key = role.key();
			let segments: Vec<&str> = key.split('.').collect();
			assert!((2..=3).contains(&segments.len()), "{key} is not two or three segments");
			for segment in segments {
				assert!(!segment.is_empty(), "{key} has an empty segment");
				assert!(
					segment.chars().all(|c| c.is_ascii_lowercase()),
					"{key} is not lowercase ascii"
				);
			}
		}
	}

	/// An unknown key resolves to nothing, so a caller can report it.
	#[test]
	fn an_unknown_key_resolves_to_nothing() {
		for key in ["", "surface", "surface.", "surface.nope", "Surface.Window", "text.primary "] {
			assert_eq!(Role::from_key(key), None, "{key:?} resolved");
		}
	}

	/// `COUNT` is the length of `ALL`, which is what the palette array is sized
	/// by. If these disagree the palette either panics or has dead slots.
	#[test]
	fn the_count_matches_the_enumeration() {
		assert_eq!(Role::COUNT, Role::ALL.len());
		const { assert!(Role::COUNT > 0) };
	}
}
