# Macropad Studio version history

This file records what the repository can establish and clearly marks missing release history. Git commit dates, local package build dates, and public release dates are different facts; a package artifact is not evidence that a GitHub Release was published.

## Version overview

| Version | Date | Main update | Why | Errors fixed |
|---|---|---|---|---|
| 1.0.0 | Initial commit: 2026-11-06. Local Arch artifact built 2026-11-07 18:22:33 UTC; public release date unverified. | Initial Electron application and cross-platform CI/package baseline. | Establish the desktop configurator and automated builds for supported desktop platforms. | No specific runtime or firmware fix is tied to this version in Git history. |
| 1.0.1 | Local package build: 2026-11-08 04:14:44 UTC; release date unverified. | AppImage, Debian, and Arch artifacts exist locally. **History not fully recoverable.** | Not recoverable. | No fix can be tied to this version. |
| 1.0.2 | Local Arch package build: 2026-11-08 04:23:47 UTC; release date unverified. | Arch artifact exists locally. **History not fully recoverable.** | Not recoverable. | No fix can be tied to this version. |
| 1.0.3 | Local Arch package build: 2026-11-08 04:55:50 UTC; local Linux update metadata: 04:56:28 UTC; public release date unverified. | Current `package.json` and lockfile version; local AppImage, Debian, and Arch artifacts exist. Source delta is **history not fully recoverable**. | Package-version rationale is not recorded. | No fix can be tied to the 1.0.3 artifact from available release records. |
| Current working tree | Undated/unreleased changes; package metadata remains 1.0.3. | OLED event designer/runtime, storage safety, ESP32 game runtime, and game fixes are present in the working tree. | Recovered from the current source, tests, backups, and recorded development work; no release tag maps these changes to a version. | See the unversioned development section below; do not attribute these fixes to 1.0.3 without the corresponding release source or tag. |

## Detailed version notes

### 1.0.0 — initial committed baseline

The initial commit `c30726b` (“Prepare Macropad Studio for cross-platform GitHub builds”, 2026-11-06) contains the Electron main/preload/renderer structure, per-user configuration, shortcut and host configuration, the serial manager/protocol, basic tests, and GitHub Actions installer jobs. The initial `package.json` declares version 1.0.0. Commit `d762bd9` later adds a 1.0.0 Arch package artifact to Git.

The recorded reason for the initial work is explicit in the commit title: prepare cross-platform builds. The available commits do not identify a specific error fixed in 1.0.0.

### 1.0.1 — history not fully recoverable

Local AppImage, Debian, and Arch artifacts establish that packages with this version were built. The inspected repository has no 1.0.1 tag or source commit and no release notes assigning changes or fixes to it. The local Arch package build timestamp is 2026-11-08 04:14:44 UTC; that timestamp is not treated as a public release date.

### 1.0.2 — history not fully recoverable

A local Arch package artifact establishes that this package version was built. No matching source commit, tag, or release notes were found; no 1.0.2 AppImage or Debian package was present in the inspected `dist/professional-release` directory. Its package build timestamp is 2026-11-08 04:23:47 UTC, not a verified release date.

### 1.0.3 — current package metadata, source delta uncertain

Both `package.json` and `package-lock.json` declare 1.0.3. Local AppImage, Debian, and Arch artifacts exist. Arch metadata records a package build at 2026-11-08 04:55:50 UTC; `latest-linux.yml` records 04:56:28 UTC. These are build/update metadata, not confirmed publication dates. No Git tag or release record maps the current working source to those artifacts. Accordingly, the OLED/game work described below is not labeled as a verified 1.0.3 release change.

## Unreleased development history from source and recorded work

### OLED designer and event screens

The current uncommitted source includes a multi-page OLED Designer and per-page event layouts for Idle, switches SW1–SW9, and encoder CW/CCW/press. The firmware stores layouts, validates them, renders them locally, and returns to idle with non-blocking timing. The app retains compatibility paths for older designs with no event data. These changes are in the working tree; Git has no release tag or commit that identifies their release version.

### `loadScreensFile()` stack overflow

The earlier implementation placed two large objects on the Arduino `loopTask` stack while loading screen data: `ScreenPageStore` at approximately 10.6 KB and `ScreenEventStore` at approximately 55.4 KB, approximately 66 KB total versus an approximately 8 KB task stack. The recorded crash included:

