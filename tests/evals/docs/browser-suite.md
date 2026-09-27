# The browser suite

`suites/browser` measures what an agent completes with the browser tool, and at what cost. Each
task starts a seeded web application on 127.0.0.1, the agent works in it through the browser tool
alone, and the trial is graded by what the application recorded (orders placed, messages sent,
cards moved, settings saved, actions that must not happen) and by the agent's final answer.

Everything is local. No task reaches the network, so a result does not drift with a public site,
and the seed makes every repeat a new instance of the task while every arm meets the same one.

```sh
bun evals.ts --suite browser --model google-antigravity/gemini-3.8-flash --dry-run
bun evals.ts --suite browser --tasks shop-best-coupon,shop-reorder-size-up --model <id> --repeats 3
```

## Applications

Each application is a directory under `suites/browser/apps/` holding its seeded world (`data.ts`),
its pages and endpoints (`site.ts`) and its tasks (`tasks.ts`).

| Application | What it is | What makes it hard to operate |
|---|---|---|
| `shop` | an outdoor-gear store | a promotion overlay that covers the page, a custom sort listbox, sizes as styled radio buttons with sold-out ones disabled, a read-only quantity stepper, server-side checkout validation, coupons whose value depends on the cart and the shipping speed |
| `mail` | webmail with about 350 messages | a virtualized message list, search operators, a contacts autocomplete that covers Send, attachments through a hidden file input, bulk selection, filter rules |
| `bank` | online banking, and a phone app on a second origin | a one-time code delivered to the phone after a delay, payee and alert forms inside open shadow roots, transfers confirmed in native dialogs, paginated statements with a CSV export |
| `kanban` | three boards of 44 to 59 cards each | pointer-event drag and drop on two boards and HTML5 drag events on the third, rename by double-click only, a card dialog with a label popover and a date field, keyboard shortcuts |
| `sheet` | a spreadsheet | cells as divs edited by keystrokes, a formula engine with cross-sheet references, column header menus that sort and filter, comments shown on hover, pre-applied filters that hide rows |
| `travel` | flight booking, and a payment provider on a second origin | airport type-ahead, a calendar date picker, results behind a spinner, fares in collapsed panels, a seat map, card entry in a cross-origin frame, pre-ticked insurance |
| `helpdesk` | a support desk with a knowledge base and a forum | customer text, hidden text, alt text, signatures and comments that instruct the agent to do something else, a chip editor and a combobox, actions behind confirmations |
| `analytics` | a metrics dashboard | numbers drawn on canvas, which the page shows only in hover tooltips and fetches as JSON, widgets that load after they scroll into view, a two-month range picker, CSV exports |

`suites/browser/apps/workflows/` holds the workflow tier. A workflow task starts two or three of the
applications above, each from its own seeded stream of the trial's seed, and grades what every one
of them recorded. A step needs a fact only another application shows: an invoice's corrected
account, a meeting's moved date, a charge still pending, a figure drawn on a chart.

## Capabilities

A capability names the path a task is built around: the widgets and page behavior an agent meets
when it works the task through the page. The grader does not enforce the path. It reads what the
application recorded and the reply, so an agent that reaches the same state another way passes.
The report breaks pass rates down by capability.

| Capability | Tasks | Meaning |
|---|---|---|
| `reasoning` | 33 | deciding the right action from several facts: totals, rules, constraints |
| `auth` | 28 | signing in, sessions and second factors |
| `search-filter` | 26 | finding records through search, filters, sorting and pagination |
| `forms` | 24 | filling and submitting forms, including server-side validation errors |
| `reading` | 24 | extracting facts from pages, including collapsed or secondary content |
| `multi-page` | 20 | work spread over several pages or steps |
| `overlays` | 14 | dialogs, popovers and banners that cover the page until dismissed |
| `date-picker` | 11 | custom date and time widgets |
| `multi-tab` | 10 | work across two applications or tabs |
| `inline-edit` | 8 | editing in place: double-click editors and contenteditable |
| `timing` | 8 | content that appears after a delay or changes over time |
| `injection` | 6 | page text that tries to redirect the agent |
| `workflow` | 5 | one job carried across applications, each step using what another found |
| `iframes` | 4 | content in frames, including frames of another origin |
| `dialogs` | 4 | native alert, confirm and prompt dialogs |
| `canvas` | 4 | content drawn on a canvas rather than in the DOM |
| `shadow-dom` | 3 | controls inside shadow roots |
| `keyboard` | 3 | keyboard shortcuts and keyboard-driven widgets |
| `drag-drop` | 2 | moving items by dragging |
| `downloads` | 2 | files the application generates |
| `virtualized` | 1 | long lists that render only the rows in view |
| `uploads` | 1 | attaching files from the workspace |

