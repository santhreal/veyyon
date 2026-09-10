//! Control capability gate availability, error states, and rendering helpers
//! (§4.3, §4.4).
//!
//! Every interactive control across all surfaces resolves its visual
//! presentation and activation enablement through `ControlStates`, which maps
//! `SurfaceId` to `Availability` and optional `ControlError`.
//!
//! A control never decides its own availability. It queries
//! `state.controls.availability(&id)` and applies `availability_style` to set
//! opacity, cursor, and activation handling.

use std::{
	cell::RefCell,
	collections::{BTreeMap, BTreeSet},
};

use serde::{Deserialize, Serialize};
use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, RadiusStep, SpacingStep, StrokeStep, TextRamp,
	TokenSet,
};
use veyyon_desktop_model::{Gate, SurfaceId};
use veyyon_gpui::{
	AnyElement, CursorStyle, ElementId, InteractiveElement, IntoElement, ParentElement, Styled,
	WeakEntity, div,
};

use crate::{Intent, ShellView};

/// How many lines of the host's sentence a refusal row draws before it ends
/// in an ellipsis.
///
/// Two lines of the micro ramp hold about a hundred and sixty characters on
/// the narrowest surface a refusal is drawn on, which is every sentence the
/// host writes without the value it quotes back. The bound is what keeps the
/// row from growing over the rows it is about, and what keeps its own `Retry`
/// and `Dismiss` on the surface.
const MESSAGE_LINES: usize = 2;

/// Tri-state capability gate availability for a visual surface control (§4.3).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Availability {
	/// Control is available for interaction at rest.
	#[default]
	Enabled,
	/// In-flight request pending. Rendered in place at 0.6 opacity with
	/// activation suppressed.
	Pending,
	/// Control is disabled due to missing capabilities or invalid state.
	Unavailable {
		/// Human-readable reason why the control cannot be used.
		reason: String,
	},
	/// Connectivity not yet established. Rendered at rest; activation attaches
	/// then acts.
	Unknown,
}

impl Availability {
	/// The host's reason while the control is unavailable, which is readable
	/// at the control (§4.3).
	#[must_use]
	pub fn reason(&self) -> Option<&str> {
		match self {
			Self::Unavailable { reason } => Some(reason),
			Self::Enabled | Self::Pending | Self::Unknown => None,
		}
	}

	/// Whether a surface this availability enables as a whole is drawn at
	/// all: one absent for want of a capability is not rendered, never
	/// rendered disabled (§5.13). Pending and unknown surfaces are drawn.
	#[must_use]
	pub const fn is_drawn(&self) -> bool {
		!matches!(self, Self::Unavailable { .. })
	}
}

impl From<&Gate> for Availability {
	fn from(gate: &Gate) -> Self {
		match gate {
			Gate::Enabled => Self::Enabled,
			Gate::Pending { .. } => Self::Pending,
			Gate::Unavailable { reason } => Self::Unavailable { reason: reason.clone() },
			Gate::Unknown => Self::Unknown,
		}
	}
}

impl From<Gate> for Availability {
	fn from(gate: Gate) -> Self {
		Self::from(&gate)
	}
}

/// Structured error state attached to a specific interactive control (§4.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlError {
	/// Error description explaining the failure to the operator.
	pub message:   String,
	/// Whether re-activating the control can retry the failed operation.
	pub retryable: bool,
}

impl ControlError {
	/// Creates a new control error.
	#[must_use]
	pub fn new(message: impl Into<String>, retryable: bool) -> Self {
		Self { message: message.into(), retryable }
	}
}

/// Container tracking availability and error states for all interactive surface
/// controls (§4.3, §4.4).
///
/// A control the projection never set reads as at rest, which is the one
/// silent default in the gate path (§1.2). Every such read is recorded so a
/// test that renders every scene can assert the set is empty: a control that
/// reads an id `project_controls` does not own turns that test red.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ControlStates {
	availability: BTreeMap<SurfaceId, Availability>,
	errors:       BTreeMap<SurfaceId, ControlError>,
	unprojected:  RefCell<BTreeSet<SurfaceId>>,
}

