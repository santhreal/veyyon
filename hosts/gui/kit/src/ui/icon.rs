//! Semantic icon catalog.
//!
//! Variants name routes and actions rather than asset filenames. Every drawing
//! uses the same 24 px optical grid and two-pixel stroke. Icon-only controls
//! use `Icon::meaning()` as their mandatory tooltip when no richer phrase is
//! given.

use gpui::{Hsla, Styled, Svg, px, svg};

macro_rules! icons {
	($(($variant:ident, $file:literal, $meaning:literal)),+ $(,)?) => {
		#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
		pub enum Icon { $($variant,)+ }
		impl Icon {
			pub const ALL: &'static [Icon] = &[$(Icon::$variant),+];
			pub fn bytes(self) -> &'static [u8] { match self { $(Icon::$variant => include_bytes!(concat!("../../assets/icons/", $file, ".svg")),)+ } }
			pub fn meaning(self) -> &'static str { match self { $(Icon::$variant => $meaning,)+ } }
			pub fn file(self) -> &'static str { match self { $(Icon::$variant => $file,)+ } }
		}
	};
}

icons![
	// Routes and shell presentation.
	(Conversation, "messages-square", "conversations"),
	(Changes, "git-compare-arrows", "changes"),
	(Files, "files", "files"),
	(Agents, "users", "agents"),
	(Terminal, "square-terminal", "terminal"),
	(Settings, "sliders-horizontal", "settings"),
	(Panel, "panel-left", "show or hide the sidebar"),
	(Inspector, "panel-right", "show or hide the inspector"),
	(Dock, "panel-bottom", "show or hide the bottom dock"),
	(PanelTop, "panel-top", "move the panel"),
	(SidebarClose, "panel-left-close", "close the sidebar"),
	(InspectorClose, "panel-right-close", "close the inspector"),
	(Connection, "plug-zap", "connection state"),
	(Activity, "activity", "running activity"),
	(Disconnected, "wifi-off", "disconnected"),
	// Navigation and global actions.
	(Search, "search", "search"),
	(FileSearch, "file-search", "search files"),
	(Filter, "list-filter", "filter"),
	(New, "plus", "create"),
	(Close, "x", "close"),
	(More, "ellipsis", "more actions"),
	(Command, "command", "command palette"),
	(Keyboard, "keyboard", "keyboard shortcuts"),
	(Shortcut, "key-round", "keyboard shortcut"),
	(External, "external-link", "open externally"),
	(Preview, "eye", "preview"),
	// Lists and disclosure.
	(Folded, "chevron-right", "collapsed"),
	(Open, "chevron-down", "expanded"),
	(Check, "check", "selected"),
	(StatusDot, "circle-dot", "status"),
	(Tree, "folder-tree", "file tree"),
	// Conversation and composer.
	(Send, "arrow-up", "send"),
	(Stop, "square", "stop"),
	(Abort, "square-x", "abort"),
	(Copy, "copy", "copy"),
	(Paste, "clipboard-paste", "paste"),
	(Delete, "trash-2", "delete"),
	(Attachment, "paperclip", "attach a file"),
	(Mention, "at-sign", "mention a file"),
	(Return, "corner-down-left", "return"),
	(Image, "image", "image attachment"),
	(Question, "circle-question-mark", "answer a question"),
	(QuestionChat, "message-circle-question-mark", "structured question"),
	(Review, "message-square-check", "review"),
	(Plan, "list-checks", "plan"),
	(AddToComposer, "message-square-plus", "add to composer"),
	(Background, "picture-in-picture", "send in background"),
	(Compact, "archive", "compact context"),
	(Restore, "archive-restore", "restore"),
	(Handoff, "arrow-right-left", "handoff"),
	(Model, "boxes", "model"),
	(Thinking, "brain", "thinking level"),
	(Mode, "toggle-left", "mode"),
	(Magic, "wand-sparkles", "automatic selection"),
	// Session and source control.
	(Checkout, "folder", "workspace"),
	(Branch, "git-branch", "branch"),
	(BranchFrom, "git-fork", "branch from here"),
	(Pin, "pin", "pin"),
	(Rename, "pencil", "rename"),
	(Export, "download", "export"),
	// Runtime and tools.
	(Engine, "bot", "engine"),
	(Ran, "terminal", "command output"),
	(Read, "file-text", "file read"),
	(Edited, "pencil", "file edited"),
	(Changed, "file-diff", "file changed"),
	(Tool, "wrench", "tool"),
	(Allow, "shield", "approval required"),
	(Approved, "shield-check", "approved"),
	(Running, "loader-circle", "running"),
	(Retry, "refresh-cw", "retry"),
	(Restart, "rotate-ccw", "restart"),
	// Terminal and large view controls.
	(Split, "split", "split view"),
	(SplitVertical, "columns-2", "split vertically"),
	(SplitHorizontal, "rows-2", "split horizontally"),
	(Clear, "eraser", "clear"),
	(Focus, "crosshair", "focus"),
	(Output, "logs", "output"),
	(Pause, "pause", "pause"),
	(Resume, "play", "resume"),
	(Wrap, "text-wrap", "wrap lines"),
	// Status.
	(Failed, "triangle-alert", "error"),
	(Problems, "circle-alert", "problems"),
	(Notice, "info", "information"),
	// Authentication.
	(Secret, "lock-keyhole", "secret value"),
	(SignIn, "log-in", "sign in"),
	(SignOut, "log-out", "sign out"),
	// Appearance and numeric controls.
	(Light, "sun", "light appearance"),
	(Dark, "moon", "dark appearance"),
	(TextSize, "type", "text size"),
	(TextUp, "a-arrow-up", "increase text size"),
	(TextDown, "a-arrow-down", "decrease text size"),
	(Less, "minus", "decrease"),
	(MoreValue, "plus", "increase"),
];

