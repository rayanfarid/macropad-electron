# Macropad Studio

Native Electron desktop editor for the ESP32-S3 3×3 Macropad.

Macropad Studio is built as a separate native installer for each desktop operating system. GitHub Actions runs the tests and builds Linux, Windows, and macOS installers; build artifacts are attached to each workflow run for download.

## Development

```sh
npm install
npm start
```

The app automatically searches Linux serial ports and uses the existing `HELLO`, `GET`, `HOST`, `LABEL`, `SET`, `SAVE`, and `RESET` protocol. It reads configuration after a successful handshake. Writes to the ESP32 require confirmation in a native dialog.

## Local settings

Visual layout, theme, spacing, selected startup page, and the editable macro model are stored in Electron's per-user settings directory. Visual layout changes never modify firmware slot IDs. Import previews a versioned JSON file and applies it to local app settings only; use **Save to device** separately to update the ESP32.

## Install

Download the installer for your operating system from the **Actions** tab of this repository.

- **Arch Linux / Omarchy / Manjaro:** `sudo pacman -U "Macropad Studio-1.0.0-x64.pacman"`
- **Debian / Ubuntu:** `sudo apt install "./Macropad Studio-1.0.0-amd64.deb"`
- **Fedora / RPM systems:** install the `.rpm` with your distribution's package manager.
- **Windows:** run the `Macropad Studio-1.0.0-x64-Setup.exe` installer.
- **macOS:** open the `.dmg` and move Macropad Studio to Applications.
- **Other Linux distributions:** use the AppImage. If FUSE 2 is unavailable, run it with `--appimage-extract-and-run`.

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
