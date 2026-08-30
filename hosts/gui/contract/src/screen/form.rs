//! Grouped fields with values that can be changed.
//!
//! The settings screen, the hook editor, the advisor configuration, the plugin
//! screen and every wizard step are this shape.
//!
//! Two things a form here states that a plain label/value list cannot. A field
//! carries where its value came from, because a settings screen that shows `12`
//! without saying whether that is the default, the profile or this session is
//! unreadable. And a field carries what it depends on, because an experimental
//! feature that is off hides its dependent knobs rather than greying them out.

use crate::view::Badge;

/// A titled set of field groups.
#[derive(Debug, Clone, PartialEq)]
pub struct Form {
	pub title:  String,
	pub groups: Vec<FormGroup>,
	/// `(group, field)` index of the focused field, when one is focused.
	pub focus:  Option<(usize, usize)>,
	pub footer: Option<String>,
}

impl Form {
	pub fn new(title: impl Into<String>, groups: Vec<FormGroup>) -> Form {
		Form { title: title.into(), groups, focus: None, footer: None }
	}

	/// Which field has focus, by group and by position in that group.
	pub fn focus(mut self, group: usize, field: usize) -> Form {
		self.focus = Some((group, field));
		self
	}

	/// The focused field, or `None` when nothing is focused or the index is
	/// stale. Never index the groups directly: the indices arrive from outside.
	pub fn focused(&self) -> Option<&Field> {
		let (group, field) = self.focus?;
		self.groups.get(group)?.fields.get(field)
	}

	/// Every field, in the order the surface reads, skipping the ones a
	/// condition hides.
	pub fn visible_fields(&self) -> impl Iterator<Item = &Field> {
		self
			.groups
			.iter()
			.flat_map(|group| group.fields.iter())
			.filter(|field| !field.hidden)
	}
}

/// One heading and the fields under it.
#[derive(Debug, Clone, PartialEq)]
pub struct FormGroup {
	pub name:   String,
	pub help:   Option<String>,
	pub fields: Vec<Field>,
}

impl FormGroup {
	pub fn new(name: impl Into<String>, fields: Vec<Field>) -> FormGroup {
		FormGroup { name: name.into(), help: None, fields }
	}
}

/// One setting.
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
	/// The settings key, so a renderer can report a change without the label.
	pub key:     String,
	pub label:   String,
	pub help:    Option<String>,
	pub control: Control,
	pub origin:  FieldOrigin,
	/// True when a condition this field depends on is off. A hidden field is
	/// still in the form: the surface reports what exists, and hiding is the
	/// renderer's instruction, not a reason to omit the row from the model.
	pub hidden:  bool,
	pub badges:  Vec<Badge>,
}

impl Field {
	pub fn new(key: impl Into<String>, label: impl Into<String>, control: Control) -> Field {
		Field {
			key: key.into(),
			label: label.into(),
			help: None,
			control,
			origin: FieldOrigin::Default,
			hidden: false,
			badges: Vec::new(),
		}
	}

	pub fn help(mut self, help: impl Into<String>) -> Field {
		self.help = Some(help.into());
		self
	}

	pub fn origin(mut self, origin: FieldOrigin) -> Field {
		self.origin = origin;
		self
	}

	pub fn hidden(mut self) -> Field {
		self.hidden = true;
		self
	}
}

/// How a field's value is changed, and what it currently is.
#[derive(Debug, Clone, PartialEq)]
pub enum Control {
	Toggle {
		on: bool,
	},
	/// One of several named values.
	Choice {
		options:  Vec<String>,
		selected: usize,
	},
	Text {
		value:       String,
		placeholder: String,
		masked:      bool,
	},
	/// A number with an optional unit, and the range it is clamped to.
	Number {
		value: f64,
		unit:  Option<String>,
		min:   Option<f64>,
		max:   Option<f64>,
	},
	/// A field that runs something instead of holding a value.
	Action {
		label:       String,
		destructive: bool,
	},
	/// A value this front end cannot edit, shown as it is.
	Reading {
		value: String,
	},
}

impl Control {
	/// The current value as one line, for a collapsed row or a capture.
	///
	/// A masked value reads as a fixed number of characters rather than one per
	/// byte. The length of a key is information about the key, and a mask that
	/// grew with it would say which provider a credential belongs to.
	pub fn summary(&self) -> String {
		match self {
			Control::Toggle { on } => (if *on { "on" } else { "off" }).to_owned(),
			Control::Choice { options, selected } => options
				.get(*selected)
				.cloned()
				.unwrap_or_else(|| "unset".to_owned()),
			Control::Text { value, placeholder, masked } => {
				if *masked && !value.is_empty() {
					"·".repeat(MASK_WIDTH)
				} else if value.is_empty() {
					placeholder.clone()
				} else {
					value.clone()
				}
			},
			Control::Number { value, unit, .. } => match unit {
				None => format!("{value}"),
				Some(unit) => format!("{value} {unit}"),
			},
			Control::Action { label, .. } => label.clone(),
			Control::Reading { value } => value.clone(),
		}
	}
}