impl ControlStates {
	/// Creates an empty control state registry.
	#[must_use]
	pub const fn new() -> Self {
		Self {
			availability: BTreeMap::new(),
			errors:       BTreeMap::new(),
			unprojected:  RefCell::new(BTreeSet::new()),
		}
	}

	/// Returns the availability state for a given control identifier.
	///
	/// An id no projection set reads as `Enabled` and is recorded in
	/// [`Self::unprojected`].
	#[must_use]
	pub fn availability(&self, id: &SurfaceId) -> Availability {
		self.availability.get(id).cloned().unwrap_or_else(|| {
			self.unprojected.borrow_mut().insert(id.clone());
			Availability::Enabled
		})
	}

	/// Every id a surface read that no projection had set, in the order the
	/// ids sort. Empty when every control drawn is one the projection owns.
	#[must_use]
	pub fn unprojected(&self) -> Vec<SurfaceId> {
		self.unprojected.borrow().iter().cloned().collect()
	}

	/// Every control the projection set, with what it was told, in the order
	/// the ids sort. A test sweeps this rather than a list of ids it wrote
	/// down, so a control added to the projection is covered by what it is.
	pub fn projected(&self) -> impl Iterator<Item = (&SurfaceId, &Availability)> {
		self.availability.iter()
	}

	/// Returns the active error associated with a given control identifier, if
	/// any.
	#[must_use]
	pub fn error(&self, id: &SurfaceId) -> Option<&ControlError> {
		self.errors.get(id)
	}

	/// Every control carrying a failure, with what the host said, in the
	/// order the ids sort.
	///
	/// A surface that states the refusals of a whole region -- the drawer
	/// asks for any of its own controls -- reads this rather than naming each
	/// control it could have pressed, so a control added there is stated by
	/// what it is (§4.4).
	pub fn failures(&self) -> impl Iterator<Item = (&SurfaceId, &ControlError)> {
		self.errors.iter()
	}

	/// Drops every availability the last projection set.
	///
	/// The projection is the only writer and it runs before the frame that
	/// reads it, so a value it no longer states is gone rather than left
	/// behind: a row that stopped being the active one, and a session the
	/// host stopped listing, both take their gates with them (§4.3).
	pub fn clear_availability(&mut self) {
		self.availability.clear();
	}

	/// Sets the capability gate availability for a control.
	pub fn set_availability(&mut self, id: SurfaceId, av: Availability) {
		self.availability.insert(id, av);
	}

	/// Sets an error for a control.
	pub fn set_error(&mut self, id: SurfaceId, error: ControlError) {
		self.errors.insert(id, error);
	}

	/// Clears any error associated with a control.
	pub fn clear_error(&mut self, id: &SurfaceId) -> Option<ControlError> {
		self.errors.remove(id)
	}

	/// Clears all active control errors across the shell.
	pub fn clear_all_errors(&mut self) {
		self.errors.clear();
	}

	/// Returns true if no availability overrides or errors are tracked.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.availability.is_empty() && self.errors.is_empty()
	}

	/// Returns the count of tracked control availabilities.
	#[must_use]
	pub fn len(&self) -> usize {
		self.availability.len()
	}
}

/// Resolves visual presentation parameters (opacity, cursor,
/// `activation_allowed`) from availability (§4.3).
#[must_use]
pub const fn availability_style(av: &Availability, _tokens: &TokenSet) -> (f32, CursorStyle, bool) {
	match av {
		Availability::Enabled => (1.0, CursorStyle::PointingHand, true),
		Availability::Pending => (0.6, CursorStyle::OperationNotAllowed, false),
		Availability::Unavailable { .. } => (0.4, CursorStyle::OperationNotAllowed, false),
		Availability::Unknown => (1.0, CursorStyle::PointingHand, true),
	}
}

/// Renders an error hairline decoration and retry action directly below a
/// failed control (§4.4).
pub fn error_hairline(
	err: &ControlError,
	id: SurfaceId,
	tokens: &TokenSet,
	cx: &veyyon_gpui::Context<ShellView>,
) -> impl IntoElement {
	error_hairline_weak(err, id, tokens, Some(cx.weak_entity()))
}

