# Macropad Studio

Native Electron desktop editor for the ESP32-S3 3×3 Macropad.

**Current package metadata:** 1.0.3. The working tree contains additional untagged development changes; the repository does not establish that those changes are part of a published 1.0.3 release.

Macropad Studio is built as a separate native installer for each desktop operating system. GitHub Actions runs the tests and builds Linux, Windows, and macOS installers; build artifacts are attached to each workflow run for download.

## Development

```sh
npm install
npm start
```

The app automatically searches Linux serial ports and uses the existing `HELLO`, `GET`, `HOST`, `LABEL`, `SET`, `SAVE`, and `RESET` protocol. It reads configuration after a successful handshake. Writes to the ESP32 require confirmation in a native dialog.

## OLED Screen Designer

The matching sketch is included at `firmware/keys_shorcuts/keys_shorcuts.ino`. Its display is a 128×64, 1-bit SSD1306 OLED rendered with Adafruit GFX. The Screen Designer supports up to eight independent OLED pages. Each page can use the live 3×3 key grid and up to seven additional text elements with the firmware's built-in 5×7 ASCII font at 1× or 2×, inverse monochrome, alignment, and the `HOST`, `LAST`, `ENCODER`, and `HID` live bindings. The hardware has no color, icon, custom-font, or host-system-metric support.

Each OLED page can also store independent Idle, SW1–SW9, and encoder CW/CCW/press screens. Event screens are rendered by the ESP32 while USB is disconnected and return to Idle using a non-blocking `millis()` timer (default 1500 ms). The Screen Designer offers 500–3000 ms, sticky-until-next-event, hold-until-release, press/release trigger selection, and event design duplication. If a page has no explicit Idle event, its existing page layout remains the Idle screen. Missing button and encoder events show firmware-generated feedback based on the configured label and shortcut/action.

When more than one page is uploaded, physical firmware slot **SW9** becomes **Next OLED Page** on the ESP32 itself (wraps from the last page to page 1). This page-switch behavior takes precedence over SW9's stored macro action while multiple pages are active; its SW9 OLED event then displays using the newly selected page's event design. Existing SW9 macro assignments remain stored and resume when a one-page design is uploaded again. If several controls are detected during one firmware loop, event display priority is button press, encoder press, then encoder rotation. A later event replaces the temporary display and restarts its timer. Firmware limits designs to eight pages.

The sketch expects the ESP32 Arduino core, Adafruit GFX, and Adafruit SSD1306 libraries. In Arduino IDE, open the sketch from the `firmware` directory, select the matching ESP32-S3 board, set **USB Mode** to **USB-OTG (TinyUSB)** and **USB CDC On Boot** to **Disabled**, then upload. This is a firmware update; it does not automatically run from the desktop app. The display wiring used by this sketch is SDA GPIO 4, SCL GPIO 5, and I²C address `0x3C` (some modules use `0x3D`).

Local screen designs are saved in app settings and imported/exported as versioned JSON. They do not change the device. Upload requires a native confirmation. Single-page uploads keep the legacy `SCREEN BEGIN/CLEAR/ITEM/VALIDATE/COMMIT/GET` path. Multi-page uploads use the compatible `SCREEN PAGES …` / `SCREEN PAGE …` extension and fail clearly if the connected firmware is too old. Screen data is stored in the ESP32 SPIFFS file system (with a legacy Preferences `scrn` read fallback); it does not issue macro `SAVE` or `RESET`. The legacy fixed screen remains active until a screen design is explicitly committed. The firmware source must be flashed to the ESP32 manually before screen upload features are available.

## ESP32 Games

Physical SW8 enters the game menu while multi-page mode is active. The ESP32 game menu contains Snake, Tic-Tac-Toe, Pong, 2048, Minesweeper, Memory, Simon, Lights Out, and Whack-a-Mole; game state and OLED rendering run on the ESP32, not in a desktop game loop. Tic-Tac-Toe is two-player: SW1–SW9 are its board cells in row-major order. Encoder movement and press are routed according to the active game, and configured volume/mute actions are suppressed during GAME mode; normal encoder actions resume after exit. Long-press the encoder to return from a game to the menu, then use SW7 to exit. SW7–SW9 act as game controls for switch-driven games rather than page navigation. Game state is temporary RAM state and does not change shortcut, OLED, SPIFFS, or NVS configuration.

