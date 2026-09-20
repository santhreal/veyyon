//! What a surface with nothing on it draws: the condition it is in, the step
//! out of it, and the element that draws the pair (§5.6, §5.9, §5.11).
//!
//! One definition per surface, in one match over `EmptySurface`, so a surface
//! added to the enum does not compile until it states what an operator is
//! looking at and what to do about it. A view reads its pair from here rather
//! than holding the sentences beside its rows, which is how one of them came to
//! predict what would appear instead of stating a step, and another to restate
//! its own condition where the step belongs.
//!
//! The settings sheet keeps its own table, `settings::empty`, because a page
//! there is one of a closed set the sheet sweeps by itself. Both tables are
//! judged against one vocabulary, `tests/support/empty_prose.rs`.

use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, SpacingStep, TextRamp, TextWeight, TokenSet,
};
use veyyon_gpui::{
	ClickEvent, Context, Div, InteractiveElement, IntoElement, ParentElement, Stateful, Styled, div,
};

use crate::{Intent, Overlay, PaletteMode, PaletteState, ShellView, navigation::SurfaceRoute};

/// The two sentences an empty surface draws: what is missing, and the step that
/// puts something there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmptyCopy {
	/// What the surface has nothing of.
	pub condition: &'static str,
	/// The step that fills it, naming where it is taken.
	pub action:    &'static str,
}

/// Every empty state drawn outside the settings sheet.
///
/// The diff and tree tenants draw one per load status, because what to do about
/// an empty pane depends on why it is empty: a pane nobody asked for takes a
/// different step from one a failed read left behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, strum::EnumIter)]
pub enum EmptySurface {
	/// No diff was requested.
	DiffUnloaded,
	/// A diff is being read.
	DiffLoading,
	/// The working tree reported no modification.
	DiffClean,
	/// The diff could not be read.
	DiffFailed,
	/// No file is open in the File tenant.
	FileNone,
	/// The open file is not text.
	FileBinary,
	/// No directory tree was requested.
	TreeUnloaded,
	/// A directory tree is being walked.
	TreeLoading,
	/// The workspace holds no entry.
	TreeEmpty,
	/// The directory tree could not be read.
	TreeFailed,
	/// The host reported no accounting for the session.
	Usage,
	/// The host reports none of the panel's tenants. A host that stated a
	/// reason has that drawn as the condition instead of the one here.
	PanelUnavailable,
	/// No process is under supervision.
	ProcessList,
	/// The model picker opened with no model to pick.
	PaletteNoModels,
	/// A palette query matched no row.
	PaletteNoMatch,
	/// The session carries no local review thread.
	ReviewThreads,
	/// A rail filter matched no session.
	QueueFiltered,
	/// The host reported no session at all.
	QueueEmpty,
	/// The window holds no session and model providers are configured.
	Welcome,
	/// The window holds no session and no model provider is configured.
	WelcomeNoProvider,
}

impl EmptySurface {
	/// The region the empty state is recorded under, which is the tenant rather
	/// than the status: one pane draws one empty state at a time.
	#[must_use]
	pub const fn id(self) -> &'static str {
		match self {
			Self::DiffUnloaded | Self::DiffLoading | Self::DiffClean | Self::DiffFailed => {
				"right-panel-diff-empty"
			},
			Self::FileNone => "right-panel-file-empty",
			Self::FileBinary => "right-panel-file-binary",
			Self::TreeUnloaded | Self::TreeLoading | Self::TreeEmpty | Self::TreeFailed => {
				"right-panel-tree-empty"
			},
			Self::Usage => "right-panel-usage-empty",
			Self::PanelUnavailable => "right-panel-unavailable",
			Self::ProcessList => "process-list-empty",
			Self::PaletteNoModels | Self::PaletteNoMatch => "palette-empty",
			Self::ReviewThreads => "review-threads-empty",
			Self::QueueFiltered => "queue-empty-after-filter",
			Self::QueueEmpty => "queue-truly-empty",
			Self::Welcome => "welcome-empty",
			Self::WelcomeNoProvider => "welcome-no-provider",
		}
	}

	/// The condition the surface is in and the step out of it.
	///
	/// `DiffLoading` and `TreeLoading` state what is underway instead of a
	/// step, because a read in flight is not something to act on;
	/// `a-surface-with-nothing-on-it-states-the-condition-and-the-step.rs`
	/// holds that pair of exceptions by exact equality.
	#[must_use]
	pub const fn copy(self) -> EmptyCopy {
		match self {
			Self::DiffUnloaded => EmptyCopy {
				condition: "Changes not requested yet",
				action:    "Select working tree or staged above to inspect diffs",
			},
			Self::DiffLoading => EmptyCopy {
				condition: "Loading changes...",
				action:    "Inspecting working tree and index",
			},
			Self::DiffClean => EmptyCopy {
				condition: "Working tree is clean",
				action:    "Edit a file, or select staged above to inspect the index",
			},
			Self::DiffFailed => EmptyCopy {
				condition: "Unable to load repository changes",
				action:    "Check git repository status or retry from the command palette",
			},
			Self::FileNone => EmptyCopy {
				condition: "No file open",
				action:    "Select a file from the Tree tab or an artifact link to inspect contents",
			},
			Self::FileBinary => EmptyCopy {
				condition: "Binary file cannot be displayed",
				action:    "Select a UTF-8 text file from the Tree tab",
			},
			Self::TreeUnloaded => EmptyCopy {
				condition: "Directory tree not loaded",
				action:    "Open a workspace folder to view its directory structure",
			},
			Self::TreeLoading => EmptyCopy {
				condition: "Scanning workspace...",
				action:    "Building directory hierarchy",
			},
			Self::TreeEmpty => EmptyCopy {
				condition: "Workspace is empty",
				action:    "Create a file here, or open another workspace folder",
			},
			Self::TreeFailed => EmptyCopy {
				condition: "Unable to read directory tree",
				action:    "Check workspace directory access permissions",
			},
			Self::Usage => EmptyCopy {
				condition: "No accounting reported yet",
				action:    "Send a prompt in the composer to start this session's accounting",
			},
			Self::PanelUnavailable => EmptyCopy {
				condition: "This panel is unavailable",
				action:    "Attach a host that reports one of Changes, File, Tree or Usage",
			},
			Self::ProcessList => EmptyCopy {
				condition: "No supervised processes running",
				action:    "Start a process using the launch tool or run a command in the terminal",
			},
			Self::PaletteNoModels => EmptyCopy {
				condition: "No models available",
				action:    "Sign in to a provider under Settings ▸ Providers",
			},
			Self::PaletteNoMatch => EmptyCopy {
				condition: "No matching items",
				action:    "Clear or edit the search query",
			},
			Self::ReviewThreads => EmptyCopy {
				condition: "No local review threads",
				action:    "Click a line in the diff view to start a review thread",
			},
			Self::QueueFiltered => EmptyCopy {
				condition: "No matching sessions",
				action:    "Clear the filter to show every session",
			},
			Self::QueueEmpty => {
				EmptyCopy { condition: "No sessions yet", action: "Select New Session to start one" }
			},
			Self::Welcome => EmptyCopy {
				condition: "No active session",
				action:    "Open a session, resume one, or set the model",
			},
			Self::WelcomeNoProvider => EmptyCopy {
				condition: "No model provider configured",
				action:    "Select Account to sign in to one",
			},
		}
	}
}

