//! Retained gpui state for every movable shell surface.
//!
//! Layout code receives references to these values. Moving a region between an
//! attached pane, a sheet, and the bottom dock therefore cannot replace its
//! caret, selection, scroll position, terminal buffer, or focus identity.

use gpui::{AppContext, Context, Entity, FocusHandle, ScrollHandle};
use veyyon_gui_features::{
	changes::{ChangesCache, DiffViewport},
	conversation::SessionShelfState,
	files::FilesHandles,
	overlays::ImageViewerHandle,
	problems::OutputRendererAdapter,
	terminal::{RendererAdapter, RetainedTerminalRenderer},
	transcript::Timeline,
};
use veyyon_gui_kit::{input::Editor, theme::layout};

use crate::shell::Shell;

pub struct Editors {
	pub composer:         Entity<Editor>,
	pub command:          Entity<Editor>,
	pub sessions:         Entity<Editor>,
	pub changes_search:   Entity<Editor>,
	pub files:            Entity<Editor>,
	pub agents:           Entity<Editor>,
	pub settings:         Entity<Editor>,
	pub models:           Entity<Editor>,
	pub providers:        Entity<Editor>,
	pub mcp:              Entity<Editor>,
	pub extensions:       Entity<Editor>,
	pub problems:         Entity<Editor>,
	pub interaction:      Entity<Editor>,
	pub interaction_note: Entity<Editor>,
	pub agent_message:    Entity<Editor>,
	pub provider_secret:  Entity<Editor>,
	pub rename_session:   Entity<Editor>,
}

pub struct Scrolls {
	pub changes_tree:    ScrollHandle,
	pub changes_view:    ScrollHandle,
	pub files_tree:      ScrollHandle,
	pub agents_tree:     ScrollHandle,
	pub agent_detail:    ScrollHandle,
	pub settings:        ScrollHandle,
	pub inspector:       ScrollHandle,
	pub bottom:          ScrollHandle,
	pub palette_results: ScrollHandle,
	pub plan_review:     ScrollHandle,
	/// One handle per dialog kind rather than one shared by every dialog: the
	/// overlay stack draws a single dialog at a time, and a shared offset would
	/// open the next dialog scrolled to where the last one was left.
	pub confirmation:    ScrollHandle,
	pub provider_auth:   ScrollHandle,
	pub approval:        ScrollHandle,
	pub question:        ScrollHandle,
}

/// The one focus handle an element tracks.
///
/// A handle nothing draws is a handle that makes the window deaf: a binding
/// dispatches from the focused element upward, and gpui falls back to the root
/// node when the focused id is not in the tree, which carries no context and no
/// listener. Parking the keyboard is therefore the frame's job, and a region
/// that wants its own handle earns it by tracking one on an element it draws.
pub struct PanelFocus {
	pub shell: FocusHandle,
}

pub struct SurfaceHandles {
	pub editors:       Editors,
	pub scrolls:       Scrolls,
	pub focus:         PanelFocus,
	pub diff:          Entity<DiffViewport>,
	pub changes:       ChangesCache,
	pub timeline:      Entity<Timeline>,
	pub session_shelf: SessionShelfState,
	pub files:         FilesHandles,
	pub image_viewer:  ImageViewerHandle,
	/// The terminal grid, retained across a move between the dock and the
	/// inspector so the surface does not remount.
	///
	/// Held by the window rather than rebuilt per frame because it is the
	/// scrollback: bytes are fed once, and a renderer rebuilt on the frame that
	/// draws it would interpret the whole stream again every frame. It holds
	/// nothing until a terminal's bytes arrive, so a window with no terminals
	/// pays for an empty map.
	pub terminal:      Option<Box<dyn RendererAdapter>>,
	/// No implementor of this trait exists yet, so the output pane draws its
	/// bytes plainly and says so.
	pub output:        Option<Box<dyn OutputRendererAdapter>>,
}

impl SurfaceHandles {
	pub fn new(cx: &mut Context<Shell>) -> Self {
		let editor = |placeholder: &'static str,
		              multiline: bool,
		              name: &'static str,
		              cx: &mut Context<Shell>| {
			cx.new(|cx| {
				Editor::new(placeholder, multiline, cx).named(name).heights(
					if multiline {
						layout::composer_min_height()
					} else {
						layout::editor_single_line()
					},
					if multiline {
						layout::composer_max_height()
					} else {
						layout::editor_single_line()
					},
				)
			})
		};
		let editors = Editors {
			composer:         editor("Send a message", true, "Composer", cx),
			command:          editor("Search commands and resources", false, "PaletteSearch", cx),
			sessions:         editor("Search sessions", false, "SessionSearch", cx),
			changes_search:   editor("Filter changes", false, "ChangesSearch", cx),
			files:            editor("Search files", false, "FileSearch", cx),
			agents:           editor("Search agents", false, "AgentSearch", cx),
			settings:         editor("Search settings", false, "SettingsSearch", cx),
			models:           editor("Filter models", false, "ModelSearch", cx),
			providers:        editor("Filter providers", false, "ProviderSearch", cx),
			mcp:              editor("Filter MCP servers", false, "McpSearch", cx),
			extensions:       editor("Filter tools", false, "ExtensionSearch", cx),
			problems:         editor("Filter problems", false, "ProblemSearch", cx),
			interaction:      editor("Type a response", true, "InteractionEditor", cx),
			interaction_note: editor("Add an optional note", true, "InteractionNoteEditor", cx),
			agent_message:    editor("Message agent", true, "AgentEditor", cx),
			provider_secret:  cx.new(|cx| {
				Editor::secure("Credential", cx)
					.heights(layout::editor_single_line(), layout::editor_single_line())
			}),
			rename_session:   editor("Session title", false, "RenameSessionEditor", cx),
		};
		let files = FilesHandles::new(editors.files.clone());
		Self {
			editors,
			files,
			session_shelf: SessionShelfState::default(),
			timeline: cx.new(Timeline::new),
			image_viewer: ImageViewerHandle::default(),
			scrolls: Scrolls {
				changes_tree:    ScrollHandle::new(),
				changes_view:    ScrollHandle::new(),
				files_tree:      ScrollHandle::new(),
				agents_tree:     ScrollHandle::new(),
				agent_detail:    ScrollHandle::new(),
				settings:        ScrollHandle::new(),
				inspector:       ScrollHandle::new(),
				bottom:          ScrollHandle::new(),
				palette_results: ScrollHandle::new(),
				plan_review:     ScrollHandle::new(),
				confirmation:    ScrollHandle::new(),
				provider_auth:   ScrollHandle::new(),
				approval:        ScrollHandle::new(),
				question:        ScrollHandle::new(),
			},
			diff: cx.new(|_| DiffViewport::new()),
			changes: ChangesCache::default(),
			focus: PanelFocus { shell: cx.focus_handle() },
			terminal: Some(Box::new(RetainedTerminalRenderer::new())),
			output: None,
		}
	}
}
