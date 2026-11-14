# Frontend layout audit

Reviewed 2026-11-14 against `667d2c8a` following the first paper-and-ink rework. All findings below are **open**. This change documents the problems; it does not fix the interface.

The redesign changed the palette, type and imagery, but left substantial problems in space allocation, responsive behavior, form readability and action placement. The earlier statement that the design passed validation was too broad. Functional smoke tests passed; those results did not establish visual quality or usable layouts.

## Evidence and scope

The review uses the actual app and disposable controller/Pi demo fixture, with scripted model replies. No production installation or provider credentials are involved. Screenshots use Chromium at 100% zoom, device scale 1 and reduced motion. Width and height are CSS pixels.

Captured 23 screenshots covering login, primary setup, a populated conversation, pending permission review, Gatekeeper advice and a delegated thread. Sizes include 1440×900, 1024×768, adjacent breakpoint widths 991/990 and 681/680, 768×768, 390×667 and 320×568. Permission screenshots explicitly open the inspector on phones. Ordinary workspace screenshots preserve the app's automatic inspector collapse when crossing 990px.

- [Measurements](frontend-layout-audit/measurements.json) record bounding boxes, actual font sizes, control dimensions and selected-option text widths.
- [Capture script](../../apps/gateway/test/capture-layout-review.ts) reproduces the evidence with `bun apps/gateway/test/capture-layout-review.ts`. Set `CHROMIUM_PATH` if Chromium is not detected automatically.
- Screenshots are viewport captures, not full-page captures, so content outside the visible area stays evident.

P1 means a primary reading or decision task is materially impaired. P2 means a recurring usability or responsive-layout defect. P3 means visual quality or maintainability. These priorities do not imply a permission bypass or data-loss defect.

## Findings

| ID | Priority | Problem | Evidence |
| --- | --- | --- | --- |
| L01 | P1 | Setup truncates the selected permission choices | [Desktop setup](frontend-layout-audit/setup-1024x768.png), [small phone](frontend-layout-audit/setup-320x568.png) |
| L02 | P1 | Setup actions disappear below the visible dialog on short phones | [390×667](frontend-layout-audit/setup-390x667.png), [320×568](frontend-layout-audit/setup-320x568.png) |
| L03 | P1 | Permission decisions are buried below low-priority material | [390×667](frontend-layout-audit/approval-390x667.png), [320×568](frontend-layout-audit/approval-320x568.png) |
| L04 | P1 | Persistent chrome leaves too little room to read work on phones | [Conversation](frontend-layout-audit/workspace-desktop-320x568.png), [delegated thread](frontend-layout-audit/workspace-mobile-320x568.png) |
| L05 | P2 | One-pixel breakpoint changes produce large layout jumps | [991px](frontend-layout-audit/workspace-desktop-991x768.png), [990px](frontend-layout-audit/workspace-desktop-990x768.png), [681px](frontend-layout-audit/workspace-desktop-681x768.png), [680px](frontend-layout-audit/workspace-desktop-680x768.png) |
| L06 | P2 | Short thread titles lose their identity in the phone header | [320px conversation](frontend-layout-audit/workspace-desktop-320x568.png), [320px child thread](frontend-layout-audit/workspace-mobile-320x568.png) |
| L07 | P2 | Five inspector tabs consume two rows and leave an empty cell | [Desktop](frontend-layout-audit/workspace-desktop-1440x900.png), [phone](frontend-layout-audit/approval-390x667.png) |
| L08 | P2 | “Latest messages” overlaps the composer | [320×568](frontend-layout-audit/workspace-mobile-320x568.png), [390×667](frontend-layout-audit/workspace-mobile-390x667.png) |
| L09 | P2 | Secondary controls have inconsistent and very small hit areas | [Desktop](frontend-layout-audit/workspace-desktop-1440x900.png), [measurements](frontend-layout-audit/measurements.json) |
| L10 | P2 | Supporting text is too small relative to oversized headings and spacing | [Desktop](frontend-layout-audit/workspace-desktop-1440x900.png), [Gatekeeper](frontend-layout-audit/gatekeeper-1440x900.png) |
| L11 | P2 | The login page overflows vertically and clips its footer at common heights | [390×667](frontend-layout-audit/welcome-390x667.png), [768×768](frontend-layout-audit/welcome-768x768.png) |
| L12 | P2 | Permission payloads are presented as cramped raw JSON | [1024×768](frontend-layout-audit/approval-1024x768.png), [390×667](frontend-layout-audit/approval-390x667.png) |
| L13 | P3 | The aesthetic treatment has not produced a coherent working interface | [Desktop](frontend-layout-audit/workspace-desktop-1440x900.png), [tablet login](frontend-layout-audit/welcome-768x768.png) |
| L14 | P2 | The existing design checks miss these defects while reporting a pass | [Audit source](../../apps/gateway/test/design-audit.ts) |