## Optional AI design assistant

Macropad Studio features a modular, provider-based AI architecture supporting free-tier models from **Google Gemini** (official API) and **OpenRouter** (`openrouter/free` and verified `:free` models), designed so additional free providers (such as Groq) can be added modularly.

Free-only protection ensures that paid API models and paid fallback routes are permanently blocked. On Linux, Macropad Studio forces Chromium's `gnome-libsecret` password store so Electron `safeStorage` uses the desktop Secret Service (gnome-keyring on Omarchy/Hyprland). Linux's insecure `basic_text` fallback is rejected and never used silently. Credentials for each provider are stored in isolated encrypted files in the main process; renderer code, project exports, localStorage, and firmware never store or log API keys.

A prompt and current design are sent to the configured provider only after the user selects Generate. Generated output is validated against the display schema before it enters the editor, and requires explicit user Apply confirmation before modifying the local design. Screen editing, saving, import/export, and firmware upload do not require an API key.

## Local settings

Visual layout, theme, spacing, selected startup page, and the editable macro model are stored in Electron's per-user settings directory. Visual layout changes never modify firmware slot IDs. Import previews a versioned JSON file and applies it to local app settings only; use **Save to device** separately to update the ESP32.

## Install

Download the installer for your operating system from the **Actions** tab of this repository. Installer filenames include their package version; use the version attached to the workflow run you selected. Local Linux artifacts for 1.0.3 are present in this checkout, but that does not establish a published GitHub Release.

- **Arch Linux / Omarchy / Manjaro:** install the downloaded `.pacman` artifact with `sudo pacman -U`; the inspected local 1.0.3 artifact is `Macropad Studio-1.0.3-x64.pacman`.
- **Debian / Ubuntu:** install the downloaded `.deb` artifact with `sudo apt install`; the inspected local 1.0.3 artifact is `Macropad Studio-1.0.3-amd64.deb`.
- **Fedora / RPM systems:** install the `.rpm` with your distribution's package manager.
- **Windows:** run the `.exe` installer included in the selected Actions workflow artifact.
- **macOS:** open the `.dmg` and move Macropad Studio to Applications.
- **Other Linux distributions:** use the downloaded AppImage (the inspected local 1.0.3 file is `Macropad Studio-1.0.3-x86_64.AppImage`). If FUSE 2 is unavailable, run it with `--appimage-extract-and-run`.

Linux package managers install desktop-menu entries and icons. The AppImage is portable and does not automatically add a menu entry.

Windows installers are currently unsigned, and macOS builds need Apple Developer ID signing and notarization for friction-free installation outside the Mac App Store.

No software license has been selected yet. Publishing this repository makes the source visible, but does not grant permission to redistribute or modify it.

## Development and tests

```sh
npm test
npm run check
npm run dist:appimage
npm run dist:deb
npm run dist:pacman
npm run dist:rpm
npm run dist:windows
npm run dist:mac
npm run dist
```

Installers are written to `dist/`. Linux package scripts create AppImage, Debian, RPM, and Arch packages. Windows NSIS installers are built on Windows (or Linux with Wine); macOS DMG and ZIP builds must be made on macOS.

Serial access follows the permissions assigned by Linux to `/dev/ttyACM*` and `/dev/ttyUSB*`. Add the account to the distribution's correct serial-access group if access is denied; the app does not change group membership.

## Project History

See [CHANGELOG.md](CHANGELOG.md) for concise changes and known fixes, and [VERSION_HISTORY.md](VERSION_HISTORY.md) for the evidence-based version and firmware history. Earlier release details that cannot be verified are explicitly marked as incomplete.