/// Renders a quiet, centred empty state with a primary line and secondary
/// action beneath it, without boxes or illustrations.
///
/// The element is returned rather than an opaque one so a surface that offers
/// its step as a button as well -- the rail does -- adds it as a third child at
/// the same gap, instead of laying the pair out again beside it.
#[must_use]
pub(crate) fn empty_state(
	id: &'static str,
	primary: &str,
	action: &str,
	tokens: &TokenSet,
) -> Stateful<Div> {
	div()
		.id(id)
		.flex_1()
		.w_full()
		.flex()
		.flex_col()
		.items_center()
		.justify_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.px(tokens.spacing(SpacingStep::S4))
		.py(tokens.spacing(SpacingStep::S6))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(primary.to_string()),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.text_center()
				.child(action.to_string()),
		)
}

/// Draws `surface`'s empty state.
#[must_use]
pub fn empty_surface(surface: EmptySurface, tokens: &TokenSet) -> impl IntoElement {
	let EmptyCopy { condition, action } = surface.copy();
	empty_state(surface.id(), condition, action, tokens)
}

/// Draws the panel with none of its tenants reported, stating `reason` as the
/// condition and the step `EmptySurface::PanelUnavailable` defines.
#[must_use]
pub fn empty_unavailable(reason: &str, tokens: &TokenSet) -> impl IntoElement {
	let surface = EmptySurface::PanelUnavailable;
	empty_state(surface.id(), reason, surface.copy().action, tokens)
}

/// Draws the welcome surface a window holding no session shows.
///
/// With a provider configured it draws the three controls that reach work:
/// open a session, resume one, set the model. With none configured it states
/// that condition first and draws the control that opens the account surface,
/// because the other three reach nothing until a provider answers.
///
/// The condition decides the variant here rather than at the call site, so
/// the two welcome surfaces cannot be drawn under each other's copy.
#[must_use]
pub fn welcome_surface(
	providers_configured: bool,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let surface = if providers_configured {
		EmptySurface::Welcome
	} else {
		EmptySurface::WelcomeNoProvider
	};
	let EmptyCopy { condition, action } = surface.copy();
	let state = empty_state(surface.id(), condition, action, tokens);
	if !providers_configured {
		return state.child(
			Button::new("welcome-account-btn", "Account")
				.variant(ButtonVariant::Primary)
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
					view.dispatch(Intent::Navigate(SurfaceRoute::Account), cx);
				})),
		);
	}
	state.child(
		div()
			.flex()
			.flex_row()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S2))
			.child(
				Button::new("welcome-open-session-btn", "Open session")
					.variant(ButtonVariant::Primary)
					.size(ButtonSize::Small)
					.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
						view.dispatch(Intent::NewSession, cx);
					})),
			)
			.child(
				Button::new("welcome-resume-session-btn", "Resume session")
					.variant(ButtonVariant::Default)
					.size(ButtonSize::Small)
					.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
						view.dispatch(Intent::FindSessions(String::new()), cx);
					})),
			)
			.child(
				Button::new("welcome-set-model-btn", "Set model")
					.variant(ButtonVariant::Default)
					.size(ButtonSize::Small)
					.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
						let palette = view.state().composer.model.as_ref().map_or_else(
							|| PaletteState::new(PaletteMode::Models),
							|model| PaletteState::from_models(model, true),
						);
						view.dispatch(Intent::OpenOverlay(Box::new(Overlay::Palette(palette))), cx);
					})),
			),
	)
}
