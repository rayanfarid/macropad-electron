# Macropad Studio design integration report

Inspection snapshot: 2026-11-07. The reference archives were extracted unchanged to `/tmp/macropad-design-project1` and `/tmp/macropad-design-project2`. The working project was backed up to `backups/macropad-pre-design-integration-20261107.tar.zst` before integration work.

## Project 1: `macropad-studio.zip`

This is a self-contained vanilla HTML/CSS/JavaScript interface. Its best visual elements are the 232 px charcoal sidebar, compact 56 px top bar, restrained electric-violet accent, Inter/JetBrains Mono typography, Lucide-style outline icons, fine borders, and consistent 4 px spacing and 8–16 px radii. The Macropad editor has a centered hardware preview with a right inspector. The OLED Designer is especially strong: page/event navigation at left, a zoomable dark canvas in the center, a layer/property inspector at right, and persistent save/upload actions at the bottom. It also has clear icon-only tooltips and useful hover/focus states.

The reference's OLED model supports richer concepts than this hardware (animations, progress bars, Wi-Fi/system bindings, more pages, and transitions). Its device model, profiles, connection latency, telemetry, upload progress, activity feed, AI provider, and Games section are sample/simulated data. Those are not integrated as hardware capabilities.

## Project 2: `macropad-studio 1.zip`

This is a small Next.js App Router/TypeScript prototype. The strongest ideas are its CSS custom-property tokens, explicit button variants and sizes, semantic component props, and separation of application shell from controls. Its current app is concentrated in one large `studio-shell.tsx`; it does not provide a reusable, production-tested feature architecture to transplant. No live Electron or device integrations are present.

The useful secondary references are its token naming, focus-visible treatment, responsive breakpoints, and accessible button component API. Next.js, React, Radix, and shadcn dependencies are unnecessary for this app and will not be introduced.

## Existing Macropad Studio functionality

The real application is a sandboxed Electron app with a vanilla renderer, a narrow preload bridge, and main-process IPC validation. It already has actual serial discovery, connect/disconnect, configuration read/write/reset confirmations, host profiles, nine physical switch labels/actions, three encoder actions, layout drag/reordering, local preferences and JSON import/export, and device readback. The OLED model validates 128×64 text/bitmap layouts, up to eight pages, thirteen page-specific event layouts, duration/trigger settings, duplication, import/export, undo/redo, and a matching non-blocking ESP32 firmware event state machine. Gemini and OpenRouter free-model integration runs in the main process; provider keys use Electron `safeStorage` and are never passed back to the renderer. Tests cover the data model, serial protocol, persistence, import/export, AI validation, and secure storage.

There is no game runtime in the existing firmware or renderer. Multi-page SW9 is intentionally Next OLED Page while multiple pages are active; it shows the selected page's SW9 event and does not fire the stored SW9 macro in that mode. The installed firmware and serial protocol must remain the source of truth for device capabilities.

## Conflicts and integration architecture

- Reference screenshots claim a connected Macropad Mk II, multiple layers, additional display telemetry, variable page counts, animations, and game support. The current ESP32/serial protocol does not report or implement these features. Those mock states are excluded.
- Project 1's more expressive OLED elements and effects exceed the current firmware schema. The existing validated design/protocol remains authoritative; the editor only exposes capabilities that the device model can represent.
- Project 2's framework would duplicate the existing renderer and IPC boundary. Preserve Electron main/preload/renderer and use CSS tokens plus small DOM-rendered components instead.
- Keep SW9 page-switch precedence and macro behavior as implemented. Add a Games navigation destination only as a clearly unavailable, explanatory view until firmware support exists.
- Reorganize Settings visually while preserving existing handlers, secure credential boundaries, and configuration formats.

## Recommended integration

Use Project 1 as the visual reference for the sidebar/topbar, charcoal surfaces, purple focus/accent, outline icons, readable cards, and the OLED three-panel workspace. Borrow Project 2's token/component discipline and responsive/accessibility practices. Adapt both to existing DOM nodes, CSS, renderer functions, app configuration, and serial/firmware schema. Keep real hardware facts tied to current Electron state; do not fabricate device telemetry, upload progress, AI activity, or games.