### L01. Permission choices are clipped

Reproduce: open primary setup, advance to guardrails, and inspect the closed selects before continuing. This happens in the standard 560px desktop dialog as well as at 320px.

The two-column desktop row gives the command and delegation selects 243px each internally. The selected delegation text measures about 220px before 24px of padding and the native arrow are accounted for. The screenshot cuts off “Ask before delegation actions.” At 320px, the mode select has 238px for text that measures about 267px before padding. Several selected choices are cut off simultaneously.

The user cannot read the full selected permission policy without opening the control. This is especially inappropriate for a guardrail review step. Relevant source: `.form-row`, `.inline-rule` and select sizing in [style.css](../../apps/gateway/public/v2/style.css).

Acceptance: every selected permission choice is readable at rest at the reviewed sizes. Stack the fields or provide a full readable description when a native select cannot show the complete choice.

### L02. Setup has no persistent action area

Reproduce: advance to guardrails at 390×667 or 320×568 without scrolling the dialog.

At 390×667, the dialog's visible bottom is about y634, but its action row begins at y699. At 320×568, the visible bottom is y540 and the action row begins at y746. The dialog scrolls, so the actions are reachable, but neither the next step nor Cancel is visible. The header, fields, explanation and actions all share one scrolling region; there is no persistent action footer or useful indication that the decision controls are farther down.

Acceptance: the current step and primary/cancel actions stay discoverable on a short phone. Scroll the form body independently if necessary, while preserving access to every field and explanation.

### L03. Permission review hides the decision controls

Reproduce: trigger the demo `RELEASE_NOTES.md` write, open Permissions at 390×667 or 320×568, and start at the top of the inspector.

Neither screenshot shows Allow, Deny or Discuss with Gatekeeper. The first viewport is consumed by the inspector heading, two rows of tabs, request title, JSON and metadata. At 390×667 the inspector content has a 416px viewport for 1229px of content. A permanent 47px decorative footer still occupies the bottom. The actions can be reached by scrolling; the issue is their poor prominence and distance from the review context.

Acceptance: show a readable action summary and an obvious decision area. Keep the exact action available for inspection. Decision controls should not compete with decorative footer text and low-priority identifiers for the first screen.

### L04. The conversation gets the leftover space

Reproduce: open a populated ordinary or delegated thread at 320×568.

An ordinary thread has an 88px header, a roughly 98px trusted-local banner plus margins, and a 172px composer region. Only about 199px, 35% of the viewport height, remains for messages. A delegated thread adds context and leaves about 164px, 29%. In the pending-permission state the measured message region falls to about 117px. At 390×667 the ordinary message region is still only 314px.

The banner repeats on every thread while a largely empty input reserves substantial height. The retained status messages also occupy large vertical gaps. This forces excessive scrolling to read even short work. These measurements use a closed software keyboard; a real keyboard was not tested.

