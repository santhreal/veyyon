//! Headless GPU rendering rasterization verification tests for desktop kit
//! (§8.25).

use std::sync::Arc;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{
	AnchorCorner, Avatar, Badge, Button, ButtonVariant, Checkbox, CheckboxState, CodeBlock, Dialog,
	DialogButtonSpec, Divider, Dot, FilePicker, Icon, IconButton, IconName, IconSize, Kbd, KeyChord,
	List, ListRow, Markdown, Menu, MenuItem, Meter, NumberInput, Palette, Popover, PrimitiveKind,
	Radio, Resizable, Row, ScrollView, SearchField, SegmentedControl, Select, Sheet, Slider, Spacer,
	Spinner, SpinnerSize, Stack, Table, TableColumn, Text, TextArea, TextField, TextRamp, Toggle,
	Tooltip, Tree, TreeRow, Truncate,
	token_set::{ColorRole, SpacingStep, TintRole, TokenSet},
};
use veyyon_gpui::{
	App, Context, HeadlessAppContext, IntoElement, ParentElement, Point, Render, Styled, Window,
	div, prelude::*, px, size,
};

#[test]
fn the_desktop_kit_primitives_render_distinct_pixels_on_headless_surface()
-> Result<(), Box<dyn std::error::Error>> {
	let text_system = Arc::new(gpui_wgpu::CosmicTextSystem::new("sans-serif"));
	let mut cx = HeadlessAppContext::with_platform(text_system, Arc::new(()), || {
		gpui_platform::current_headless_renderer()
	});

	let viewport = size(px(400.0), px(300.0));
	let scale_factor = 1.0;

	for kind in PrimitiveKind::iter() {
		let frame = cx.render_frame(viewport, scale_factor, |_window, app: &mut App| {
			app.set_global(TokenSet::default());
			app.new(|_cx| KitPrimitiveFixture { kind })
		})?;

		let bytes = frame.as_bytes();
		assert_eq!(frame.width(), 400);
		assert_eq!(frame.height(), 300);

		let mut distinct_colors = std::collections::HashSet::new();
		for pixel in bytes.as_chunks::<4>().0 {
			distinct_colors.insert((pixel[0], pixel[1], pixel[2], pixel[3]));
		}

		assert!(
			distinct_colors.len() > 1,
			"Primitive {kind:?} rendered a uniform frame with no distinct pixel colors",
		);
	}

	Ok(())
}

struct KitPrimitiveFixture {
	kind: PrimitiveKind,
}