/// Renders an error hairline decoration using a weak view reference.
pub fn error_hairline_weak(
	err: &ControlError,
	id: SurfaceId,
	tokens: &TokenSet,
	weak: Option<WeakEntity<ShellView>>,
) -> impl IntoElement {
	let stroke_px = tokens.stroke(StrokeStep::Hairline);
	let error_color = tokens.color(ColorRole::ErrorInk);
	let error_ground = tokens.color(ColorRole::ErrorFill);
	let text_color = tokens.color(ColorRole::ErrorInk);
	let pad_h = tokens.spacing(SpacingStep::S2);
	let pad_v = tokens.spacing(SpacingStep::S1);
	let radius = tokens.radius(RadiusStep::Sm);
	let font_size = tokens.font_size(TextRamp::Micro);
	let line_height = tokens.line_height(TextRamp::Micro);

	let mut row = div()
		.id(ElementId::Name(format!("error-hairline-{id:?}").into()))
		.flex()
		.flex_row()
		.w_full()
		.items_center()
		.justify_between()
		.px(pad_h)
		.py(pad_v)
		.rounded(radius)
		.bg(error_ground)
		.border(stroke_px)
		.border_color(error_color)
		.gap(tokens.spacing(SpacingStep::S2));

	// The host writes the sentence and can write a long one: a value it
	// rejected is quoted back in full, and a path or a tool's own output
	// arrives whole. Unbounded, it took the row's width from its own
	// controls -- a 300-character refusal drew `Retry` and `Dismiss` a
	// thousand pixels outside the window, so the operator could neither send
	// the request again nor put the refusal away. The message takes what the
	// row has left over and ends in an ellipsis; the controls keep their
	// width whatever it says.
	let label = div()
		.flex_1()
		.min_w_0()
		.text_size(font_size)
		.line_height(line_height)
		.text_color(text_color)
		.text_ellipsis()
		.line_clamp(MESSAGE_LINES)
		.child(err.message.clone());

	row = row.child(label);

	if err.retryable {
		let retry_id = id.clone();
		let weak_retry = weak.clone();
		let mut retry_btn = Button::new("retry", "Retry")
			.variant(ButtonVariant::Danger)
			.size(ButtonSize::Small);
		if let Some(weak) = weak_retry {
			retry_btn = retry_btn.on_click(move |_event, _window, app| {
				let _ = weak.update(app, |view, cx| {
					view.dispatch(Intent::RetryControl(retry_id.clone()), cx);
				});
			});
		}
		row = row.child(div().flex_shrink_0().child(retry_btn));
	}

	let dismiss_id = id;
	let weak_dismiss = weak;
	let mut dismiss_btn = Button::new("dismiss", "Dismiss")
		.variant(ButtonVariant::Ghost)
		.size(ButtonSize::Small);
	if let Some(weak) = weak_dismiss {
		dismiss_btn = dismiss_btn.on_click(move |_event, _window, app| {
			let _ = weak.update(app, |view, cx| {
				view.dispatch(Intent::DismissError(dismiss_id.clone()), cx);
			});
		});
	}
	row = row.child(div().flex_shrink_0().child(dismiss_btn));

	row
}

/// The failure that landed on a control, as the hairline drawn under it, or
/// nothing while it has none (§4.4).
#[must_use]
pub fn hairline_for(
	controls: &ControlStates,
	id: &SurfaceId,
	tokens: &TokenSet,
	cx: &veyyon_gpui::Context<ShellView>,
) -> Option<AnyElement> {
	hairline_for_weak(controls, id, tokens, Some(cx.weak_entity()))
}

/// The failure that landed on a control using a weak view reference.
#[must_use]
pub fn hairline_for_weak(
	controls: &ControlStates,
	id: &SurfaceId,
	tokens: &TokenSet,
	weak: Option<WeakEntity<ShellView>>,
) -> Option<AnyElement> {
	controls
		.error(id)
		.map(|err| error_hairline_weak(err, id.clone(), tokens, weak).into_any_element())
}