Acceptance: allocate space around reading the conversation. Give persistent environment information a compact presentation and let an empty composer use less height. Verify short landscape and keyboard-open states separately.

### L05. Breakpoints do not follow content needs

Reproduce: resize the same populated thread from 991px to 990px, then from 681px to 680px, keeping height at 768px.

At 991px the sidebar and inspector occupy 524px combined, leaving a 467px conversation. At 990px the inspector automatically closes and the conversation expands to 766px. At 681px a 224px sidebar leaves 457px for conversation; at 680px it disappears and conversation expands to 680px. These changes also reflow messages and change how much of the conversation is visible. At 1024px the three-column layout still gives only 500px to the main task.

The breakpoints exist, but their allocation does not protect a comfortable working width. See the workspace media rules in [style.css](../../apps/gateway/public/v2/style.css) and the 990px media-query handler in [app.js](../../apps/gateway/public/v2/app.js).

Acceptance: define a minimum useful reading width and collapse optional panes before that width is lost. Verify both sides of every breakpoint and preserve the reading position during reflow.

### L06. Header controls squeeze ordinary titles

Reproduce: open “Release garden” or “Review the release plan” at 320px.

The title's maximum width is `calc(100vw - 202px)`, only 118px at this size. Even “Release garden” becomes “Release ga…”, while status, menu, details and navigation retain their space. The child title becomes “Review th…”. This reduces orientation in a UI where the sidebar is hidden.

Acceptance: keep the current thread identifiable. Let the title use a separate row or move lower-priority controls rather than permanently giving it the leftover width.

### L07. Inspector navigation wastes vertical space

Reproduce: open the inspector at desktop or phone width.

Five tabs are placed in a three-column grid, leaving the sixth position blank. The tab group is 86px tall on desktop and 106px on phones. Combined with the 98px inspector header, navigation consumes 184–204px before any details appear. The five small labels spread across two rows make this look like an unfinished button board rather than a clear navigation hierarchy.

Acceptance: choose an explicit navigation pattern that fits five destinations and protects review space. An empty grid cell should not be an accidental part of the layout.

### L08. The latest-message control collides with the composer

Reproduce: open the delegated demo thread, move away from the latest messages, and view at 320×568 or 390×667.

At 320px, the button occupies y394–423 and the composer starts at y404. At 390px, the button occupies y493–522 and the composer starts at y503. Both overlap the input panel by 19px. The fixed bottom offset assumes a composer geometry that the new styles no longer maintain.

Acceptance: reserve an explicit position for this control above the composer, including when the input grows and the viewport changes height. It must not straddle the input border or cover message text.

### L09. Hit-area sizing is inconsistent

Measured desktop examples: Add mower is 20×20px, Refresh is 24×24px, the details toggle is 34×29px, the delivery select is about 121×23px, and the mower settings button is 20×20px. At intermediate widths, some specificity interactions increase button width to 40px while leaving heights at 20–29px. The visible “Latest messages” phone button is only 29px tall.

The previous broad 44px mobile rule does not cover every actual interactive element. Measurements include geometrically visible elements; controls behind a modal or drawer are not assumed to be clickable merely because they have bounds.

Acceptance: define component sizes once and verify the actual clickable rectangles of buttons, tabs, summary controls and inline actions. Check intermediate widths as well as the smallest phone.

### L10. Type hierarchy prioritizes decoration over working information

Desktop metadata, timestamps, navigation and several controls render at 8–11px. Examples include 10px location/role text, 10px tabs and 11px permission/profile metadata, alongside 26px inspector headings, 30px thread headings and widely separated sections. The Gatekeeper question card and follow-up actions are visually much weaker than the generic inspector heading and zero-count statistics.

The measured sizes are facts. The assessment that this hierarchy feels weak is a design judgment, not an automated accessibility verdict. No contrast-compliance claim is made in this audit.

Acceptance: establish a readable minimum size for working information and a deliberate density scale. Make action context and pending decisions stronger than decorative headings and incidental metadata.