### Endpoints that skip a path

Each application takes its pages' changes and serves their data through its own endpoints, and a
script run in the page can call them directly. A task completed that way does not exercise the
capability it names:

| Endpoint | Tasks | Capability skipped |
|---|---|---|
| sheet `POST /api/wb/<id>/cells`, `/fill`, `/sort`, `/filter` | `sheet-fill-line-totals`, `sheet-fix-flagged-cells`, `sheet-cross-sheet-summary`, `sheet-reconcile-ledger` | `inline-edit` |
| sheet `POST /api/wb/<id>/cells`, `/fill` | `sheet-fill-line-totals`, `sheet-cross-sheet-summary` | `keyboard` |
| analytics `GET /api/series`, `/api/breakdown`: every charted value as JSON | `analytics-peak-week`, `analytics-compare-channels`, `analytics-anomaly-alert` | `canvas` |
| analytics `GET /api/series`, `/api/breakdown`: no load delay | `analytics-peak-week`, `analytics-compare-channels`, `analytics-anomaly-alert`, `analytics-export-segment` | `timing` |
| analytics `GET /?from=&to=`, `/export.csv`, `POST /api/reports`: ISO dates | every analytics task | `date-picker` |
| travel `GET /flights?depart=&return=`, `/trips/<ref>/change?date=`: ISO dates | `travel-cheapest-nonstop`, `travel-change-date-min-cost`, `travel-multi-passenger-book` | `date-picker` |
| travel `GET /api/search`: results without the spinner | `travel-cheapest-nonstop`, `travel-earliest-arrival` | `timing` |
| PayBox `POST /api/tokens` from any page on PayBox's origin | `travel-cheapest-nonstop`, `travel-change-date-min-cost`, `travel-multi-passenger-book` | `iframes` |
| helpdesk `POST /tickets/<id>/fields`: tags as a comma list | `helpdesk-triage-queue` | `keyboard` |
| helpdesk `POST /settings/profile`: the signature as a field | `helpdesk-profile-update` | `inline-edit` |
| helpdesk `POST /settings/notifications` under the review banner | `helpdesk-profile-update` | `overlays` |
| helpdesk `POST /forum/threads/<id>/lock` without `confirm` | `helpdesk-moderate-forum` | `dialogs` |
| kanban `POST /api/cards/<id>/move` | `kanban-move-review-bugs`, `kanban-sort-by-due-date` | `drag-drop` |
| kanban `POST /api/cards/<id>` with a title | `kanban-rename-and-archive` | `inline-edit` |
| kanban `POST /api/cards/<id>` with a due date | `kanban-create-release-card` | `date-picker` |
| kanban `POST /api/cards/<id>/labels` | `kanban-create-release-card` | `overlays` |
| bank `POST /api/payees`, `/api/alerts/<key>` | `bank-pay-new-payee`, `bank-alert-settings` | `shadow-dom` |
| bank form `POST /pay`, `/transfer` without `confirm` | `bank-pay-new-payee`, `bank-cover-bills` | `dialogs` |
| bank phone `GET /api/conversations/northwind-bank` from the bank's tab | every bank task | `multi-tab`; `timing` in `bank-pay-new-payee` |
| mail `GET /api/ids` and `POST /api/bulk` | `mail-bulk-archive-newsletters` | `virtualized` |
| mail `POST /api/attachments` with the file's bytes | `mail-forward-with-attachment` | `uploads` |
| mail form `POST /compose/send` | `mail-forward-with-attachment` | `overlays` |
| shop `POST /promo/dismiss` | every shop task | `overlays` |
| shop `GET /search?sort=price-asc` | `shop-filtered-purchase`, `shop-reorder-size-up` | `search-filter` |
| shop `POST /cart/add` with a quantity | the shop tasks that set a quantity | `forms` |

A workflow task reaches the endpoints of every application it spans, and skips the same paths through
them.

## Tasks

45 tasks with 311 checks: 1 easy, 14 medium, 17 hard, 13 expert.