```text
Guru Meditation Error: Core 1 panic'ed
Stack canary watchpoint triggered (loopTask)
```

The loader now aliases the existing static draft stores and reads into them rather than allocating those stores locally. The firmware compiled after the correction. This fix is not assigned to a numbered release because the source changes are uncommitted and no tag identifies a release containing them.

### SPIFFS mount safety

An archived firmware snapshot contains `SPIFFS.begin(true)`. Current firmware uses `SPIFFS.begin(false)`. The change prevents an unsuccessful mount from automatically formatting SPIFFS, protecting saved screen layouts. This firmware safety change has no recoverable release-tag attribution.

### Screen persistence report

The development record includes `ERR screen storage failed` during screen upload. Current `saveScreensFile()` checks the bytes written against the actual 14-byte header plus serialized page and event stores; a test checks this size calculation. The source now contains this check, but the available records do not confirm a hardware persistence test after the change. It is therefore documented as a source correction with runtime verification pending, not as a fully verified released fix.

### Games moved from desktop to firmware

The recorded development sequence began with a desktop Games interface/runtime. The reported conflict was that encoder movement during a game also invoked the configured normal HID actions (volume up, volume down, or mute). The current firmware routes encoder events to game controls whenever a game is active and returns to the normal configured HID path after game exit. Games render and maintain state on the ESP32/OLED; the desktop sends control commands over the existing serial connection and does not run a second game loop.

Tic-Tac-Toe was changed from single-player versus computer to two human players. SW1–SW9 map in row-major order to the nine board cells, X and O alternate, and encoder rotation is ignored for square selection. The current firmware menu lists nine games: Snake, Tic-Tac-Toe, Pong, 2048, Minesweeper, Memory, Simon, Lights Out, and Whack-a-Mole.

The final gameplay audit found and fixed these unversioned working-tree issues:

1. Pong's point reset selected a leftward serve every time; the serve now depends on which edge was crossed.
2. Memory shuffled an unused ninth blank card along with eight playable positions, which could remove a pair; the deck now contains exactly four pairs for the eight playable switches.
3. A wrong Whack-a-Mole hit could be followed by an immediate timeout miss when the old deadline had already passed; the target timer is reset after a wrong hit.
4. The Tic-Tac-Toe grid overlapped its footer by one pixel; the board was moved up.

These audit fixes are present in the current working tree and are not assigned a release version.

### Other reported errors and their evidence limits

- `ERR unknown command` was reported when a game command reached older firmware. The current parser supports the existing `GAME START MENU`, `GAME START SNAKE`, `GAME START TTT`, `GAME EXIT`, and `GAME STATUS` commands and the added ESP32 game IDs. No numbered release attribution is available.
- `fatal error: screen-layout.h: No such file or directory` was reported during a firmware compile. The current sketch and header are colocated under `firmware/keys_shorcuts/`, and subsequent firmware compiles succeeded. The exact failed command and a commit containing its correction are not recoverable.
- `task_wdt_reset(): task not found` appeared alongside the stack crash report. The available evidence does not establish that it had an independent cause or fix; this history does not claim it was separately solved.

## Git, tags, and release workflow evidence

- The local repository has branch `main`, with `origin/main` at `418fd97`; local `main` is one commit ahead at `d762bd9`.
- `git log --all` contains six commits, all dated 2026-11-06. There are no local tags. The commits cover the cross-platform baseline, CI runner selection, disabling package publishing during builds, IPC sender validation, configured HTTPS development origins, and adding an Arch package artifact.
- The workflow `.github/workflows/ci.yml` uploads build artifacts to Actions with a 30-day retention period. `package.json` build commands use `--publish never`; there is no release-publishing workflow in the inspected tree.
- A read-only `gh release list` attempt could not connect to `api.github.com`, so public GitHub Release records could not be checked. No release date or tag is fabricated here.
- The project backups inspected contain `package.json` version 1.0.0 even where their filenames are dated later. They help confirm firmware evolution but do not map source changes to versions 1.0.1–1.0.3.

## Versioning guidance

The current package metadata is 1.0.3. This documentation does not change package metadata or propose a new number. Before a future GitHub release is tagged, first choose the exact source commit to release, verify it against the intended package artifacts, and write release notes from that source state. The existing CI workflow builds and stores artifacts but does not publish GitHub Releases.
