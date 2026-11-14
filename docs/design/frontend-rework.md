# Frontend rework: the scriptorium

Software: a working agent console. The main actions are starting a durable thread, sending work, and reviewing permission requests.

## Direction

Warm paper, oxblood ink, faded blue, sage and ochre. Medieval garden prints supply a little character; modern editorial typography and clear controls keep this a practical workspace. Newsreader headings with DM Sans UI text. Avoid blackletter, scorched parchment, fantasy-game chrome, gradient blobs, pill-shaped everything and decorative statistics.

Three directions were explored with the built-in image model before implementation: The Scriptorium, Field Notes and The Guild. The Scriptorium has the best balance of warmth and readable working space. Field Notes is too botanical for a dense console. The Guild's blue is useful for secondary working states. [View the concept board](frontend-concepts.webp).

## Implementation plan

1. Record the existing desktop, mobile, approval and setup flows with the existing browser fixture.
2. Rebuild the visual system: semantic colors, local fonts, type scale, printed rules, modest radii, accessible contrast and consistent control sizes.
3. Recompose login and empty states around an original generated garden print. Use a light paper navigation, a central conversation page and a quieter details margin.
4. Rework messages, composer, badges, inspector tabs, cards and native dialogs as a component family. Adapt shadcn's button variants and semantic-token structure to the existing DOM. Keep the actual controller and durable workflow behavior.
5. Check the real flows, narrow screens, focus states, asset loading and screenshots. Refresh the reproducible documentation images.

## Sources and skill use

Fetched and read on 2026-11-14:

- [Taste](https://github.com/Leonxlnx/taste-skill/blob/main/skills/taste-skill/SKILL.md): deliberate hierarchy, a coherent system, existing-stack redesign and before/after browser evidence. Its marketing-page section/dealer requirements conflict with this authenticated console and the requested palette; use the repository's real workflow checks instead.
- [Dribbble UI skill](https://github.com/ihlamury/design-skills/blob/main/skills/dribbble/SKILL.md): spacing, focus indicators, named controls, restrained motion and inline errors. Its scraped pink/black palette does not match the brief.
- [GitHub UI skill](https://github.com/ihlamury/design-skills/blob/main/skills/github/SKILL.md): information density, explicit review actions and consistent states. Its scraped zero-height inputs and dark palette are unsuitable here.
- [pstack design exploration](https://github.com/backnotprop/pstack/blob/main/skills/principle-exhaust-the-design-space/SKILL.md): compare multiple directions before choosing.
- [pstack unslop](https://github.com/backnotprop/pstack/blob/main/skills/unslop/SKILL.md): replace vague gardening slogans with useful workspace copy.
- [Dribbble medieval references](https://dribbble.com/search/medieval-website) and [editorial references](https://dribbble.com/search/ui-editorial): printed margins and serif hierarchy, without copying artwork or page layouts.
- [shadcn button source](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/button.tsx), [tabs](https://ui.shadcn.com/docs/components/base/tabs): component variants, focus rings, disabled states and keyboard navigation. Adapt styling to native HTML; this application does not run React.
- [Lucide](https://github.com/lucide-icons/lucide): consistent SVG controls, vendored with attribution.

## Image prompts

Built-in imagegen, `ui-mockup`: three side-by-side desktop agent consoles, called The Scriptorium, Field Notes and The Guild. Warm paper, oxblood, powder blue, sage, restrained gold; serif headings and sans UI; crew navigation, conversation/composer, tasks and permissions margin. Include swatches and miniature garden woodcuts. Avoid generic SaaS cards, gradients, glow, fantasy-game chrome and dark green navigation.

Built-in imagegen, `illustration-story`: an enclosed medieval garden with fountain, winding tiled paths, cypresses, flowering fruit tree, arched cloister and herbs. Fine linocut ink on ivory paper, reinterpreted as a 1970s book illustration. Oxblood #702d38, sage #8c947a, pale blue #c6d5de, ochre #bc9149, ivory #f6f0e4. Landscape composition with generous clean margins and organic plant boundaries. No people, computers, lettering, frame, shadows, burnt parchment, gradients or watermark.

## Validation

**Visual review remains open.** The later [layout audit](frontend-layout-audit.md) documents 14 open layout, hierarchy and validation findings with 23 screenshots. The passing checks below establish only their stated functional and geometry checks; they do not establish visual quality or usable layouts. The initial completion report overstated what had been verified.

Baseline: the full existing UI smoke passed before edits, including durable conversations, permission decisions, delegation, recovery, retention, workers and mobile navigation. Screenshots are in `/tmp/laun-before` for local comparison.

The redesigned app passed the same full browser workflow suite with zero browser exceptions. Typecheck passed. All 23 controller-source and yard-setup tests passed outside the restricted sandbox, including a new byte-for-byte asset install check. Initial sandbox failures in setup tests did not reproduce outside the sandbox.

All seven [workflow screenshots](../demos.md) were regenerated with `bun run demo:capture`, including setup, desktop, delegation, approvals, Gatekeeper, yards and mobile. [Welcome](../images/welcome.png) is also captured. The responsive audit checks login, font loading, image loading, workspace overflow and dialogs at 320, 390, 768, 1024 and 1440 pixels. It caught and resolved the login illustration's intrinsic-height and mobile visibility issues.

Final artwork: `apps/gateway/public/v2/assets/garden.webp` (210 KB), generated with built-in imagegen using the illustration prompt above. Concept board: `docs/design/frontend-concepts.webp` (299 KB). Fonts, icons and artwork are local; there are no added runtime dependencies or external asset requests. Component bases are native HTML adaptations of shadcn styling and state conventions, rather than React components. Licenses are in `apps/gateway/public/v2/THIRD_PARTY.md` and the font assets directory.
