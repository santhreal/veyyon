//! The icon set: Lucide glyphs embedded in the binary and served to GPUI as
//! assets.
//!
//! Each glyph is a 24 × 24 stroked SVG from the Lucide 1.48.0 release, under
//! the ISC license (`icons/LUCIDE-LICENSE.txt`). `trash-2` and `history` are
//! the Lucide aliases of `trash` and `rotate-ccw-clock`. The application
//! serves them by installing [`Assets`] with `Application::with_assets`, and a
//! view draws one with [`Icon`].

mod icon;

use std::borrow::Cow;

pub use icon::Icon;
use strum::{EnumIter, IntoEnumIterator};
use veyyon_gpui::{AssetSource, SharedString};

/// Declares every icon once: its variant, its Lucide name, its asset path and
/// its embedded bytes all derive from one row.
macro_rules! icons {
	($($variant:ident => $name:literal,)+) => {
		/// Every icon the window draws.
		#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, EnumIter)]
		pub enum IconName {
			$(
				#[doc = concat!("The Lucide `", $name, "` glyph.")]
				$variant,
			)+
		}

		impl IconName {
			/// The Lucide name of the glyph, which is also its file stem.
			pub const fn name(self) -> &'static str {
				match self {
					$(Self::$variant => $name,)+
				}
			}

			/// The asset path [`Assets`] serves the glyph at.
			pub const fn path(self) -> &'static str {
				match self {
					$(Self::$variant => concat!("icons/", $name, ".svg"),)+
				}
			}

			/// The icon served at `path`, or `None` for a path outside the set.
			pub fn from_path(path: &str) -> Option<Self> {
				match path {
					$(concat!("icons/", $name, ".svg") => Some(Self::$variant),)+
					_ => None,
				}
			}

			/// The SVG document of the glyph.
			pub const fn svg(self) -> &'static [u8] {
				match self {
					$(Self::$variant => include_bytes!(concat!("../../icons/", $name, ".svg")),)+
				}
			}
		}
	};
}

icons! {
	Plus => "plus",
	Search => "search",
	Settings => "settings",
	ChevronRight => "chevron-right",
	ChevronDown => "chevron-down",
	X => "x",
	Check => "check",
	Circle => "circle",
	LoaderCircle => "loader-circle",
	Terminal => "terminal",
	File => "file",
	FileText => "file-text",
	Folder => "folder",
	FolderOpen => "folder-open",
	GitBranch => "git-branch",
	GitCompare => "git-compare",
	GitFork => "git-fork",
	Bot => "bot",
	ListTodo => "list-todo",
	TriangleAlert => "triangle-alert",
	CircleAlert => "circle-alert",
	Info => "info",
	Square => "square",
	ArrowUp => "arrow-up",
	Paperclip => "paperclip",
	Mic => "mic",
	Copy => "copy",
	Pencil => "pencil",
	Trash2 => "trash-2",
	Ellipsis => "ellipsis",
	PanelLeft => "panel-left",
	PanelRight => "panel-right",
	PanelBottom => "panel-bottom",
	Command => "command",
	Sparkles => "sparkles",
	Brain => "brain",
	Wrench => "wrench",
	Play => "play",
	Pause => "pause",
	RefreshCw => "refresh-cw",
	ExternalLink => "external-link",
	Eye => "eye",
	Lock => "lock",
	KeyRound => "key-round",
	Globe => "globe",
	Image => "image",
	History => "history",
	Archive => "archive",
	SlidersHorizontal => "sliders-horizontal",
	Keyboard => "keyboard",
	Sun => "sun",
	Moon => "moon",
	Monitor => "monitor",
	User => "user",
	Zap => "zap",
	Clock => "clock",
}

/// The asset source that serves every embedded icon at [`IconName::path`].
///
/// Any other path loads as `None`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Assets;

impl AssetSource for Assets {
	fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
		Ok(IconName::from_path(path).map(|icon| Cow::Borrowed(icon.svg())))
	}

	fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
		Ok(IconName::iter()
			.map(IconName::path)
			.filter(|served| served.starts_with(path))
			.map(SharedString::new_static)
			.collect())
	}
}