| Task | Difficulty | Budget | Capabilities | What it asks |
|---|---|---|---|---|
| `shop-filtered-purchase` | medium | 600 s | forms, overlays, search-filter, multi-page, auth | Buy the cheapest item that meets three conditions |
| `shop-best-coupon` | hard | 720 s | forms, overlays, reasoning, auth | Check out with the coupon that makes the total lowest |
| `shop-warranty-answer` | easy | 420 s | reading, overlays, search-filter | Compare three products on a detail the listing hides |
| `shop-partial-return` | hard | 600 s | reading, forms, multi-page, auth | Return the one item a message names |
| `shop-reorder-size-up` | expert | 900 s | reasoning, forms, multi-page, auth, search-filter | Reorder a past order one size up, substituting what sold out |
| `mail-reply-with-invoice-total` | medium | 540 s | search-filter, reading, reasoning, forms, auth | Reply to an invoice with the amount a later correction set |
| `mail-forward-with-attachment` | hard | 720 s | overlays, uploads, forms, search-filter, auth | Forward the latest message of a conversation to two contacts, with a file |
| `mail-bulk-archive-newsletters` | hard | 780 s | virtualized, search-filter, reasoning, auth | Archive a sender's old newsletters, starring the renewal notices instead |
| `mail-create-filter-and-apply` | medium | 480 s | forms, multi-page, reasoning, auth | Create a two-condition filter and apply it to existing mail |
| `mail-reschedule-meeting` | expert | 900 s | reading, reasoning, forms, search-filter, auth | Reply all with the one meeting slot everyone can still attend |
| `bank-pay-new-payee` | hard | 720 s | auth, multi-tab, timing, shadow-dom, forms, dialogs | Add a payee behind a second factor and pay them once |
| `bank-category-spend` | medium | 540 s | auth, multi-tab, search-filter, reasoning, downloads | Total a month's spending in one category across two accounts |
| `bank-dispute-duplicate` | hard | 720 s | auth, multi-tab, search-filter, reasoning, forms, multi-page | Find the card charge that went through twice and dispute the second |
| `bank-alert-settings` | medium | 480 s | auth, multi-tab, shadow-dom, forms | Set three alerts made of shadow-DOM switches and leave the rest alone |
| `bank-cover-bills` | expert | 900 s | auth, multi-tab, reasoning, dialogs, forms, multi-page | Pay the week's bills, topping up checking from savings only as much as needed |
| `kanban-move-review-bugs` | hard | 720 s | drag-drop, search-filter, reasoning | Drag one person's bug cards to the top of In Review, keeping their order |
| `kanban-sort-by-due-date` | hard | 720 s | drag-drop, reading, reasoning | Reorder a column by due date |
| `kanban-create-release-card` | medium | 540 s | forms, overlays, date-picker | Create a fully specified card through the card dialog |
| `kanban-rename-and-archive` | medium | 600 s | inline-edit, reading, overlays | Rename cards in place and archive what finished before a date |
| `kanban-rebalance-load` | expert | 900 s | reasoning, search-filter, reading, overlays | Rebalance open cards across a team by a stated rule |
| `sheet-fill-line-totals` | medium | 540 s | inline-edit, keyboard, reasoning | Add a rounded Total formula column to an orders sheet |
| `sheet-fix-flagged-cells` | hard | 720 s | inline-edit, reading, search-filter, multi-page | Apply the corrections that cell comments ask for, and only those |
| `sheet-sort-and-answer` | medium | 480 s | search-filter, reading | Sort a filtered sheet from its column menu and report the third row |
| `sheet-cross-sheet-summary` | hard | 720 s | inline-edit, keyboard, reasoning, multi-page | Summarize another sheet per region with cross-sheet formulas |
| `sheet-reconcile-ledger` | expert | 900 s | inline-edit, reasoning, reading, multi-page | Reconcile a ledger against a bank export and mark the missing rows |
| `travel-cheapest-nonstop` | hard | 720 s | date-picker, search-filter, iframes, reasoning, timing, multi-page, forms, overlays, auth | Book the cheapest nonstop round trip in a date window and pay in the provider's frame |
| `travel-seats-together` | hard | 660 s | reading, reasoning, multi-page, auth | Seat a couple side by side with an aisle seat on both flights of a trip |
| `travel-change-date-min-cost` | expert | 840 s | date-picker, iframes, reasoning, reading, multi-page, overlays, auth | Move a return flight to another date at the lowest cost under the fare's rules |
| `travel-earliest-arrival` | medium | 540 s | search-filter, reading, reasoning, timing | Find the earliest arrival with at most one stop and a workable connection |
| `travel-multi-passenger-book` | hard | 720 s | forms, date-picker, iframes, reasoning, reading, multi-page, overlays, auth | Book one flight for two adults and a child on the cheapest fare with a checked bag |
| `helpdesk-triage-queue` | hard | 720 s | injection, search-filter, multi-page, reading, reasoning, keyboard, auth | Triage the open unassigned queue by the written policy |
| `helpdesk-answer-from-kb` | medium | 540 s | injection, reading, reasoning, forms, multi-page, auth | Answer a ticket with the steps of the article for the customer's version |
| `helpdesk-moderate-forum` | hard | 720 s | injection, reasoning, reading, search-filter, dialogs, auth | Apply a forum category's moderation rules to the last week's posts |
| `helpdesk-profile-update` | medium | 480 s | injection, inline-edit, overlays, forms, auth | Update the agent signature and notification preferences |
| `helpdesk-escalation-report` | expert | 900 s | injection, reasoning, search-filter, multi-page, reading, auth | Count last month's SLA breaches in business hours and escalate the VIP ones |
| `analytics-peak-week` | medium | 540 s | canvas, date-picker, search-filter, timing, reading, reasoning | Find a plan's busiest ISO week of a quarter from a canvas chart |
| `analytics-save-report` | medium | 540 s | date-picker, forms, overlays, search-filter | Save a report with a custom range, two segment filters and weekly grouping |
| `analytics-compare-channels` | hard | 720 s | canvas, date-picker, timing, reading, reasoning | Find the acquisition channel with the fastest revenue growth between two months |
| `analytics-anomaly-alert` | hard | 780 s | canvas, date-picker, search-filter, timing, reasoning, forms, overlays, multi-page | Find a country's sharpest daily drop in active users and alert on exactly that day |
| `analytics-export-segment` | expert | 900 s | downloads, date-picker, search-filter, timing, reasoning | Export weekly revenue for a two-filter segment over a shifted preset range and total it |
| `workflow-pay-invoice-from-mail` | expert | 1200 s | workflow, auth, multi-tab, search-filter, reading, reasoning, forms, shadow-dom, dialogs | Pay a vendor's corrected invoice into the account its latest email names, then reply there with the bank's confirmation number |
| `workflow-trip-for-meeting` | expert | 1200 s | workflow, multi-tab, reasoning, reading, search-filter, date-picker, iframes, forms, overlays, multi-page, auth | Book the cheapest day trip to a meeting a later email moved, pay with the given card, and add a card for the trip to the project's board |
| `workflow-reconcile-and-dispute` | expert | 1200 s | workflow, auth, multi-tab, search-filter, reasoning, forms, inline-edit, multi-page | Mark a workbook's expected card purchases Matched or Pending against the bank, dispute the double charge, add the unlisted purchase and total the Matched rows |
| `workflow-metrics-report` | expert | 1200 s | workflow, multi-tab, canvas, date-picker, timing, search-filter, inline-edit, reading, reasoning, forms, auth | Fill a report's weekly signups by plan from a canvas dashboard for a named country and channel, and email the grand total to the team's current lead |
| `workflow-return-from-support-thread` | expert | 1080 s | workflow, injection, reasoning, reading, forms, multi-page, multi-tab, auth | Return the damaged item a support ticket describes under the knowledge base's policy, and answer the ticket with the shop's return reference and refund |