### L11. Login does not fit the viewport cleanly

Reproduce: open login at 390×667, 768×768 or 1440×900.

Measured document heights are 695px, 769px and 930px respectively. At 390×667 the origin footer is partly cut off at the bottom of the screenshot. The tablet split keeps a 60px marketing heading in a narrow column, producing an awkward three-line heading and a wrapped two-part caption. The form is usable, but the overall composition is not sized deliberately for these heights.

Acceptance: decide explicitly when login scrolls. Keep meaningful footer content in the normal flow, and collapse or simplify the marketing panel when the split can no longer support its typography.

### L12. Raw JSON dominates permission review

Reproduce: open the pending write request in Permissions at 1024px or on a phone.

The proposed file contents appear as quoted JSON with literal `\n` escapes and repeated wrapped lines in a narrow monospaced block. On desktop, long digests wrap into multiple lines below it. On a phone the JSON consumes much of the first review viewport. The UI makes the user decode a transport representation to understand the change.

Acceptance: lead with the resource/path and a readable proposed content or diff view. Keep exact arguments and digest available in a secondary technical disclosure. This is a presentation change; exact approval semantics must remain intact.

### L13. The visual rework remains a theme over the old layout

This is an editorial assessment supported by the screenshots and stylesheet structure. The garden image is isolated inside a differently colored rectangular ground. Serif headings, tiny sans-serif controls, large empty regions, rounded cards and raw machine payloads do not form a consistent information hierarchy. The postmodern/medieval direction is concentrated in login artwork and the wordmark rather than in a coherent working-page composition.

The implementation still layers repeated rules over the existing layout: `.inspector-tabs` occurs in 10 rule blocks, `.login-art` in eight, and `.composer-wrap` and `.conversation-header h1` in seven each, including media-query rules. Multiple responsive definitions are expected, but this dispersed cascade makes component geometry hard to reason about and explains why generic sizing checks missed actual results. Counts alone do not prove a browser defect.

Acceptance: settle the workspace's information hierarchy and component geometry before further ornamental styling. Consolidate ownership of component sizes and breakpoint behavior. Review populated screens, not only login and empty states, against the intended visual direction.

### L14. The “design audit” is not a visual acceptance test

[design-audit.ts](../../apps/gateway/test/design-audit.ts) uses a height of 900px for every width. It checks document horizontal overflow, font/image loading, a login button's bounds, an empty-state button's visibility and the horizontal bounds of an Add mower dialog. It does not exercise populated conversation layouts, selected-text clipping, setup-step actions, permission decisions, the latest-message button, adjacent breakpoint widths or short screen heights.

`isVisible()` does not establish that a control is inside a scrollport or easy to find. `documentElement.scrollWidth <= innerWidth` does not catch collisions or clipping within a pane. Successful workflow tests likewise do not establish visual quality.

Acceptance: label the existing check according to its limited scope. Add checks tied to these specific defects when fixes are implemented, and retain human screenshot review for hierarchy and visual quality. A passing script must not be reported as design approval.

## Repair order

1. Make permission choices readable and setup/approval actions discoverable: L01–L03 and L12.
2. Give conversations room, correct the header and separate the latest-message control from the composer: L04, L06 and L08.
3. Rework pane collapse, inspector navigation, control sizing and login sizing: L05, L07, L09 and L11.
4. Settle typography and component ownership: L10 and L13. Update the validation language and add defect-specific checks as each repair lands: L14.

## Not established by this review

Real iOS/Android keyboard behavior, browser chrome/visual-viewport resizing, 200% zoom, screen-reader operation, long crew/thread lists, very long names, large code blocks, every error/recovery dialog and non-Chromium rendering still need review. The captures do not establish that scrolled-off actions are unreachable. Drawer keyboard focus containment also needs a dedicated interaction check; it is not claimed as a verified defect here.
