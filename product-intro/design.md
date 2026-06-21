# Design System — opencode-x Product Intro

## Mood

Dark noir, high energy, cinematic tech. Not a presentation — a product trailer.

## Palette

| Token         | Hex                  | Usage                       |
| ------------- | -------------------- | --------------------------- |
| bg-deep       | #07070d              | Primary background          |
| bg-surface    | #12121f              | Panel/card surfaces         |
| accent-cyan   | #00e5ff              | Primary accent, highlights  |
| accent-purple | #7c3aed              | Secondary accent, gradients |
| accent-pink   | #f72585              | Tertiary hot spots          |
| accent-gold   | #ffc300              | Status/warm highlights      |
| text-primary  | #e8e8f0              | Headlines, primary text     |
| text-muted    | #6b6b80              | Secondary text, labels      |
| glow-cyan     | rgba(0,229,255,0.3)  | Glow effects                |
| glow-purple   | rgba(124,58,237,0.2) | Secondary glow              |

## Typography

| Role    | Family         | Weight  | Usage                           |
| ------- | -------------- | ------- | ------------------------------- |
| Display | Space Grotesk  | 700     | Scene headlines, 72-120px       |
| Body    | Inter          | 400-500 | Feature descriptions, 28-36px   |
| Mono    | JetBrains Mono | 400-500 | Commands, code, labels, 20-32px |

## Motion Language

- Eases: `expo.out` (confident entrances), `power4.in` (sharp exits), `back.out(1.4)` (playful overshoot)
- Speed: 0.2-0.4s per entrance (fast), no scene exceeds 3s
- Transitions: WebGL shader dissolve (chromatic aberration), GSAP-driven glitch cuts
- Ambient: Three.js particle drift (continuous), CSS scanline sweep, radial glow pulse

## Constraints

- No centered-only layouts. Anchor to edges, split frames.
- No solid empty backgrounds. Always: particles + glow + grid + noise.
- No slide-deck feel. Overlap, parallax, edge-bleed.
- Font min: 28px body, 60px headlines for video render.
