---
name: extract-visual-style-2
description: Extract, reverse-engineer, and codify transferable visual-style systems from images, animation, illustration, live-action film, television, commercials, or video. Use when the user explicitly invokes 风格提取2 or $extract-visual-style-2, or asks for 项目美术风格规范、视觉圣经、AI生图规范、系列视觉一致性、团队级色彩/灯光/空间/材质系统, a project art-direction bible, or project-level calibration of generated results. Supports quick extraction when explicitly invoked, full transferable analysis, and project-style-bible outputs. Default to analysis and prompt delivery only; do not generate images or videos unless explicitly requested in the same request.
---

# Extract Visual Style 2

## Purpose

Turn visual evidence into a reusable, production-ready visual system. Explain how the images work, not merely what they contain. Preserve evidence discipline, content/style separation, character/background/coexistence controls, and prompt modules, then extend them into project-level color, lighting, space, composition, material, effects, compositing, and acceptance systems.

Do not generate images or videos unless the user explicitly requests generation in the same request.

## Route the task

1. Always read [references/output-contract.md](references/output-contract.md).
2. Classify the source and read the matching medium reference:
   - animation, anime, illustration, motion comic, painted animation, or stylized CG: read [references/animation.md](references/animation.md)
   - live-action film, television, commercial, documentary, music video, or photographic AI-video target: read [references/film.md](references/film.md)
   - hybrid work: read both
3. Select one operating mode:
   - **Quick extraction**: concise style identity, stable core, important conditionals, and requested prompt.
   - **Full transferable system**: complete character, background, coexistence, film/motion, prompt, evidence, and confidence structure.
   - **Project style bible**: when the user asks for a visual bible, art-direction guide, project style specification, series consistency system, or team generation standard, also read [references/project-style-bible.md](references/project-style-bible.md).
   - **Calibration**: when generated results are supplied, diagnose and replace faulty rules instead of accumulating negatives.
4. Honor the requested scope. Explicit exclusions such as no concrete content, no aspect ratio, no artist names, no prompts, analysis only, or background only are hard limits.

## Audit the evidence

Inspect every supplied image or usable frame before drafting. For video, sample materially different moments when tools permit. If only stills, posters, trailers, publicity images, or secondary sources are available, state that limit next to the affected conclusion.

Use these adequacy labels:

- one sample: provisional single-sample style
- two to five varied samples: tentative shared style
- six or more varied samples covering different subjects, environments, lighting conditions, and shot sizes: stronger series-level evidence

For each important rule, record:

- visible evidence
- sample coverage
- stable, conditional, or scene-specific status
- observed, inferred, proposed, or unknown status
- confidence: high, medium, or low

Never infer a specific camera, lens model, sensor, stock, LUT, software, or production method from appearance alone. Verify production facts or describe only the visible effect.

## Separate four kinds of information

Privately classify source information before writing:

1. **Content**: identities, objects, locations, actions, story events, costume specifics, logos, and text.
2. **Transferable style**: shape grammar, edge behavior, color roles, lighting logic, texture, space, composition, motion, and finishing.
3. **Production locks**: user-approved aspect ratio, delivery size, medium, compositing purpose, continuity requirements, or model constraints.
4. **Scene locks**: content or geometry required only for a particular scene or shot.

Keep scene locks out of the global style core. Keep production locks visible in project specifications, but omit them from content-free prompts when the user excludes them.

## Build the style architecture

Organize every rule into three layers:

1. **Stable core**: repeated across most suitable samples and safe across the project.
2. **Conditional variants**: changes with character identity, location, time, weather, shot size, emotional function, or narrative emphasis.
3. **Scene-specific locks**: required only for one scene or shot and never presented as universal style.

Do not average away meaningful differences. A coherent project does not require identical brightness, palette, texture density, or motion in every scene; it requires consistent governing logic.

## Map the visual systems

Analyze only relevant systems, but keep their responsibilities distinct:

- **Project identity**: the few invariants whose loss would make the work feel like a different project.
- **Rendering and shape**: medium, construction, silhouette, line, edge, anatomy, and abstraction.
- **Color**: base environment, local/material color, accents, complexion, value, and saturation hierarchy.
- **Lighting**: source, direction, quality, exposure, shadow, practical motivation, atmosphere, and subject landing zone.
- **Space**: depth layers, scale references, perspective, occlusion, reveal, path, enclosure, and navigability.
- **Composition and lens**: shot-size tendency, camera height, focal tendency, negative space, symmetry, framing, and focal placement.
- **Material**: surface structure, roughness, reflectance, wear, age, moisture, translucency, and prohibited substitutions.
- **Character**: proportion, face, identity variation, hair, clothing, local color, and texture.
- **Background**: geometry, grouping, detail density, palette, atmosphere, depth, and environmental motion.
- **Coexistence and compositing**: shared light, color temperature, grain, sharpness, overlap, scale, subject zone, and clean-plate usability.
- **Effects physics**: source, attachment, propagation path, intensity, falloff, environmental response, and temporal behavior.
- **Motion and time**: subject motion, camera motion, cadence, acceleration, settling, focus, blur, texture stability, and cutting rhythm.

For each rule, name the owning system. Do not let color perform the job of anatomical structure, fog perform the job of depth everywhere, grading replace production design, or effects lighting ignore the surrounding material response.

## Write operational rules

Replace vague labels with controllable instructions. A useful rule specifies:

- location or owner
- direction or behavior
- relative strength
- visual purpose
- condition or exception
- failure mode when useful

Prefer relationships over unsupported numerical precision. Use ratios, percentages, hex values, focal lengths, or thresholds only when supplied, measured, repeatedly supported, or clearly labeled as proposed production guidance.

## Compile prompts

Keep reusable style separate from scene content. Use modular blocks when prompts are requested:

1. global style core
2. color system
3. lighting system or conditional lighting preset
4. space, composition, and lens system
5. material system
6. character-only system
7. background-only system
8. coexistence and compositing system
9. effects physics when relevant
10. video motion and temporal system when relevant
11. negative constraints tied to demonstrated or plausible failure modes
12. optional production and scene locks

For a content-free prompt, begin with `【在这里填写人物或场景内容】` and remove sample-specific nouns. When the user asks for a complete prompt, provide a fully merged copy-ready version after the modules.

## Calibrate generated results

When results are returned:

1. identify the visible mismatch
2. assign it to the owning visual system
3. find the ambiguous, missing, or conflicting instruction
4. replace the cause with a rule specifying location, strength, behavior, and exception
5. classify the replacement as stable core, conditional variant, production lock, or scene lock
6. remove obsolete negatives or rules
7. reissue the affected module and a merged prompt when requested

Do not call an untested prompt a validated project standard.

## Final checks

Before delivery, verify:

- evidence limits are stated without overwhelming the answer
- content, transferable style, production locks, and scene locks are separated
- stable rules and conditional variants are not mixed
- project identity is expressed as operational invariants, not genre labels
- color, lighting, space, composition, material, effects, and motion do not contradict one another
- character, background, and coexistence are separated when relevant
- technical production facts are verified or marked unknown
- quantitative values are supported or labeled proposed
- negative constraints target failure modes rather than becoming a generic blacklist
- project-bible outputs include an actionable acceptance method
- no generation occurred unless explicitly requested
