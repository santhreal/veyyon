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
	ClickEvent, CursorStyle, ElementId, InteractiveElement, IntoElement, ParentElement, Styled, div,
};

use crate::{Intent, ShellView};

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

	/// Returns the active error associated with a given control identifier, if
	/// any.
	#[must_use]
	pub fn error(&self, id: &SurfaceId) -> Option<&ControlError> {
		self.errors.get(id)
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
		.items_center()
		.justify_between()
		.px(pad_h)
		.py(pad_v)
		.rounded(radius)
		.bg(error_ground)
		.border(stroke_px)
		.border_color(error_color)
		.gap(tokens.spacing(SpacingStep::S2));

	let label = div()
		.text_size(font_size)
		.line_height(line_height)
		.text_color(text_color)
		.child(err.message.clone());

	row = row.child(label);

	if err.retryable {
		let retry_id = id.clone();
		let retry_btn = Button::new("Retry")
			.variant(ButtonVariant::Danger)
			.size(ButtonSize::Small)
			.on_click(cx.listener(move |view, _event: &ClickEvent, _window, _cx| {
				view.dispatch(Intent::RetryControl(retry_id.clone()));
			}));
		row = row.child(retry_btn);
	}

	let dismiss_id = id;
	let dismiss_btn = Button::new("Dismiss")
		.variant(ButtonVariant::Ghost)
		.size(ButtonSize::Small)
		.on_click(cx.listener(move |view, _event: &ClickEvent, _window, _cx| {
			view.dispatch(Intent::DismissError(dismiss_id.clone()));
		}));
	row = row.child(dismiss_btn);

	row
}