impl Render for KitPrimitiveFixture {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);
		let bg = tokens.color(ColorRole::Canvas);
		let pad = tokens.spacing(SpacingStep::S4);

		let el = match self.kind {
			PrimitiveKind::Text => Stack::vertical(SpacingStep::S2)
				.child(Text::new("Headless Kit Primitive Verification").ramp(TextRamp::Head))
				.child(Text::new("Secondary text description").ramp(TextRamp::Body))
				.into_any_element(),
			PrimitiveKind::Truncate => div()
				.w(tokens.spacing(SpacingStep::S13))
				.child(Truncate::new("Very long branch title that truncates"))
				.into_any_element(),
			PrimitiveKind::Markdown => {
				Markdown::new("## Heading\n- Item 1\n- Item 2").into_any_element()
			},
			PrimitiveKind::CodeBlock => CodeBlock::new("fn main() {\n    println!(\"ok\");\n}")
				.language("rust")
				.into_any_element(),
			PrimitiveKind::Kbd => Kbd::chords([KeyChord::key("K").meta()]).into_any_element(),
			PrimitiveKind::Button => Button::new("Primary Action")
				.variant(ButtonVariant::Primary)
				.into_any_element(),
			PrimitiveKind::SplitButton => veyyon_desktop_kit::SplitButton::new("Execute")
				.variant(ButtonVariant::Primary)
				.into_any_element(),
			PrimitiveKind::IconButton => IconButton::new(IconName::Search).into_any_element(),
			PrimitiveKind::Toggle => Toggle::new(true).into_any_element(),
			PrimitiveKind::Checkbox => Checkbox::new(CheckboxState::Checked)
				.label("Enabled")
				.into_any_element(),
			PrimitiveKind::Radio => Radio::new(true).label("Option A").into_any_element(),
			PrimitiveKind::Select => Select::new(["Choice 1", "Choice 2"], 0).into_any_element(),
			PrimitiveKind::Slider => Slider::new(0.5, 0.0, 1.0).into_any_element(),
			PrimitiveKind::SegmentedControl => {
				SegmentedControl::new(["First", "Second"], 0).into_any_element()
			},
			PrimitiveKind::NumberInput => NumberInput::new(10)
				.range(0, 100)
				.step(1)
				.into_any_element(),
			PrimitiveKind::TextField => TextField::new("Input text")
				.placeholder("Type...")
				.into_any_element(),
			PrimitiveKind::TextArea => TextArea::new("Multi line text")
				.placeholder("Notes...")
				.into_any_element(),
			PrimitiveKind::SearchField => SearchField::new("Query")
				.placeholder("Search...")
				.into_any_element(),
			PrimitiveKind::FilePicker => FilePicker::new(None).into_any_element(),
			PrimitiveKind::Stack => Stack::vertical(SpacingStep::S2)
				.child(Text::new("A"))
				.child(Text::new("B"))
				.into_any_element(),
			PrimitiveKind::Row => Row::new(SpacingStep::S2)
				.child(Icon::new(IconName::Folder).size(IconSize::Size14))
				.child(Text::new("Folder"))
				.into_any_element(),
			PrimitiveKind::Spacer => Stack::vertical(SpacingStep::S0)
				.child(Text::new("Top"))
				.child(Spacer::new(SpacingStep::S4))
				.child(Text::new("Bottom"))
				.into_any_element(),
			PrimitiveKind::Divider => Stack::vertical(SpacingStep::S2)
				.child(Text::new("Above"))
				.child(Divider::horizontal())
				.child(Text::new("Below"))
				.into_any_element(),
			PrimitiveKind::ScrollView => {
				ScrollView::new(Text::new("Scroll Content")).into_any_element()
			},
			PrimitiveKind::Resizable => Resizable::new(
				veyyon_desktop_kit::Axis::Horizontal,
				Text::new("Left"),
				Text::new("Right"),
			)
			.into_any_element(),
			PrimitiveKind::Sheet => Sheet::bottom(Text::new("Sheet Content")).into_any_element(),
			PrimitiveKind::List => {
				List::new(3, |i, _, _| Text::new(format!("Item {i}")).into_any_element())
					.into_any_element()
			},
			PrimitiveKind::ListRow => ListRow::new("Queue Title")
				.subtitle("Detail")
				.into_any_element(),
			PrimitiveKind::Tree => {
				Tree::new(2, |i, _, _| TreeRow::new(format!("Node {i}"), i).into_any_element())
					.into_any_element()
			},
			PrimitiveKind::TreeRow => TreeRow::new("Tree Node", 0)
				.branch(true)
				.expanded(true)
				.into_any_element(),
			PrimitiveKind::Table => Table::new([TableColumn::new("Col")], 2, |r, _, _, _| {
				Text::new(format!("R{r}")).into_any_element()
			})
			.into_any_element(),
			PrimitiveKind::Popover => Popover::new(
				Point::new(tokens.spacing(SpacingStep::S2), tokens.spacing(SpacingStep::S2)),
				AnchorCorner::TopLeft,
				Text::new("Popover"),
			)
			.into_any_element(),
			PrimitiveKind::Menu => Menu::new([MenuItem::new("Menu Item")]).into_any_element(),
			PrimitiveKind::Dialog => Dialog::new("Dialog Title", Text::new("Dialog Body"))
				.action(DialogButtonSpec::new("OK", ButtonVariant::Primary))
				.into_any_element(),
			PrimitiveKind::Tooltip => {
				Tooltip::new("Tooltip text", Button::new("Button")).into_any_element()
			},
			PrimitiveKind::Palette => {
				Palette::new(SearchField::new(""), Text::new("Results")).into_any_element()
			},
			PrimitiveKind::Badge => Badge::new("Active", TintRole::Approve).into_any_element(),
			PrimitiveKind::Dot => Dot::new(TintRole::Working).into_any_element(),
			PrimitiveKind::Spinner => Spinner::new().size(SpinnerSize::Medium).into_any_element(),
			PrimitiveKind::Meter => Meter::new(0.5).into_any_element(),
			PrimitiveKind::Avatar => Avatar::new("VT").into_any_element(),
		};

		div()
			.size_full()
			.bg(bg)
			.p(pad)
			.flex()
			.items_center()
			.justify_center()
			.child(el)
	}
}