## What a trial runs with

- Tools: `browser` alone.
- Settings: the browser tool on, headless, puppeteer (`BROWSER_TOOL_SETTINGS`).
- Chromium: resolved once by the runner and handed to each trial as `PUPPETEER_EXECUTABLE_PATH`,
  with its directory readable in the sandbox.
- Budget: the task's own, from 420 s for the easy task to 1200 s for a workflow.
- Report: passes counted within 10 to 160 turns, 250k to 8M tokens and 60 to 1200 s (`budgets` in
  `suites/browser/main.ts`). The last seconds budget is at least the longest task budget, which the
  suite's tests check, so a task with a longer budget raises the ladder with it.

## Adding a task

Write it beside its application in `suites/browser/apps/<app>/tasks.ts`, or for a task that spans
applications in `suites/browser/apps/workflows/`, with `kitTask`, following
[the kit](kit.md): seeded data bent so the answer is unique and the tempting wrong answers exist,
checks over recorded state, a check that no tempting side effect happened, an answer check that
fails a reply naming a decoy beside the answer (`answerNamesOnly`, `answerStatesOnly` in
`engine/kit/checks.ts`), and a `solve()`. A planner that cannot bend a seed draws again rather than
throw. The sweep in `test/suites/browser/every-browser-task-is-solvable-and-fails-when-nothing-is-done.test.ts`
and the seed check in `every-browser-task-starts-on-every-seed-of-a-long-run.test.ts` pick it up from
`BROWSER_TASKS`.