/// The three icon sizes, named where drawing code reaches them.
///
/// One definition, in [`crate::theme::icon`]; these delegate because a file
/// that draws an icon already has `icon` bound to this module, so it cannot
/// also import the token module of the same name.
pub mod scale {
	pub fn small() -> f32 {
		crate::theme::icon::small()
	}

	pub fn base() -> f32 {
		crate::theme::icon::normal()
	}

	pub fn large() -> f32 {
		crate::theme::icon::large()
	}
}

pub fn at(icon: Icon, size: f32, color: Hsla) -> Svg {
	svg()
		.size(px(size))
		.flex_none()
		.text_color(color)
		.data(icon.bytes())
}

pub fn base(icon: Icon, color: Hsla) -> Svg {
	at(icon, scale::base(), color)
}

pub fn turning(icon: Icon, size: f32, color: Hsla, turns: f32) -> Svg {
	at(icon, size, color).with_transformation(gpui::Transformation::rotate(gpui::radians(
		turns * std::f32::consts::TAU,
	)))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn every_icon_is_a_readable_optically_consistent_svg_with_a_tooltip_phrase() {
		for icon in Icon::ALL {
			let text = std::str::from_utf8(icon.bytes()).expect("an svg is utf-8");
			assert!(text.starts_with("<svg"), "{icon:?}");
			assert!(text.contains("viewBox=\"0 0 24 24\""), "{icon:?}");
			assert!(text.contains("stroke-width=\"2\""), "{icon:?}");
			assert!(!icon.meaning().is_empty(), "{icon:?}");
		}
	}

	#[test]
	fn a_drawing_is_shared_only_where_one_shape_carries_two_meanings() {
		// Two variants on one drawing is a copy-paste that kept the last file,
		// except where the shape genuinely is the same: a stepper's increase is
		// the plus a create action draws, and an edited-file marker is the
		// pencil a rename draws. The set is pinned by equality, so a new share
		// is red until it is a decision, and the alternative — a second drawing
		// for the same shape — is what makes two controls look different for no
		// reason.
		let mut shared: Vec<&'static str> = Vec::new();
		for (index, icon) in Icon::ALL.iter().enumerate() {
			let file = icon.file();
			if Icon::ALL[..index].iter().any(|other| other.file() == file) && !shared.contains(&file) {
				shared.push(file);
			}
		}
		shared.sort_unstable();
		assert_eq!(shared, vec!["pencil", "plus"]);
	}

	#[test]
	fn no_two_variants_mean_the_same_thing() {
		// A meaning is the tooltip an icon-only control shows, so two variants
		// with one meaning are one variant: the drawing they share is then a
		// duplicate rather than a shape with two uses.
		for (index, icon) in Icon::ALL.iter().enumerate() {
			assert!(
				!Icon::ALL[..index]
					.iter()
					.any(|other| other.meaning() == icon.meaning()),
				"duplicate meaning: {}",
				icon.meaning()
			);
		}
	}
}