/// How many characters a masked value reads as.
const MASK_WIDTH: usize = 12;

/// Where a field's current value came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FieldOrigin {
	#[default]
	Default,
	/// A profile's settings file.
	Profile,
	/// The project's settings file.
	Project,
	/// Changed for this session only, and lost when it ends.
	Session,
	/// The environment, a command-line flag, or anything else outside the
	/// settings files.
	Environment,
}

impl FieldOrigin {
	pub fn label(self) -> &'static str {
		match self {
			FieldOrigin::Default => "default",
			FieldOrigin::Profile => "profile",
			FieldOrigin::Project => "project",
			FieldOrigin::Session => "session",
			FieldOrigin::Environment => "environment",
		}
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! `Control::summary` is what a collapsed settings row and every capture
	//! read, so its failures are silent: a masked secret echoed in a screenshot,
	//! an empty value that looks set, a choice index past its options rendering
	//! as a panic or as the wrong value. One case per variant, including the two
	//! that have to lie about the value on purpose.
	//!
	//! WHAT IT DOES NOT CATCH. Whether a renderer calls it rather than reading
	//! the control itself.

	use super::*;

	#[test]
	fn a_masked_value_never_reports_its_characters() {
		let secret = Control::Text {
			value:       "sk-live-abcdef".to_owned(),
			placeholder: "paste a key".to_owned(),
			masked:      true,
		};
		let summary = secret.summary();
		assert!(!summary.contains("sk-live"), "{summary} leaked the value");
		assert_eq!(summary, "············");
	}

	#[test]
	fn a_mask_says_nothing_about_the_length_it_hides() {
		let short = Control::Text {
			value:       "sk-1".to_owned(),
			placeholder: String::new(),
			masked:      true,
		};
		let long = Control::Text {
			value:       "sk-live-000000000000000000000000".to_owned(),
			placeholder: String::new(),
			masked:      true,
		};
		assert_eq!(short.summary(), long.summary(), "the mask leaked the length of the value");
		assert_eq!(short.summary().chars().count(), 12);
	}

	#[test]
	fn an_empty_masked_value_reads_as_its_placeholder() {
		let empty = Control::Text {
			value:       String::new(),
			placeholder: "paste a key".to_owned(),
			masked:      true,
		};
		assert_eq!(empty.summary(), "paste a key");
	}

	#[test]
	fn a_choice_index_past_its_options_reads_as_unset() {
		let stale = Control::Choice { options: vec!["low".to_owned()], selected: 4 };
		assert_eq!(stale.summary(), "unset");
	}

	#[test]
	fn every_other_control_summarizes_as_its_value() {
		assert_eq!(Control::Toggle { on: true }.summary(), "on");
		assert_eq!(Control::Toggle { on: false }.summary(), "off");
		assert_eq!(
			Control::Choice { options: vec!["low".to_owned(), "high".to_owned()], selected: 1 }
				.summary(),
			"high"
		);
		assert_eq!(
			Control::Number { value: 12.0, unit: Some("cores".to_owned()), min: None, max: None }
				.summary(),
			"12 cores"
		);
		assert_eq!(Control::Number { value: 0.5, unit: None, min: None, max: None }.summary(), "0.5");
		assert_eq!(
			Control::Action { label: "Sign out".to_owned(), destructive: true }.summary(),
			"Sign out"
		);
		assert_eq!(Control::Reading { value: "1.3.0".to_owned() }.summary(), "1.3.0");
	}

	#[test]
	fn a_hidden_field_stays_in_the_form_and_out_of_the_reading_order() {
		let form = Form::new("Settings", vec![FormGroup::new("Argot", vec![
			Field::new("argot.enabled", "Argot Shorthand", Control::Toggle { on: false }),
			Field::new("argot.models", "Models", Control::Reading { value: "every model".to_owned() })
				.hidden(),
		])]);
		assert_eq!(form.groups[0].fields.len(), 2);
		let visible: Vec<&str> = form
			.visible_fields()
			.map(|field| field.key.as_str())
			.collect();
		assert_eq!(visible, ["argot.enabled"]);
	}

	#[test]
	fn a_stale_focus_reads_as_nothing() {
		let mut form = Form::new("Settings", vec![FormGroup::new("General", vec![Field::new(
			"a",
			"A",
			Control::Toggle { on: true },
		)])]);
		form.focus = Some((0, 0));
		assert_eq!(form.focused().map(|field| field.key.as_str()), Some("a"));

		form.focus = Some((0, 7));
		assert_eq!(form.focused(), None);
		form.focus = Some((3, 0));
		assert_eq!(form.focused(), None);
	}
}
