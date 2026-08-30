//! A form with an ordered set of steps and a position in it.
//!
//! First-run setup and the MCP server wizard are this shape. A wizard is a form
//! plus where the operator is, which is what lets the surface say what is
//! behind and what is ahead rather than only what is on screen.

use super::Form;

/// A stepped form.
#[derive(Debug, Clone, PartialEq)]
pub struct Wizard {
	pub title:       String,
	/// Every step, in order.
	pub steps:       Vec<WizardStep>,
	/// Index into `steps` of the step on screen.
	pub current:     usize,
	/// The fields of the step on screen.
	pub form:        Form,
	/// True when the current step can be left for the next one. A wizard that
	/// lets the operator past an incomplete step reports the refusal at the end,
	/// where it cannot be acted on.
	pub can_advance: bool,
	pub footer:      Option<String>,
}

impl Wizard {
	pub fn new(title: impl Into<String>, steps: Vec<WizardStep>, form: Form) -> Wizard {
		Wizard { title: title.into(), steps, current: 0, form, can_advance: true, footer: None }
	}

	pub fn step(&self) -> Option<&WizardStep> {
		self.steps.get(self.current)
	}

	/// Steps behind the current one, which is what a progress line counts.
	pub fn completed(&self) -> usize {
		self
			.steps
			.iter()
			.filter(|step| step.state == StepState::Done)
			.count()
	}
}

/// One step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WizardStep {
	pub name:  String,
	pub state: StepState,
}

impl WizardStep {
	pub fn new(name: impl Into<String>, state: StepState) -> WizardStep {
		WizardStep { name: name.into(), state }
	}
}

/// Where a step is relative to the operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepState {
	Done,
	Current,
	Pending,
	/// Skipped because nothing it configures is present.
	Skipped,
	/// Attempted and rejected: a key the provider refused, a port already bound.
	/// Distinct from [`StepState::Pending`], which the operator has not reached,
	/// and from [`StepState::Current`], which is still open.
	Failed,
}

impl StepState {
	/// Every state, in the order they are declared.
	///
	/// A renderer sweeps this to prove its markers are distinct. The guard
	/// against a state added here and forgotten is that every renderer matches
	/// exhaustively, so the sweep is about the states disagreeing, not about one
	/// going undrawn.
	pub const ALL: [StepState; 5] = [
		StepState::Done,
		StepState::Current,
		StepState::Pending,
		StepState::Skipped,
		StepState::Failed,
	];
}
