# Changelog

This changelog separates verified package versions from development work that is present in the current working tree but has no recoverable release tag. A local package artifact proves that a package was built; it does not by itself prove that GitHub published a release or establish which source changes went into it.

## 1.0.0 — first committed application baseline

**Date:** The initial Git commit is dated 2026-11-06. A local Arch package artifact was built on 2026-11-07 18:22:33 UTC. A public release date is not established.

**Summary:** Initial Macropad Studio Electron application and cross-platform CI/package baseline.

### What changed

- Added the Electron main process, preload bridge, renderer, configuration storage, shortcut editor, and serial protocol/manager.
- Added tests for configuration, layout, serial protocol, and serial-manager behavior.
- Added GitHub Actions jobs to check, test, and build Linux, Windows, and macOS installers.
- Added the initial Linux, Windows, and macOS packaging configuration.

### Why it changed

- The initial repository commit was titled “Prepare Macropad Studio for cross-platform GitHub builds.” It established a desktop application and automated installer builds.

### Errors/bugs solved

- No specific runtime or firmware bug fix is recorded for this version in the available commit history.

## 1.0.1 — local package artifacts; history not fully recoverable

**Artifact build date:** 2026-11-08 04:14:44 UTC, from the local Arch package metadata. This is a package build date, not a verified GitHub release date.

### What changed

- Local AppImage, Debian, and Arch package artifacts are present.
- **History not fully recoverable:** no Git tag, source commit, or release notes tie specific source changes to 1.0.1.

### Why it changed

- Not recoverable from the available repository history or package metadata.

### Errors/bugs solved

- No version-specific fixes can be reliably attributed to 1.0.1.

## 1.0.2 — local Arch package artifact; history not fully recoverable

**Artifact build date:** 2026-11-08 04:23:47 UTC, from the local Arch package metadata. This is not a verified public release date.

### What changed

- A local Arch package artifact is present.
- **History not fully recoverable:** no matching source commit, Git tag, or release notes are available. No 1.0.2 AppImage or Debian artifact was found in the inspected release directory.

### Why it changed

- Not recoverable from the available repository history or package metadata.

### Errors/bugs solved

- No version-specific fixes can be reliably attributed to 1.0.2.

## 1.0.3 — current package metadata; release history not fully recoverable

**Artifact dates:** The local Arch package metadata records a build at 2026-11-08 04:55:50 UTC; local `latest-linux.yml` records 2026-11-08 04:56:28 UTC. These are package/update-metadata times, not proof of a published GitHub release.

**Summary:** `package.json` and `package-lock.json` currently declare 1.0.3. Local AppImage, Debian, and Arch package artifacts are present.

### What changed

- The package version is verified as 1.0.3.
- The exact source changes included in the 1.0.3 artifacts cannot be reconstructed from a version tag or release commit. The current working tree contains later, uncommitted application and firmware work; do not treat all of it as a verified 1.0.3 release change.

### Why it changed

- The reason for the package-version increment is not recorded in the available Git history or release notes.

### Errors/bugs solved

- No specific fix can be reliably attributed to the 1.0.3 package artifacts.

## Unreleased working-tree development

The package metadata remains 1.0.3. The work below is present in the current project tree and development record, but is not assigned to a new numbered version or a published release.

### OLED designer, screen events, and persistence

- The Screen Designer has page-specific, event-specific layouts, event selection, duration/trigger controls, duplicate design operations, import/export, preview tools, and device upload/readback paths.
- OLED event layouts cover Idle, SW1–SW9, and encoder CW/CCW/press. Firmware renders event screens without requiring the desktop application and uses non-blocking timing.
- Existing page layouts and older JSON layouts without event data remain supported.
- Multi-page OLED configuration remains supported. In normal multi-page mode, SW9 retains its Next Page role.

### Firmware storage and startup fixes

- **`Guru Meditation Error: Core 1 panic'ed` / `Stack canary watchpoint triggered (loopTask)`:** the recorded root cause was `loadScreensFile()` allocating a `ScreenPageStore` (about 10.6 KB) and `ScreenEventStore` (about 55.4 KB) as local variables on an approximately 8 KB `loopTask` stack. The loader now reuses the global draft stores as scratch memory. The firmware subsequently compiled successfully; later project development reports the device running, but this documentation does not claim a fresh hardware test.
- **SPIFFS mount safety:** earlier source snapshots used `SPIFFS.begin(true)`, which permits automatic formatting after a mount failure. The current source uses `SPIFFS.begin(false)` so a mount failure does not automatically format the user's stored screen data.
- **`ERR screen storage failed`:** this error was reported during OLED upload. Current persistence code validates the exact serialized size using a 14-byte header plus the page and event stores, and a regression test checks that calculation. A post-fix hardware persistence verification is not established here.

### ESP32 games

- The development record describes an initial desktop-side games implementation. Encoder input there could also trigger configured volume-up, volume-down, or mute actions.
- Game execution was moved to the ESP32: it owns the game state and loop, draws to the OLED, and consumes encoder/switch input. Firmware routes encoder input away from normal HID actions while GAME mode is active; the usual configured encoder actions remain on the normal path outside GAME mode.
- Tic-Tac-Toe changed from a human-versus-computer game to two-player X/O play. SW1–SW9 map to the 3×3 board; encoder rotation does not select cells.
- The current firmware menu contains Snake, Tic-Tac-Toe, Pong, 2048, Minesweeper, Memory, Simon, Lights Out, and Whack-a-Mole.
- The final gameplay audit corrected four issues in the current working tree: Pong's serve direction was always reset the same way; Memory's unused ninth blank could occupy a playable position; a wrong Whack-a-Mole hit near an expired timer could count an additional miss; and the Tic-Tac-Toe OLED footer overlapped the board by one pixel.

### Other recorded errors and attribution limits

- **`ERR unknown command`:** this was reported when the desktop sent a game command to older firmware. The current parser retains the existing GAME commands and supports the ESP32 game runtime. This is a firmware compatibility incident, not a source change attributed to a numbered package version.
- **`fatal error: screen-layout.h: No such file or directory`:** this compile error was reported. The current sketch has `screen-layout.h` alongside the `.ino` file in `firmware/keys_shorcuts/`, and subsequent firmware compilation succeeded. The precise failed build invocation and a source commit fixing it are not recoverable.
- **`task_wdt_reset(): task not found`:** this warning appeared in the same crash report as the stack canary failure. The available record does not establish an independent root cause or a separate fix, so it is not claimed as independently resolved.

No source change in this development section has been flashed automatically by this documentation update.
