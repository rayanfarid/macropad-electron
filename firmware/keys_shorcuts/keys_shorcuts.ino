// 3x3 macropad - stage 2
// Editable shortcuts saved in flash + text command channel (COM and USB)
// Wiring: ROW -> switch -> diode anode, diode cathode -> COLUMN
// Arduino IDE: USB Mode = USB-OTG (TinyUSB), USB CDC On Boot = Disabled
// Upload through the COM port. Send commands from the Serial Monitor
// (115200, line ending = Newline) or from the desktop app over the USB port.

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "USB.h"
#include "USBCDC.h"
#include "USBHIDKeyboard.h"
#include "USBHIDConsumerControl.h"
#include <Preferences.h>
#include <SPIFFS.h>
#include "screen-layout.h"
#include "game-rules.h"

// Arduino's prototype generator emits helper declarations before the sketch's
// macro-page storage definition later in this file.
struct MacroPageStore;

#if ARDUINO_USB_MODE
#error "Set Tools > USB Mode to: USB-OTG (TinyUSB)"
#endif

// ---------- Matrix ----------
const int colPins[3] = {38, 37, 36};
const int rowPins[3] = {13, 12, 11};

const uint8_t ROWS = 3;
const uint8_t COLS = 3;
const uint16_t DEBOUNCE_MS = 10;

bool keyState[ROWS][COLS];          // debounced state (true = pressed)
bool lastRaw[ROWS][COLS];           // last raw reading
uint32_t lastChange[ROWS][COLS];    // time of last raw change

// ---------- Rotary encoder ----------
const int ENC_CLK = 7;
const int ENC_DT  = 41;
const int ENC_SW  = 6;
const int8_t ENC_STEPS = 4;         // transitions per detent: use 2 if it counts double
const uint16_t LONG_PRESS_MS = 800; // hold the knob this long to change the OS

volatile int32_t encPos = 0;        // detent counter (changed in the ISR)
volatile uint8_t encState = 0;
volatile int8_t  encSub = 0;
int32_t lastPos = 0;

bool btnState = false;              // debounced encoder button (true = pressed)
bool btnLastRaw = false;
bool longFired = false;
bool encoderPressStartedInGame = false;
uint32_t btnLastChange = 0;
uint32_t btnPressedAt = 0;

// Quadrature decoder: a state table ignores contact bounce
void IRAM_ATTR encoderISR() {
  static const int8_t table[16] = {0, -1, 1, 0,  1, 0, 0, -1,  -1, 0, 0, 1,  0, 1, -1, 0};
  encState = ((encState << 2) | (digitalRead(ENC_CLK) << 1) | digitalRead(ENC_DT)) & 0x0F;
  encSub += table[encState];

  if (encSub >= ENC_STEPS)       { encPos++; encSub = 0; }
  else if (encSub <= -ENC_STEPS) { encPos--; encSub = 0; }
}

// ---------- USB ----------
USBHIDKeyboard Keyboard;
USBHIDConsumerControl ConsumerControl;
USBCDC AppSerial;                   // command channel for the desktop app
bool hidEnabled = true;             // false = safe mode (knob held at power-up)

// ---------- Operating systems ----------
enum HostOs : uint8_t { HOST_WINDOWS, HOST_LINUX, HOST_MACOS, HOST_OMARCHY, HOST_COUNT };
const char* const HOST_NAMES[HOST_COUNT] = {"Windows", "Linux", "macOS", "Omarchy"};  // screen
const char* const HOST_IDS[HOST_COUNT]   = {"WINDOWS", "LINUX", "MACOS", "OMARCHY"};  // commands
const int HOST_ALL = 100;           // only used by the SET command

// ---------- Slots: 0..8 = SW1..SW9, then the three knob actions ----------
const uint8_t SLOT_COUNT = 12;
const uint8_t SLOT_CW    = 9;
const uint8_t SLOT_CCW   = 10;
const uint8_t SLOT_PRESS = 11;

const uint8_t KM_CTRL  = 0x01;
const uint8_t KM_SHIFT = 0x02;
const uint8_t KM_ALT   = 0x04;
const uint8_t KM_GUI   = 0x08;      // Windows key / Super / Command

const uint8_t TYPE_NONE  = 0;
const uint8_t TYPE_KEY   = 1;       // keyboard shortcut
const uint8_t TYPE_MEDIA = 2;       // media key (volume, play...)

// ---------- Saved configuration (stored in flash as text) ----------
const uint32_t CFG_MAGIC = 0x4D503032;   // "MP02"

struct Config {
  uint32_t magic;
  uint8_t  host;                              // current operating system
  char     labels[SLOT_COUNT][9];             // names shown on the screen (8 chars)
  char     combos[HOST_COUNT][SLOT_COUNT][24];  // e.g. "CTRL+SHIFT+M"
};

Config cfg;
Preferences prefs;
bool cfgDirty = false;
uint32_t cfgDirtyAt = 0;

// A macro page holds independent SW1–SW6 shortcuts for each host profile.
// SW7/SW8/SW9 are firmware-reserved navigation controls while multiple pages
// are active. Kept in a separate SPIFFS file so old Config/NVS data is intact.
const uint8_t MAX_MACRO_PAGES = 8;
const uint8_t PAGE_BUTTON_COUNT = 6;
const uint32_t MACRO_PAGES_MAGIC = 0x4D504731; // MPG1
struct MacroPageData {
  char id[25];
  char name[21];
  char labels[PAGE_BUTTON_COUNT][9];
  char combos[HOST_COUNT][PAGE_BUTTON_COUNT][24];
};
struct MacroPageStore { uint32_t magic; uint8_t count; MacroPageData pages[MAX_MACRO_PAGES]; };
MacroPageStore macroPages, macroPagesDraft;
bool macroPagesDraftOpen = false;

// Parsed copy of the combos, rebuilt whenever they change (RAM only)
uint8_t  bType[HOST_COUNT][SLOT_COUNT];
uint8_t  bMods[HOST_COUNT][SLOT_COUNT];
uint16_t bCode[HOST_COUNT][SLOT_COUNT];

// ---------- Factory defaults ----------
const char* const DEFAULT_LABELS[SLOT_COUNT] = {
  "Copy", "Paste", "Cut", "Undo", "Redo", "Sel all", "Save", "Find", "Shot",
  "Vol +", "Vol -", "Mute"
};

const char* const DEFAULT_COMBOS[HOST_COUNT][SLOT_COUNT] = {
  // Windows
  { "CTRL+C", "CTRL+V", "CTRL+X", "CTRL+Z", "CTRL+Y", "CTRL+A", "CTRL+S", "CTRL+F",
    "GUI+SHIFT+S", "VOL_UP", "VOL_DOWN", "MUTE" },
  // Linux
  { "CTRL+C", "CTRL+V", "CTRL+X", "CTRL+Z", "CTRL+SHIFT+Z", "CTRL+A", "CTRL+S", "CTRL+F",
    "PRINTSCREEN", "VOL_UP", "VOL_DOWN", "MUTE" },
  // macOS
  { "GUI+C", "GUI+V", "GUI+X", "GUI+Z", "GUI+SHIFT+Z", "GUI+A", "GUI+S", "GUI+F",
    "GUI+SHIFT+4", "VOL_UP", "VOL_DOWN", "MUTE" },
  // Omarchy (Super+C/V/X is its universal clipboard)
  { "GUI+C", "GUI+V", "GUI+X", "CTRL+Z", "CTRL+SHIFT+Z", "CTRL+A", "CTRL+S", "CTRL+F",
    "PRINTSCREEN", "VOL_UP", "VOL_DOWN", "MUTE" },
};

// ---------- Names understood inside a combo ----------
struct NamedCode { const char* name; uint16_t code; };

const NamedCode NAMED_KEYS[] = {
  {"ENTER", KEY_RETURN}, {"ESC", KEY_ESC}, {"TAB", KEY_TAB}, {"SPACE", ' '},
  {"BACKSPACE", KEY_BACKSPACE}, {"DELETE", KEY_DELETE}, {"INSERT", KEY_INSERT},
  {"HOME", KEY_HOME}, {"END", KEY_END}, {"PAGEUP", KEY_PAGE_UP}, {"PAGEDOWN", KEY_PAGE_DOWN},
  {"UP", KEY_UP_ARROW}, {"DOWN", KEY_DOWN_ARROW}, {"LEFT", KEY_LEFT_ARROW},
  {"RIGHT", KEY_RIGHT_ARROW}, {"PRINTSCREEN", KEY_PRINT_SCREEN}, {"PLUS", '+'},
};

const NamedCode NAMED_MEDIA[] = {
  {"VOL_UP", 0xE9}, {"VOL_DOWN", 0xEA}, {"MUTE", 0xE2}, {"PLAY_PAUSE", 0xCD},
  {"NEXT", 0xB5}, {"PREV", 0xB6}, {"STOP", 0xB7},
};

// ---------- Text helpers ----------
void upperInPlace(char* s) {
  for (; *s; s++) {
    if (*s >= 'a' && *s <= 'z') *s -= 32;
  }
}

// Returns the next space-separated word and moves *p past it
char* nextToken(char** p) {
  char* s = *p;
  while (*s == ' ' || *s == '\t') s++;
  if (*s == 0) { *p = s; return nullptr; }
  char* start = s;
  while (*s && *s != ' ' && *s != '\t') s++;
  if (*s) { *s = 0; s++; }
  *p = s;
  return start;
}

uint8_t modifierBit(const char* t) {
  if (!strcmp(t, "CTRL") || !strcmp(t, "CONTROL")) return KM_CTRL;
  if (!strcmp(t, "SHIFT")) return KM_SHIFT;
  if (!strcmp(t, "ALT") || !strcmp(t, "OPTION")) return KM_ALT;
  if (!strcmp(t, "GUI") || !strcmp(t, "WIN") || !strcmp(t, "WINDOWS") || !strcmp(t, "SUPER") ||
      !strcmp(t, "CMD") || !strcmp(t, "COMMAND") || !strcmp(t, "META")) return KM_GUI;
  return 0;
}

int32_t mediaCode(const char* t) {
  for (uint8_t i = 0; i < sizeof(NAMED_MEDIA) / sizeof(NAMED_MEDIA[0]); i++) {
    if (!strcmp(t, NAMED_MEDIA[i].name)) return NAMED_MEDIA[i].code;
  }
  return -1;
}

int32_t keyCode(const char* t) {
  for (uint8_t i = 0; i < sizeof(NAMED_KEYS) / sizeof(NAMED_KEYS[0]); i++) {
    if (!strcmp(t, NAMED_KEYS[i].name)) return NAMED_KEYS[i].code;
  }
  if (t[0] == 'F' && t[1] >= '0' && t[1] <= '9') {          // F1 .. F12
    int n = atoi(t + 1);
    if (n >= 1 && n <= 12) return KEY_F1 + n - 1;
  }
  if (t[0] != 0 && t[1] == 0) {                              // a single character
    char c = t[0];
    if (c >= 'A' && c <= 'Z') c += 32;                       // letters are sent lowercase
    if (c >= 32 && c < 127) return (uint8_t)c;
  }
  return -1;
}

// Turns "CTRL+SHIFT+M", "F5", "VOL_UP" or "NONE" into type / modifiers / code
bool parseCombo(const char* text, uint8_t* type, uint8_t* mods, uint16_t* code) {
  char buf[24];
  strncpy(buf, text, 23);
  buf[23] = 0;
  upperInPlace(buf);

  if (!strcmp(buf, "NONE")) { *type = TYPE_NONE; *mods = 0; *code = 0; return true; }

  uint8_t m = 0;
  uint16_t key = 0;
  bool haveKey = false;
  bool media = false;
  char* save = nullptr;

  for (char* tok = strtok_r(buf, "+", &save); tok; tok = strtok_r(nullptr, "+", &save)) {
    uint8_t bit = modifierBit(tok);
    if (bit) { m |= bit; continue; }
    if (haveKey) return false;                 // only one main key allowed

    int32_t mc = mediaCode(tok);
    if (mc >= 0) { media = true; key = (uint16_t)mc; haveKey = true; continue; }

    int32_t k = keyCode(tok);
    if (k < 0) return false;
    key = (uint16_t)k;
    haveKey = true;
  }

  if (!haveKey) return false;
  if (media && m) return false;                // media keys take no modifiers
  *type = media ? TYPE_MEDIA : TYPE_KEY;
  *mods = m;
  *code = key;
  return true;
}

// ---------- Config storage ----------
void rebuildOne(uint8_t h, uint8_t slot) {
  if (!parseCombo(cfg.combos[h][slot], &bType[h][slot], &bMods[h][slot], &bCode[h][slot])) {
    bType[h][slot] = TYPE_NONE;
    bMods[h][slot] = 0;
    bCode[h][slot] = 0;
  }
}

void rebuildAll() {
  for (uint8_t h = 0; h < HOST_COUNT; h++) {
    for (uint8_t s = 0; s < SLOT_COUNT; s++) rebuildOne(h, s);
  }
}

void applyCombo(uint8_t h, uint8_t slot, const char* combo) {
  memset(cfg.combos[h][slot], 0, 24);
  strncpy(cfg.combos[h][slot], combo, 23);
  rebuildOne(h, slot);
}

void loadDefaults() {
  memset(&cfg, 0, sizeof(cfg));
  cfg.magic = CFG_MAGIC;
  cfg.host = prefs.getUChar("host", HOST_WINDOWS);   // keep the OS chosen in stage 1
  for (uint8_t s = 0; s < SLOT_COUNT; s++) {
    strncpy(cfg.labels[s], DEFAULT_LABELS[s], 8);
    for (uint8_t h = 0; h < HOST_COUNT; h++) {
      strncpy(cfg.combos[h][s], DEFAULT_COMBOS[h][s], 23);
    }
  }
}

void saveConfig() {
  prefs.putBytes("cfg", &cfg, sizeof(cfg));
  Serial.println("Config saved to flash");
}

void markDirty() {                  // saved automatically 2 seconds after the last change
  cfgDirty = true;
  cfgDirtyAt = millis();
}

void loadConfig() {
  if (prefs.getBytesLength("cfg") == sizeof(cfg)) {
    prefs.getBytes("cfg", &cfg, sizeof(cfg));
    if (cfg.magic != CFG_MAGIC) loadDefaults();
  } else {
    loadDefaults();
  }
  if (cfg.host >= HOST_COUNT) cfg.host = HOST_WINDOWS;
  for (uint8_t s = 0; s < SLOT_COUNT; s++) {         // make sure all text ends properly
    cfg.labels[s][8] = 0;
    for (uint8_t h = 0; h < HOST_COUNT; h++) cfg.combos[h][s][23] = 0;
  }
  rebuildAll();
}

// ---------- Sending to the computer ----------
void sendShortcut(uint8_t mods, uint8_t key) {
  if (!hidEnabled) return;
  if (mods & KM_CTRL)  Keyboard.press(KEY_LEFT_CTRL);
  if (mods & KM_SHIFT) Keyboard.press(KEY_LEFT_SHIFT);
  if (mods & KM_ALT)   Keyboard.press(KEY_LEFT_ALT);
  if (mods & KM_GUI)   Keyboard.press(KEY_LEFT_GUI);
  Keyboard.press(key);
  delay(15);
  Keyboard.releaseAll();
}

void sendConsumer(uint16_t code) {
  if (!hidEnabled) return;
  ConsumerControl.press(code);
  delay(5);
  ConsumerControl.release();
  delay(5);
}

extern ScreenPageStore screenPages;
extern uint8_t currentScreenPage;
extern bool screenCustom;

// Runs whatever is assigned to a slot for the current operating system
void fireSlot(uint8_t slot) {
  uint8_t h = cfg.host;
  if (slot < PAGE_BUTTON_COUNT && screenCustom && screenPages.count > 1 &&
      macroPages.magic == MACRO_PAGES_MAGIC && macroPages.count == screenPages.count && currentScreenPage < macroPages.count) {
    uint8_t type = TYPE_NONE, mods = 0; uint16_t code = 0;
    if (parseCombo(macroPages.pages[currentScreenPage].combos[h][slot], &type, &mods, &code)) {
      if (type == TYPE_KEY) sendShortcut(mods, (uint8_t)code);
      else if (type == TYPE_MEDIA) sendConsumer(code);
    }
    return;
  }
  if (bType[h][slot] == TYPE_KEY)        sendShortcut(bMods[h][slot], (uint8_t)bCode[h][slot]);
  else if (bType[h][slot] == TYPE_MEDIA) sendConsumer(bCode[h][slot]);
}

const char* visibleSlotLabel(uint8_t slot) {
  if (slot < PAGE_BUTTON_COUNT && screenCustom && screenPages.count > 1 &&
      macroPages.magic == MACRO_PAGES_MAGIC && macroPages.count == screenPages.count && currentScreenPage < macroPages.count)
    return macroPages.pages[currentScreenPage].labels[slot];
  return cfg.labels[slot];
}

const char* visibleSlotCombo(uint8_t slot) {
  if (slot < PAGE_BUTTON_COUNT && screenCustom && screenPages.count > 1 &&
      macroPages.magic == MACRO_PAGES_MAGIC && macroPages.count == screenPages.count && currentScreenPage < macroPages.count)
    return macroPages.pages[currentScreenPage].combos[cfg.host][slot];
  return cfg.combos[cfg.host][slot];
}

// ---------- OLED ----------
const int SDA_PIN = 4;
const int SCL_PIN = 5;
#define SCREEN_W  128
#define SCREEN_H  64
#define OLED_ADDR 0x3C              // some modules use 0x3D

const uint32_t SCREEN_MAGIC = 0x53435231; // SCR1, stored separately from macro config
ScreenDesign screenDesign;
ScreenDesign screenDraft;
// Screen pages now persist inside the SPIFFS screens file (see below), so the old
// ~2 KB NVS budget no longer applies. The NVS "scrn" blob is kept only as a
// read fallback for devices flashed before this change.
const uint32_t SCREEN_PAGES_MAGIC = 0x53435232; // SCR2
ScreenPageStore screenPages;
ScreenPageStore screenPagesDraft;
uint8_t currentScreenPage = 0;
bool screenPagesDraftOpen = false;
bool screenCustom = false;
bool screenDraftOpen = false;
bool validateScreenDesign(const ScreenDesign& design);

// ---------- OLED event screens ----------
// Thirteen independent layouts per page: idle, SW1..SW9 press, encoder CW/CCW/press.
// "idle" overrides the page design while no temporary event screen is active;
// when its mask bit is clear the page design itself is the idle screen.
// Storage structs live in screen-layout.h so Arduino's generated prototypes
// can see them before the sketch body.
const char* const EVENT_NAMES[EV_COUNT] = {
  "IDLE", "SW1", "SW2", "SW3", "SW4", "SW5", "SW6", "SW7", "SW8", "SW9",
  "ENCW", "ENCCW", "ENCP"
};

ScreenEventStore screenEvents;
ScreenEventStore screenEventsDraft;
uint8_t eventDraftPage = 0;
uint8_t eventDraftId = 0;
bool screenEventsDraftOpen = false;
bool validateScreenEventDesign(const ScreenEventDesign& design);

// Screens (pages + event screens + timing) persist in the SPIFFS partition so the
// multi-megabyte flash file system absorbs what the small NVS budget cannot.
// Layout on disk: 16-byte header, ScreenPageStore, ScreenEventStore.
const char* const SCREEN_FILE = "/screens.bin";
const uint32_t SCREEN_FILE_MAGIC = 0x53435233; // SCR3
const uint8_t  SCREEN_FILE_VERSION = 1;
const size_t   SCREEN_FILE_HEADER_SIZE = 14; // magic(4) + version(1) + page count(1) + duration(2) + trigger(1) + reserved(5)
bool screenSpiFs = false;

bool validateScreenPageName(const char* name) {
  size_t length = strnlen(name, 21);
  if (!length || length > 20) return false;
  for (size_t i = 0; i < length; i++) if (name[i] < 32 || name[i] > 126) return false;
  return true;
}

void setDefaultScreenDesign(ScreenDesign& design) {
  memset(&design, 0, sizeof(design));
  design.magic = SCREEN_MAGIC;
  design.count = 6;
  const uint8_t xs[6] = {4, 74, 72, 72, 72, 72};
  const uint8_t ys[6] = {1, 2, 20, 31, 44, 55};
  const uint8_t bindings[6] = {SCREEN_KEYGRID, SCREEN_HOST, SCREEN_STATIC, SCREEN_LAST, SCREEN_ENCODER, SCREEN_HID};
  const bool inverse[6] = {false, true, false, false, false, false};
  const char* texts[6] = {"", "", "Last:", "", "", ""};
  for (uint8_t i = 0; i < 6; i++) {
    ScreenElement& item = design.elements[i];
    item.x = xs[i]; item.y = ys[i]; item.size = 1;
    item.binding = bindings[i]; item.alignment = SCREEN_LEFT; item.inverse = inverse[i];
    strncpy(item.text, texts[i], sizeof(item.text) - 1);
  }
}

void setDefaultScreenEvents(ScreenEventStore& store) {
  memset(&store, 0, sizeof(store));
  store.durationMs = 1500;
  store.trigger = 0;                    // show event screens on press
}

// Writes header + page store + event store to the SPIFFS screens file.
bool saveScreensFile() {
  if (!screenSpiFs) return false;
  File file = SPIFFS.open(SCREEN_FILE, "w");
  if (!file) return false;
  uint32_t magic = SCREEN_FILE_MAGIC;
  uint8_t version = SCREEN_FILE_VERSION;
  uint8_t pageCount = screenPages.count;
  uint16_t duration = screenEvents.durationMs;
  uint8_t trigger = screenEvents.trigger;
  uint8_t reserved[5] = {0};
  size_t written = file.write((const uint8_t*)&magic, 4)
                 + file.write(&version, 1) + file.write(&pageCount, 1)
                 + file.write((const uint8_t*)&duration, 2) + file.write(&trigger, 1)
                 + file.write(reserved, 5)
                 + file.write((const uint8_t*)&screenPages, sizeof(screenPages))
                 + file.write((const uint8_t*)&screenEvents, sizeof(screenEvents));
  file.close();
  return written == SCREEN_FILE_HEADER_SIZE + sizeof(screenPages) + sizeof(screenEvents);
}

// Reads the SPIFFS screens file into the live stores. Returns false when the
// file is missing, truncated, or fails validation (caller falls back to NVS).
bool loadScreensFile() {
  if (!screenSpiFs || !SPIFFS.exists(SCREEN_FILE)) return false;
  File file = SPIFFS.open(SCREEN_FILE, "r");
  if (!file || file.size() < SCREEN_FILE_HEADER_SIZE + sizeof(ScreenPageStore) + sizeof(ScreenEventStore)) { if (file) file.close(); return false; }
  uint32_t magic = 0; uint8_t version = 0, pageCount = 0, trigger = 0;
  uint16_t duration = 0; uint8_t reserved[5] = {0};
  file.read((uint8_t*)&magic, 4); file.read(&version, 1); file.read(&pageCount, 1);
  file.read((uint8_t*)&duration, 2); file.read(&trigger, 1); file.read(reserved, 5);
  // These stores already exist in static RAM as upload drafts. Reuse them as
  // boot-time scratch space instead of placing ~66 KB of structs on loopTask's
  // 8 KB stack. loadScreensFile() only runs during setup, before serial uploads.
  ScreenPageStore& pages = screenPagesDraft;
  ScreenEventStore& events = screenEventsDraft;
  size_t gotPages = file.read((uint8_t*)&pages, sizeof(pages));
  size_t gotEvents = file.read((uint8_t*)&events, sizeof(events));
  file.close();
  if (magic != SCREEN_FILE_MAGIC || version != SCREEN_FILE_VERSION ||
      gotPages != sizeof(pages) || gotEvents != sizeof(events) ||
      pageCount < 1 || pageCount > 8 || pages.magic != SCREEN_PAGES_MAGIC || pages.count != pageCount ||
      pages.count > 8 || (duration != EVENT_DURATION_STICKY && duration != EVENT_DURATION_HOLD &&
      (duration < 500 || duration > 3000)) || trigger > 1) return false;
  bool valid = true;
  for (uint8_t i = 0; valid && i < pages.count; i++) {
    valid = validateScreenPageName(pages.pages[i].name) && validateScreenDesign(pages.pages[i].design);
  }
  for (uint8_t p = 0; valid && p < 8; p++) {
    if (events.pages[p].mask & ~((1u << EV_COUNT) - 1)) valid = false;
    for (uint8_t e = 0; valid && e < EV_COUNT; e++) {
      if (events.pages[p].mask & (1u << e)) valid = validateScreenEventDesign(events.pages[p].designs[e]);
    }
  }
  if (!valid) return false;
  screenPages = pages;
  screenEvents = events;
  screenCustom = true;
  currentScreenPage = 0;
  return true;
}

void loadScreenDesign() {
  screenCustom = false;
  memset(&screenPages, 0, sizeof(screenPages));
  screenPages.magic = SCREEN_PAGES_MAGIC; screenPages.count = 1;
  strcpy(screenPages.pages[0].name, "Page 1"); setDefaultScreenDesign(screenPages.pages[0].design);
  setDefaultScreenEvents(screenEvents);
  if (loadScreensFile()) return;
  size_t stored = prefs.getBytesLength("scrn");
  if (stored == sizeof(screenPages) && prefs.getBytes("scrn", &screenPagesDraft, sizeof(screenPagesDraft)) == sizeof(screenPagesDraft) &&
      screenPagesDraft.magic == SCREEN_PAGES_MAGIC && screenPagesDraft.count >= 1 && screenPagesDraft.count <= 8) {
    bool valid = true;
    for (uint8_t i = 0; i < screenPagesDraft.count; i++) {
      if (!validateScreenPageName(screenPagesDraft.pages[i].name) || !validateScreenDesign(screenPagesDraft.pages[i].design)) valid = false;
    }
    if (valid) { screenPages = screenPagesDraft; screenCustom = true; currentScreenPage = 0; }
  } else if (stored == sizeof(screenDesign)) {
    prefs.getBytes("scrn", &screenDesign, sizeof(screenDesign));
    if (screenDesign.magic == SCREEN_MAGIC && validateScreenDesign(screenDesign)) {
      screenCustom = true; screenPages.magic = SCREEN_PAGES_MAGIC; screenPages.count = 1;
      strcpy(screenPages.pages[0].name, "Page 1"); screenPages.pages[0].design = screenDesign;
    }
  }
}

bool validMacroPageText(const char* value, size_t capacity, bool allowEmpty = false) {
  size_t length = strnlen(value, capacity);
  if (length >= capacity || (!allowEmpty && length == 0)) return false;
  for (size_t i = 0; i < length; i++) if (value[i] < 32 || value[i] > 126) return false;
  return true;
}

bool validateMacroPages(const MacroPageStore& store) {
  if (store.magic != MACRO_PAGES_MAGIC || store.count < 1 || store.count > MAX_MACRO_PAGES) return false;
  for (uint8_t p = 0; p < store.count; p++) {
    const MacroPageData& page = store.pages[p];
    if (!validMacroPageText(page.id, sizeof(page.id)) || !validMacroPageText(page.name, sizeof(page.name))) return false;
    for (uint8_t slot = 0; slot < PAGE_BUTTON_COUNT; slot++) {
      if (!validMacroPageText(page.labels[slot], sizeof(page.labels[slot]), true)) return false;
      for (uint8_t host = 0; host < HOST_COUNT; host++) {
        if (!validMacroPageText(page.combos[host][slot], sizeof(page.combos[host][slot]))) return false;
        uint8_t type, mods; uint16_t code;
        if (!parseCombo(page.combos[host][slot], &type, &mods, &code)) return false;
      }
    }
  }
  return true;
}

void seedMacroPages(uint8_t count) {
  memset(&macroPages, 0, sizeof(macroPages));
  macroPages.magic = MACRO_PAGES_MAGIC;
  macroPages.count = count < 1 ? 1 : count > MAX_MACRO_PAGES ? MAX_MACRO_PAGES : count;
  for (uint8_t p = 0; p < macroPages.count; p++) {
    MacroPageData& page = macroPages.pages[p];
    if (p < screenPages.count) {
      strncpy(page.id, screenPages.pages[p].name, sizeof(page.id) - 1);
      snprintf(page.id, sizeof(page.id), "screen-page-%u", p + 1);
      strncpy(page.name, screenPages.pages[p].name, sizeof(page.name) - 1);
    } else {
      snprintf(page.id, sizeof(page.id), "screen-page-%u", p + 1);
      snprintf(page.name, sizeof(page.name), "Page %u", p + 1);
    }
    for (uint8_t slot = 0; slot < PAGE_BUTTON_COUNT; slot++) {
      strncpy(page.labels[slot], cfg.labels[slot], sizeof(page.labels[slot]) - 1);
      for (uint8_t host = 0; host < HOST_COUNT; host++)
        strncpy(page.combos[host][slot], cfg.combos[host][slot], sizeof(page.combos[host][slot]) - 1);
    }
  }
}

bool saveMacroPagesFile() {
  if (!screenSpiFs || !validateMacroPages(macroPages)) return false;
  File file = SPIFFS.open("/macros.bin", "w");
  if (!file) return false;
  const uint8_t version = 1;
  const size_t written = file.write((const uint8_t*)&macroPages.magic, sizeof(macroPages.magic))
    + file.write(&version, sizeof(version))
    + file.write((const uint8_t*)&macroPages, sizeof(macroPages));
  file.close();
  return written == sizeof(macroPages.magic) + sizeof(version) + sizeof(macroPages);
}

bool loadMacroPagesFile() {
  if (!screenSpiFs || !SPIFFS.exists("/macros.bin")) return false;
  File file = SPIFFS.open("/macros.bin", "r");
  if (!file) return false;
  uint32_t magic = 0; uint8_t version = 0;
  MacroPageStore stored;
  const bool complete = file.read((uint8_t*)&magic, sizeof(magic)) == sizeof(magic)
    && file.read(&version, sizeof(version)) == sizeof(version)
    && file.read((uint8_t*)&stored, sizeof(stored)) == sizeof(stored)
    && file.available() == 0;
  file.close();
  if (!complete || magic != MACRO_PAGES_MAGIC || version != 1 || !validateMacroPages(stored)) return false;
  macroPages = stored;
  return true;
}

void loadMacroPages() {
  if (!loadMacroPagesFile()) seedMacroPages(screenPages.count);
}

// Shared element checks for page designs (1024-byte bitmap arena) and event
// designs (256-byte arena). bitmapDataLength is the used prefix of the arena.
bool validateScreenElementList(const ScreenElement* elements, uint8_t count,
                               uint16_t bitmapDataLength, uint16_t bitmapCap) {
  if (count > 8 || bitmapDataLength > bitmapCap) return false;
  for (uint8_t i = 0; i < count; i++) {
    const ScreenElement& item = elements[i];
    const uint8_t align = item.alignment & 0x7F;
    if (item.x >= SCREEN_W || item.y >= SCREEN_H || (item.size != 1 && item.size != 2) ||
        item.binding > SCREEN_LINE || align > SCREEN_RIGHT) return false;
    if (item.binding == SCREEN_KEYGRID) {
      if (item.size != 1 || item.inverse || align != SCREEN_LEFT || item.x + 62 > SCREEN_W || item.y + 62 > SCREEN_H) return false;
      continue;
    }
    if (item.binding == SCREEN_BITMAP) {
      if (item.width < 1 || item.height < 1 || item.x + item.width > SCREEN_W || item.y + item.height > SCREEN_H) return false;
      if (item.bitmapOffset > bitmapDataLength || item.bitmapLength > bitmapDataLength - item.bitmapOffset) return false;
      continue;
    }
    if (item.binding >= SCREEN_RECT && item.binding <= SCREEN_LINE) {
      if (item.width < 1 || item.height < 1 || item.x + item.width > SCREEN_W || item.y + item.height > SCREEN_H) return false;
      if ((item.binding == SCREEN_CIRCLE || item.binding == SCREEN_FILL_CIRCLE) && item.width != item.height) return false;
      continue;
    }
    size_t length = strnlen(item.text, sizeof(item.text));
    if (length >= sizeof(item.text)) return false;
    for (size_t n = 0; n < length; n++) if (item.text[n] < 32 || item.text[n] > 126) return false;
    const char* shown = item.text;
    if (item.binding == SCREEN_HOST) shown = "Omarchy";
    else if (item.binding == SCREEN_LAST || item.binding == SCREEN_ENCODER) shown = "WWWWWWWW";
    else if (item.binding == SCREEN_HID) shown = "HID OFF";
    int16_t width = (int16_t)strlen(shown) * 6 * item.size;
    int16_t left = item.x;
    if (align == SCREEN_CENTER) left -= width / 2;
    else if (align == SCREEN_RIGHT) left -= width;
    if (left < 0 || left + width > SCREEN_W || item.y + (8 * item.size) > SCREEN_H) return false;
  }
  return true;
}

bool validateScreenDesign(const ScreenDesign& design) {
  return design.count <= 8 &&
         validateScreenElementList(design.elements, design.count,
                                   design.bitmapDataLength, sizeof(design.bitmapData));
}

bool validateScreenEventDesign(const ScreenEventDesign& design) {
  return design.count <= 8 &&
         validateScreenElementList(design.elements, design.count,
                                   design.bitmapDataLength, sizeof(design.bitmapData));
}

Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1);
bool oledOk = false;
bool needRedraw = true;
int8_t lastSlot = -1;               // -1 = nothing pressed yet
const char* encMsg = "";            // short message from the knob
uint32_t encMsgUntil = 0;

void showEncMsg(const char* msg) {
  encMsg = msg;
  encMsgUntil = millis() + 1500;
  needRedraw = true;
}

// ---------- OLED event screens runtime ----------
// activeScreenEvent is an EV_* id while a temporary event screen is shown, or -1
// while the idle design (explicit idle event or the page design) is visible.
// Newest event always replaces the current one and restarts its timer, so OLED
// state stays deterministic: an active game owns the display, otherwise
// button > encoder press > encoder rotate > idle.
int8_t activeScreenEvent = -1;
uint32_t screenEventUntil = 0;
uint8_t screenEventHold = 0;          // 0 = none, 1..9 = SW key, 10 = encoder button
uint32_t screenEventLoopId = 0;
uint32_t screenEventLastLoopId = UINT32_MAX;
uint8_t screenEventPriority = 0;
ScreenEventDesign defaultEventBuf;    // synthesized fallback for events with no stored design

// ---------- ESP32-local games runtime ----------
// All gameplay state below is transient RAM; no game state is persisted.
enum GameScreen : uint8_t { GAME_OFF, GAME_MENU, GAME_SNAKE, GAME_TTT, GAME_PONG,
                            GAME_2048, GAME_MINES, GAME_MEMORY, GAME_SIMON,
                            GAME_LIGHTS_OUT, GAME_WHACK };
enum GameInputEvent : uint8_t { GAME_LEFT, GAME_RIGHT, GAME_SELECT };
GameScreen gameScreen = GAME_OFF;
uint8_t gameMenuSelection = 0;
const uint8_t GAME_COUNT = 9;
const char* const GAME_NAMES[GAME_COUNT] = {
  "SNAKE", "TIC TAC TOE", "PONG", "2048", "MINESWEEPER",
  "MEMORY", "SIMON", "LIGHTS OUT", "WHACK-A-MOLE"
};
const uint8_t SNAKE_W = 15;
const uint8_t SNAKE_H = 6;
const uint8_t SNAKE_CELLS = SNAKE_W * SNAKE_H;
uint8_t snakeCells[SNAKE_CELLS];
uint8_t snakeLength = 0;
uint8_t snakeDirection = 1; // 0 up, 1 right, 2 down, 3 left
uint8_t snakeFood = 0;
uint16_t snakeScore = 0;
bool snakeOver = false;
bool snakePaused = false;
bool gameNavigationKeyHandled[3] = {false, false, false};
uint32_t snakeTickAt = 0;
char tttBoard[9]; // 0 empty, X player 1, O player 2
char tttResult = 0; // X, O, D(draw), or 0 while active
char tttNextPlayer = 'X';
uint8_t pongPlayerY = 26, pongCpuY = 26;
int8_t pongBallX = 64, pongBallY = 32, pongBallVX = 2, pongBallVY = 1;
uint8_t pongPlayerScore = 0, pongCpuScore = 0;
bool pongPaused = false, pongOver = false;
uint32_t pongTickAt = 0;
uint16_t board2048[16];
uint32_t score2048 = 0;
uint8_t move2048Direction = 1;
bool over2048 = false, won2048 = false;
uint8_t mineState[9]; // bit 0 mine, bit 1 revealed, bit 2 flagged
uint8_t mineCursor = 4;
char mineResult = 0; // 0 active, W won, L lost
uint8_t memoryCards[9], memoryMatched[9];
int8_t memoryFirst = -1, memorySecond = -1;
uint8_t memoryMatches = 0;
uint16_t memoryAttempts = 0;
uint32_t memoryHideAt = 0;
uint8_t simonSequence[32], simonLength = 1, simonInput = 0, simonPlaybackIndex = 0;
bool simonPlayback = true, simonLit = false, simonOver = false;
uint32_t simonNextAt = 0;
uint16_t lightsBoard = 0;
uint8_t whackTarget = 0, whackMisses = 0;
uint16_t whackScore = 0;
uint32_t whackNextAt = 0;

void triggerScreenEvent(uint8_t ev, uint8_t holdSource) {
  if (ev >= EV_COUNT) return;
  // Inputs are polled in order: buttons, encoder press, encoder rotation.
  // Arbitrate events observed in one loop so polling order cannot demote a
  // higher-priority event. Any event in a later loop replaces the active one.
  const uint8_t priority = ev >= EV_SW1 && ev <= EV_SW9 ? 3
                         : ev == EV_ENCP ? 2
                         : ev == EV_ENCW || ev == EV_ENCCW ? 1 : 0;
  if (screenEventLastLoopId == screenEventLoopId && priority < screenEventPriority) return;
  activeScreenEvent = (int8_t)ev;
  screenEventLastLoopId = screenEventLoopId;
  screenEventPriority = priority;
  screenEventHold = holdSource;
  uint16_t duration = screenEvents.durationMs;
  screenEventUntil = (duration == EVENT_DURATION_STICKY || duration == EVENT_DURATION_HOLD)
                   ? 0 : millis() + duration;
  needRedraw = true;
}

void pollScreenEvents() {
  if (activeScreenEvent < 0) return;
  uint16_t duration = screenEvents.durationMs;
  if (duration == EVENT_DURATION_HOLD) {
    bool released = true;
    if (screenEventHold >= EV_SW1 && screenEventHold <= EV_SW9) {
      uint8_t index = screenEventHold - 1;
      released = !keyState[index / COLS][index % COLS];
    } else if (screenEventHold == 10) {
      released = !btnState;
    } else {
      released = false;             // encoder rotation has no release: stays until the next event
    }
    if (released) { activeScreenEvent = -1; needRedraw = true; }
  } else if (duration != EVENT_DURATION_STICKY && (int32_t)(millis() - screenEventUntil) >= 0) {
    activeScreenEvent = -1;
    needRedraw = true;
  }
}

void buildDefaultEventDesign(uint8_t ev, ScreenEventDesign& design) {
  memset(&design, 0, sizeof(design));
  auto add = [&](uint8_t i, uint8_t x, uint8_t y, uint8_t size, uint8_t binding,
                 uint8_t align, bool inverse, const char* text) {
    ScreenElement& item = design.elements[i];
    item.x = x; item.y = y; item.size = size; item.binding = binding;
    item.alignment = align; item.inverse = inverse;
    strncpy(item.text, text, sizeof(item.text) - 1);
  };
  char combo[24];
  if (ev >= EV_SW1 && ev <= EV_SW9) {
    uint8_t slot = ev - 1;
    if (screenPages.count > 1 && slot == 6) { add(0, 64, 10, 2, SCREEN_STATIC, SCREEN_CENTER, false, "PREV PAGE"); design.count = 1; return; }
    if (screenPages.count > 1 && slot == 7) { add(0, 64, 8, 2, SCREEN_STATIC, SCREEN_CENTER, false, "GAMES"); add(1, 64, 38, 1, SCREEN_STATIC, SCREEN_CENTER, false, "PC REQUIRED"); design.count = 2; return; }
    if (screenPages.count > 1 && slot == 8) { add(0, 64, 10, 2, SCREEN_STATIC, SCREEN_CENTER, false, "NEXT PAGE"); design.count = 1; return; }
    strncpy(combo, visibleSlotCombo(slot), sizeof(combo) - 1);
    combo[sizeof(combo) - 1] = 0;
    if (strlen(combo) > 20) combo[20] = 0;                 // keep size-1 text on screen
    const char* label = visibleSlotLabel(slot)[0] ? visibleSlotLabel(slot) : "SW?";
    add(0, 64, 8, 2, SCREEN_STATIC, SCREEN_CENTER, false, label);
    if (combo[0] && strcmp(combo, "NONE")) { add(1, 64, 46, 1, SCREEN_STATIC, SCREEN_CENTER, false, combo); design.count = 2; }
    else design.count = 1;
  } else if (ev == EV_ENCW || ev == EV_ENCCW || ev == EV_ENCP) {
    uint8_t slot = ev == EV_ENCW ? SLOT_CW : (ev == EV_ENCCW ? SLOT_CCW : SLOT_PRESS);
    const char* name = ev == EV_ENCW ? "CW" : (ev == EV_ENCCW ? "CCW" : "PRESS");
    strncpy(combo, cfg.combos[cfg.host][slot], sizeof(combo) - 1);
    combo[sizeof(combo) - 1] = 0;
    if (strlen(combo) > 20) combo[20] = 0;
    add(0, 64, 6, 2, SCREEN_STATIC, SCREEN_CENTER, false, "ENCODER");
    add(1, 64, 28, 2, SCREEN_STATIC, SCREEN_CENTER, false, name);
    if (combo[0] && strcmp(combo, "NONE")) { add(2, 64, 52, 1, SCREEN_STATIC, SCREEN_CENTER, false, combo); design.count = 3; }
    else design.count = 2;
  }
}

// 1 bpp bitmap, rows of ceil(w/8) bytes, MSB = leftmost pixel (the packing the
// desktop app produces). `inverse` draws the glyph black on a white field.
void drawBitmapElement(int16_t x, int16_t y, uint8_t w, uint8_t h, const uint8_t* data, bool inverse) {
  if (inverse) display.fillRect(x, y, w, h, SSD1306_WHITE);
  uint16_t color = inverse ? SSD1306_BLACK : SSD1306_WHITE;
  uint8_t rowBytes = (w + 7) / 8;
  for (uint8_t py = 0; py < h; py++) {
    const uint8_t* row = data + (uint16_t)py * rowBytes;
    for (uint8_t px = 0; px < w; px++) {
      if (row[px >> 3] & (0x80 >> (px & 7))) display.drawPixel(x + px, y + py, color);
    }
  }
}

void drawScreenElements(const ScreenElement* elements, uint8_t count, const uint8_t* bitmapData) {
  for (uint8_t i = 0; i < count; i++) {
    const ScreenElement& item = elements[i];
    if (item.alignment & 0x80) continue;
    if (item.binding == SCREEN_KEYGRID) {
      for (uint8_t r = 0; r < ROWS; r++) {
        for (uint8_t c = 0; c < COLS; c++) {
          int x = item.x + c * 22;
          int y = item.y + r * 22;
          if (keyState[r][c]) display.fillRoundRect(x, y, 18, 18, 3, SSD1306_WHITE);
          else display.drawRoundRect(x, y, 18, 18, 3, SSD1306_WHITE);
        }
      }
      continue;
    }
    if (item.binding == SCREEN_BITMAP) {
      if (item.bitmapLength) drawBitmapElement(item.x, item.y, item.width, item.height,
                                             bitmapData + item.bitmapOffset, item.inverse);
      continue;
    }
    if (item.binding >= SCREEN_RECT && item.binding <= SCREEN_LINE) {
      const int16_t x = item.x, y = item.y, w = item.width, h = item.height;
      if (item.binding == SCREEN_RECT) {
        if (!item.inverse) display.drawRect(x, y, w, h, SSD1306_WHITE);
        else { display.fillRect(x, y, w, h, SSD1306_WHITE); display.drawRect(x, y, w, h, SSD1306_BLACK); }
      } else if (item.binding == SCREEN_FILL_RECT) {
        if (!item.inverse) display.fillRect(x, y, w, h, SSD1306_WHITE);
        else { display.fillRect(x, y, w, h, SSD1306_WHITE); if (w > 2 && h > 2) display.fillRect(x + 1, y + 1, w - 2, h - 2, SSD1306_BLACK); }
      } else if (item.binding == SCREEN_CIRCLE || item.binding == SCREEN_FILL_CIRCLE) {
        const int16_t radius = w / 2;
        const int16_t cx = x + radius, cy = y + radius;
        if (item.binding == SCREEN_CIRCLE) {
          if (!item.inverse) display.drawCircle(cx, cy, radius, SSD1306_WHITE);
          else { display.fillCircle(cx, cy, radius, SSD1306_WHITE); display.drawCircle(cx, cy, radius, SSD1306_BLACK); }
        } else if (!item.inverse) display.fillCircle(cx, cy, radius, SSD1306_WHITE);
        else { display.fillCircle(cx, cy, radius, SSD1306_WHITE); if (radius > 1) display.fillCircle(cx, cy, radius - 1, SSD1306_BLACK); }
      } else {
        display.drawLine(x, y, x + w - 1, y + h - 1, item.inverse ? SSD1306_BLACK : SSD1306_WHITE);
      }
      continue;
    }
    const char* value = item.text;
    switch (item.binding) {
      case SCREEN_HOST: value = HOST_NAMES[cfg.host]; break;
      case SCREEN_LAST: value = lastSlot >= 0 ? visibleSlotLabel(lastSlot) : "--"; break;
      case SCREEN_ENCODER: value = encMsg; break;
      case SCREEN_HID: value = hidEnabled ? "" : "HID OFF"; break;
      default: break;
    }
    if (!value[0]) continue;
    display.setTextSize(item.size);
    display.setTextColor(item.inverse ? SSD1306_BLACK : SSD1306_WHITE,
                         item.inverse ? SSD1306_WHITE : SSD1306_BLACK);
    int16_t width = (int16_t)strlen(value) * 6 * item.size;
    int16_t x = item.x;
    const uint8_t align = item.alignment & 0x7F;
    if (align == SCREEN_CENTER) x -= width / 2;
    else if (align == SCREEN_RIGHT) x -= width;
    display.setCursor(x, item.y);
    display.print(value);
  }
}

void announceGameState(const char* state) {
  Serial.printf("GAME STATE %s\n", state);
  if (hidEnabled) AppSerial.printf("GAME STATE %s\n", state);
}

void startSnakeGame();
void startTicTacToeGame();
void startPongGame();
void start2048Game();
void startMinesGame();
void startMemoryGame();
void startSimonGame();
void startLightsGame();
void startWhackGame();

void startSnakeGame() {
  snakeLength = 3;
  snakeCells[0] = 7 + (SNAKE_H / 2) * SNAKE_W;
  snakeCells[1] = snakeCells[0] - 1; snakeCells[2] = snakeCells[0] - 2;
  snakeDirection = 1; snakeScore = 0; snakeOver = false; snakePaused = false; snakeTickAt = millis();
  uint8_t target = random(SNAKE_CELLS - snakeLength);
  for (uint8_t cell = 0; cell < SNAKE_CELLS; ++cell) {
    bool occupied = false;
    for (uint8_t i = 0; i < snakeLength; ++i) if (snakeCells[i] == cell) occupied = true;
    if (!occupied && target-- == 0) { snakeFood = cell; break; }
  }
  gameScreen = GAME_SNAKE; needRedraw = true; announceGameState("SNAKE");
}

void startTicTacToeGame() {
  memset(tttBoard, 0, sizeof(tttBoard)); tttResult = 0; tttNextPlayer = 'X';
  gameScreen = GAME_TTT; needRedraw = true; announceGameState("TTT");
}

void enterGameMenu() {
  gameScreen = GAME_MENU; activeScreenEvent = -1; screenEventHold = 0;
  if (gameMenuSelection >= GAME_COUNT) gameMenuSelection = 0;
  needRedraw = true; announceGameState("MENU");
}

void exitGameMode() {
  gameScreen = GAME_OFF; activeScreenEvent = -1; screenEventHold = 0;
  needRedraw = true; announceGameState("EXIT");
}

void spawnSnakeFood() {
  uint8_t freeCount = 0;
  for (uint8_t cell = 0; cell < SNAKE_CELLS; ++cell) {
    bool occupied = false;
    for (uint8_t i = 0; i < snakeLength; ++i) if (snakeCells[i] == cell) occupied = true;
    if (!occupied) ++freeCount;
  }
  if (!freeCount) { snakeOver = true; return; }
  uint8_t target = random(freeCount);
  for (uint8_t cell = 0; cell < SNAKE_CELLS; ++cell) {
    bool occupied = false;
    for (uint8_t i = 0; i < snakeLength; ++i) if (snakeCells[i] == cell) occupied = true;
    if (!occupied && target-- == 0) { snakeFood = cell; return; }
  }
}

void updateSnakeGame() {
  if (snakeOver || snakePaused) return;
  const uint16_t interval = snakeScore >= 14 ? 85 : (uint16_t)(250 - snakeScore * 12);
  const uint32_t now = millis(); if ((uint32_t)(now - snakeTickAt) < interval) return; snakeTickAt = now;
  const int8_t dx[4] = {0, 1, 0, -1}, dy[4] = {-1, 0, 1, 0};
  const uint8_t head = snakeCells[0];
  const int16_t x = (head % SNAKE_W) + dx[snakeDirection], y = (head / SNAKE_W) + dy[snakeDirection];
  if (x < 0 || x >= SNAKE_W || y < 0 || y >= SNAKE_H) { snakeOver = true; needRedraw = true; return; }
  const uint8_t next = (uint8_t)(y * SNAKE_W + x); const bool ate = next == snakeFood;
  for (uint8_t i = 0; i < (ate ? snakeLength : (uint8_t)(snakeLength - 1)); ++i)
    if (snakeCells[i] == next) { snakeOver = true; needRedraw = true; return; }
  if (ate && snakeLength < SNAKE_CELLS) ++snakeLength;
  for (int16_t i = snakeLength - 1; i > 0; --i) snakeCells[i] = snakeCells[i - 1];
  snakeCells[0] = next; if (ate) { ++snakeScore; spawnSnakeFood(); } needRedraw = true;
}

void startPongGame() {
  pongPlayerY = pongCpuY = 25; pongBallX = 64; pongBallY = 32;
  pongBallVX = random(0, 2) ? 2 : -2; pongBallVY = random(0, 2) ? 1 : -1;
  pongPlayerScore = pongCpuScore = 0; pongPaused = pongOver = false;
  pongTickAt = millis(); gameScreen = GAME_PONG; needRedraw = true; announceGameState("PONG");
}

void updatePongGame() {
  if (pongPaused || pongOver || (uint32_t)(millis() - pongTickAt) < 32) return;
  pongTickAt = millis(); pongBallX += pongBallVX; pongBallY += pongBallVY;
  if (pongBallY <= 2 || pongBallY >= 61) pongBallVY = -pongBallVY;
  if (pongBallVX < 0 && pongBallX <= 8 && pongBallY >= pongPlayerY - 3 && pongBallY <= pongPlayerY + 15) {
    pongBallVX = -pongBallVX; pongBallVY = (pongBallY < pongPlayerY + 6) ? -2 : 2;
  } else if (pongBallVX > 0 && pongBallX >= 119 && pongBallY >= pongCpuY - 3 && pongBallY <= pongCpuY + 15) {
    pongBallVX = -pongBallVX; pongBallVY = (pongBallY < pongCpuY + 6) ? -2 : 2;
  }
  if (pongBallX < 0 || pongBallX > 127) {
    if (pongBallX < 0) ++pongCpuScore; else ++pongPlayerScore;
    if (pongPlayerScore >= 5 || pongCpuScore >= 5) pongOver = true;
    else {
      const int8_t serveDirection = pongBallX < 0 ? -2 : 2;
      pongBallX = 64; pongBallY = 32; pongBallVX = serveDirection; pongBallVY = 1;
    }
  }
  if (pongCpuY + 6 < pongBallY) pongCpuY = min((int)pongCpuY + 1, 49);
  else if (pongCpuY + 6 > pongBallY) pongCpuY = max((int)pongCpuY - 1, 2);
  needRedraw = true;
}

void spawn2048Tile() {
  uint8_t free[16], count = 0;
  for (uint8_t i = 0; i < 16; ++i) if (!board2048[i]) free[count++] = i;
  if (count) board2048[free[random(count)]] = random(0, 10) == 0 ? 4 : 2;
}

uint8_t index2048(uint8_t direction, uint8_t line, uint8_t step) {
  if (direction == 0) return step * 4 + line;
  if (direction == 1) return line * 4 + (3 - step);
  if (direction == 2) return (3 - step) * 4 + line;
  return line * 4 + step;
}

bool move2048() {
  bool changed = false;
  for (uint8_t line = 0; line < 4; ++line) {
    uint16_t values[4] = {0,0,0,0}; uint8_t n = 0;
    for (uint8_t step = 0; step < 4; ++step) { uint16_t v = board2048[index2048(move2048Direction, line, step)]; if (v) values[n++] = v; }
    uint16_t merged[4] = {0,0,0,0}; uint8_t out = 0;
    for (uint8_t i = 0; i < n; ++i) {
      if (i + 1 < n && values[i] == values[i + 1]) { merged[out++] = values[i] * 2; score2048 += values[i] * 2; ++i; }
      else merged[out++] = values[i];
    }
    for (uint8_t step = 0; step < 4; ++step) {
      uint8_t cell = index2048(move2048Direction, line, step);
      if (board2048[cell] != merged[step]) changed = true;
      board2048[cell] = merged[step]; if (merged[step] >= 2048) won2048 = true;
    }
  }
  if (changed) spawn2048Tile();
  bool canMove = false;
  for (uint8_t i = 0; i < 16; ++i) {
    if (!board2048[i]) canMove = true;
    if (i % 4 < 3 && board2048[i] == board2048[i + 1]) canMove = true;
    if (i < 12 && board2048[i] == board2048[i + 4]) canMove = true;
  }
  over2048 = !canMove;
  return changed;
}

void start2048Game() {
  memset(board2048, 0, sizeof(board2048)); score2048 = 0; move2048Direction = 1; over2048 = won2048 = false;
  spawn2048Tile(); spawn2048Tile(); gameScreen = GAME_2048; needRedraw = true; announceGameState("2048");
}

void startMinesGame() {
  memset(mineState, 0, sizeof(mineState)); mineCursor = 4; mineResult = 0;
  uint8_t placed = 0; while (placed < 2) { uint8_t i = random(9); if (!(mineState[i] & 1)) { mineState[i] = 1; ++placed; } }
  gameScreen = GAME_MINES; needRedraw = true; announceGameState("MINESWEEPER");
}

void revealMine(uint8_t cell) {
  if (cell >= 9 || (mineState[cell] & 6)) return;
  mineState[cell] |= 2;
  uint8_t safe = 0;
  for (uint8_t i = 0; i < 9; ++i) if (!(mineState[i] & 1) && (mineState[i] & 2)) ++safe;
  if (mineState[cell] & 1) mineResult = 'L';
  else if (safe == 7) mineResult = 'W';
  needRedraw = true;
}

void startMemoryGame() {
  uint8_t deck[8] = {1,1,2,2,3,3,4,4};
  for (int8_t i = 7; i > 0; --i) { uint8_t j = random(i + 1); uint8_t v = deck[i]; deck[i] = deck[j]; deck[j] = v; }
  memset(memoryCards, 0, sizeof(memoryCards)); memcpy(memoryCards, deck, sizeof(deck)); memset(memoryMatched, 0, sizeof(memoryMatched));
  memoryFirst = memorySecond = -1; memoryMatches = 0; memoryAttempts = 0; memoryHideAt = 0;
  gameScreen = GAME_MEMORY; needRedraw = true; announceGameState("MEMORY");
}

void startSimonRound() {
  if (simonLength < sizeof(simonSequence)) simonSequence[simonLength - 1] = random(9);
  simonPlayback = true; simonLit = false; simonPlaybackIndex = 0; simonInput = 0; simonNextAt = millis() + 300;
}

void startSimonGame() {
  simonLength = 1; simonOver = false; startSimonRound(); gameScreen = GAME_SIMON;
  needRedraw = true; announceGameState("SIMON");
}

void startLightsGame() {
  lightsBoard = 0;
  const uint8_t scrambles = 8 + random(8);
  for (uint8_t i = 0; i < scrambles; ++i) {
    uint8_t cell = random(9); lightsBoard ^= (uint16_t)(1u << cell);
    if (cell % 3) lightsBoard ^= (uint16_t)(1u << (cell - 1));
    if (cell % 3 < 2) lightsBoard ^= (uint16_t)(1u << (cell + 1));
    if (cell >= 3) lightsBoard ^= (uint16_t)(1u << (cell - 3));
    if (cell < 6) lightsBoard ^= (uint16_t)(1u << (cell + 3));
  }
  gameScreen = GAME_LIGHTS_OUT; needRedraw = true; announceGameState("LIGHTS OUT");
}

void startWhackGame() {
  whackTarget = random(9); whackMisses = 0; whackScore = 0; whackNextAt = millis() + 1300;
  gameScreen = GAME_WHACK; needRedraw = true; announceGameState("WHACK-A-MOLE");
}

void startSelectedGame() {
  switch (gameMenuSelection) {
    case 0: startSnakeGame(); break; case 1: startTicTacToeGame(); break;
    case 2: startPongGame(); break; case 3: start2048Game(); break;
    case 4: startMinesGame(); break; case 5: startMemoryGame(); break;
    case 6: startSimonGame(); break; case 7: startLightsGame(); break;
    default: startWhackGame(); break;
  }
}

void gameEncoderMove(bool clockwise) {
  if (gameScreen == GAME_MENU) {
    gameMenuSelection = (gameMenuSelection + (clockwise ? 1 : GAME_COUNT - 1)) % GAME_COUNT; needRedraw = true;
  } else if (gameScreen == GAME_SNAKE && !snakeOver && !snakePaused) {
    uint8_t next = (snakeDirection + (clockwise ? 1 : 3)) % 4;
    if ((next + 2) % 4 != snakeDirection) snakeDirection = next;
  } else if (gameScreen == GAME_PONG && !pongOver) {
    pongPlayerY = clockwise ? (pongPlayerY > 4 ? pongPlayerY - 3 : 2) : min((int)pongPlayerY + 3, 49); needRedraw = true;
  } else if (gameScreen == GAME_2048 && !over2048 && !won2048) {
    move2048Direction = (move2048Direction + (clockwise ? 1 : 3)) % 4; needRedraw = true;
  } else if (gameScreen == GAME_MINES) {
    mineCursor = (mineCursor + (clockwise ? 1 : 8)) % 9; needRedraw = true;
  }
  // GAME_TTT is switch-driven; encoder rotation is deliberately ignored.
}

void gameEncoderSelect() {
  if (gameScreen == GAME_MENU) { startSelectedGame(); return; }
  if (gameScreen == GAME_SNAKE) { if (snakeOver) startSnakeGame(); else { snakePaused = !snakePaused; snakeTickAt = millis(); needRedraw = true; } }
  else if (gameScreen == GAME_TTT && tttResult) startTicTacToeGame();
  else if (gameScreen == GAME_PONG) { if (pongOver) startPongGame(); else { pongPaused = !pongPaused; needRedraw = true; } }
  else if (gameScreen == GAME_2048) { if (over2048 || won2048) start2048Game(); else { if (move2048()) needRedraw = true; } }
  else if (gameScreen == GAME_MINES) {
    if (mineResult) startMinesGame();
    else if (!(mineState[mineCursor] & 2)) { mineState[mineCursor] ^= 4; needRedraw = true; }
  } else if (gameScreen == GAME_MEMORY && memoryMatches == 4) startMemoryGame();
  else if (gameScreen == GAME_SIMON && simonOver) startSimonGame();
  else if (gameScreen == GAME_WHACK && whackMisses >= 3) startWhackGame();
}

void routeGameInput(uint8_t event) {
  if (event == GAME_SELECT) gameEncoderSelect(); else gameEncoderMove(event == GAME_RIGHT);
}

void gameSwitchPress(uint8_t key) {
  const uint8_t cell = tttCellForSwitch(key);
  if (cell >= 9) return;
  if (gameScreen == GAME_TTT) {
    if (tttPlaySwitch(tttBoard, key, &tttNextPlayer, &tttResult)) needRedraw = true;
  } else if (gameScreen == GAME_MINES) {
    if (mineResult) startMinesGame(); else { mineCursor = cell; revealMine(cell); }
  } else if (gameScreen == GAME_MEMORY) {
    if (memoryMatches == 4) { startMemoryGame(); return; }
    if (memoryHideAt && (int32_t)(millis() - memoryHideAt) >= 0) { memoryFirst = memorySecond = -1; memoryHideAt = 0; }
    if (memoryMatched[cell] || cell == 8 || cell == memoryFirst || memoryHideAt) return;
    if (memoryFirst < 0) memoryFirst = cell;
    else {
      memorySecond = cell; ++memoryAttempts;
      if (memoryCards[memoryFirst] == memoryCards[memorySecond]) { memoryMatched[memoryFirst] = memoryMatched[memorySecond] = 1; ++memoryMatches; memoryFirst = memorySecond = -1; }
      else memoryHideAt = millis() + 850;
    }
    needRedraw = true;
  } else if (gameScreen == GAME_SIMON && !simonPlayback && !simonOver) {
    if (cell != simonSequence[simonInput]) simonOver = true;
    else if (++simonInput >= simonLength) { if (simonLength < sizeof(simonSequence)) ++simonLength; startSimonRound(); }
    needRedraw = true;
  } else if (gameScreen == GAME_LIGHTS_OUT) {
    if (!lightsBoard) { startLightsGame(); return; }
    lightsBoard ^= (uint16_t)(1u << cell);
    if (cell % 3) lightsBoard ^= (uint16_t)(1u << (cell - 1));
    if (cell % 3 < 2) lightsBoard ^= (uint16_t)(1u << (cell + 1));
    if (cell >= 3) lightsBoard ^= (uint16_t)(1u << (cell - 3));
    if (cell < 6) lightsBoard ^= (uint16_t)(1u << (cell + 3)); needRedraw = true;
  } else if (gameScreen == GAME_WHACK && whackMisses < 3) {
    if (cell == whackTarget) { ++whackScore; whackTarget = random(9); uint16_t interval = whackScore >= 15 ? 350 : 1000 - whackScore * 40; whackNextAt = millis() + interval; }
    else {
      if (++whackMisses < 3) { uint16_t interval = whackScore >= 15 ? 350 : 1000 - whackScore * 40; whackNextAt = millis() + interval; }
    }
    needRedraw = true;
  }
}

void updateOtherGames() {
  const uint32_t now = millis();
  if (gameScreen == GAME_PONG) updatePongGame();
  else if (gameScreen == GAME_MEMORY && memoryHideAt && (int32_t)(now - memoryHideAt) >= 0) {
    memoryFirst = memorySecond = -1; memoryHideAt = 0; needRedraw = true;
  } else if (gameScreen == GAME_SIMON && simonPlayback && (int32_t)(now - simonNextAt) >= 0) {
    if (simonLit) { simonLit = false; ++simonPlaybackIndex; }
    else if (simonPlaybackIndex >= simonLength) { simonPlayback = false; simonInput = 0; }
    else simonLit = true;
    simonNextAt = now + (simonLit ? 500 : 250); needRedraw = true;
  } else if (gameScreen == GAME_WHACK && whackMisses < 3 && (int32_t)(now - whackNextAt) >= 0) {
    if (++whackMisses >= 3) { needRedraw = true; return; }
    whackTarget = random(9); uint16_t interval = whackScore >= 15 ? 350 : 1000 - whackScore * 40;
    whackNextAt = now + interval; needRedraw = true;
  }
}

uint8_t adjacentMineCount(uint8_t cell) {
  const int8_t row = cell / 3, col = cell % 3;
  uint8_t count = 0;
  for (int8_t dr = -1; dr <= 1; ++dr) for (int8_t dc = -1; dc <= 1; ++dc) {
    if (!dr && !dc) continue;
    int8_t r = row + dr, c = col + dc;
    if (r >= 0 && r < 3 && c >= 0 && c < 3 && (mineState[r * 3 + c] & 1)) ++count;
  }
  return count;
}

void drawGridGame(const char* title, const uint8_t* values, uint8_t cursor, bool revealAll = false) {
  display.setTextSize(1); display.setCursor(0, 0); display.print(title);
  const int16_t left = 41, top = 11, cell = 16;
  display.drawLine(left + cell, top, left + cell, top + 48, SSD1306_WHITE);
  display.drawLine(left + cell * 2, top, left + cell * 2, top + 48, SSD1306_WHITE);
  display.drawLine(left, top + cell, left + 48, top + cell, SSD1306_WHITE);
  display.drawLine(left, top + cell * 2, left + 48, top + cell * 2, SSD1306_WHITE);
  for (uint8_t i = 0; i < 9; ++i) {
    int16_t x = left + (i % 3) * cell, y = top + (i / 3) * cell;
    if (values[i]) display.fillRect(x + 3, y + 3, 10, 10, SSD1306_WHITE);
    if (i == cursor) display.drawRect(x + 1, y + 1, 14, 14, SSD1306_WHITE);
  }
  (void)revealAll;
}

void drawGamesScreen() {
  display.clearDisplay(); display.setTextColor(SSD1306_WHITE); display.setTextSize(1);
  if (gameScreen == GAME_MENU) {
    display.setCursor(0, 0); display.print("GAMES");
    uint8_t first = gameMenuSelection > 1 ? gameMenuSelection - 1 : 0;
    if (first + 3 > GAME_COUNT) first = GAME_COUNT - 3;
    for (uint8_t row = 0; row < 3; ++row) {
      display.setCursor(0, 15 + row * 13); display.print((first + row) == gameMenuSelection ? "> " : "  "); display.print(GAME_NAMES[first + row]);
    }
    display.setCursor(0, 56); display.print("ROTATE / PRESS");
  } else if (gameScreen == GAME_SNAKE) {
    display.setCursor(0, 0); display.print("SNAKE"); display.setCursor(91, 0); display.printf("S:%u", snakeScore);
    for (uint8_t i = 0; i < snakeLength; ++i) { uint8_t c = snakeCells[i]; int16_t x = 4 + (c % SNAKE_W) * 8, y = 13 + (c / SNAKE_W) * 8; display.fillRect(x + (i ? 1 : 0), y + (i ? 1 : 0), i ? 5 : 7, i ? 5 : 7, SSD1306_WHITE); }
    display.fillCircle(7 + (snakeFood % SNAKE_W) * 8, 16 + (snakeFood / SNAKE_W) * 8, 2, SSD1306_WHITE);
    if (snakeOver || snakePaused) { display.fillRect(23, 25, 82, 18, SSD1306_BLACK); display.drawRect(23, 25, 82, 18, SSD1306_WHITE); display.setCursor(31, 31); display.print(snakeOver ? "GAME OVER" : "PAUSED"); }
  } else if (gameScreen == GAME_TTT) {
    display.setCursor(0, 0); display.printf("TIC TAC TOE  %c", tttNextPlayer);
    const int16_t left = 41, top = 10, cell = 15;
    display.drawLine(left + cell, top, left + cell, top + 45, SSD1306_WHITE); display.drawLine(left + cell * 2, top, left + cell * 2, top + 45, SSD1306_WHITE);
    display.drawLine(left, top + cell, left + 45, top + cell, SSD1306_WHITE); display.drawLine(left, top + cell * 2, left + 45, top + cell * 2, SSD1306_WHITE);
    for (uint8_t i = 0; i < 9; ++i) { int16_t x = left + (i % 3) * cell, y = top + (i / 3) * cell;
      if (tttBoard[i] == 'X') { display.drawLine(x + 3, y + 3, x + 11, y + 11, SSD1306_WHITE); display.drawLine(x + 11, y + 3, x + 3, y + 11, SSD1306_WHITE); }
      else if (tttBoard[i] == 'O') display.drawCircle(x + 7, y + 7, 5, SSD1306_WHITE);
    }
    display.setCursor(0, 55); if (tttResult == 'X') display.print("PLAYER 1 WINS - HOLD ENC"); else if (tttResult == 'O') display.print("PLAYER 2 WINS - HOLD ENC"); else if (tttResult == 'D') display.print("DRAW - HOLD ENC MENU"); else display.print("SW1-SW9: PLACE MARK");
  } else if (gameScreen == GAME_PONG) {
    display.setCursor(0, 0); display.printf("PONG  %u : %u", pongPlayerScore, pongCpuScore);
    display.drawFastVLine(64, 12, 52, SSD1306_WHITE); display.fillRect(3, pongPlayerY, 3, 13, SSD1306_WHITE); display.fillRect(122, pongCpuY, 3, 13, SSD1306_WHITE); display.fillCircle(pongBallX, pongBallY, 2, SSD1306_WHITE);
    if (pongPaused || pongOver) { display.fillRect(25, 25, 78, 16, SSD1306_BLACK); display.drawRect(25, 25, 78, 16, SSD1306_WHITE); display.setCursor(31, 30); display.print(pongOver ? "GAME OVER" : "PAUSED"); }
  } else if (gameScreen == GAME_2048) {
    display.setCursor(0, 0); display.printf("2048  %lu %c", (unsigned long)score2048, "URDL"[move2048Direction]);
    for (uint8_t i = 0; i < 16; ++i) { int16_t x = (i % 4) * 32, y = 13 + (i / 4) * 11; display.drawRect(x, y, 31, 10, SSD1306_WHITE); if (board2048[i]) { display.setCursor(x + 2, y + 1); display.printf("%u", board2048[i]); } }
    if (over2048 || won2048) { display.setCursor(18, 58); display.print(won2048 ? "2048! PRESS RESTART" : "GAME OVER - RESTART"); }
  } else if (gameScreen == GAME_MINES) {
    display.setCursor(0, 0); display.print("MINES  ENC: FLAG");
    for (uint8_t i = 0; i < 9; ++i) { int16_t x = 41 + (i % 3) * 15, y = 12 + (i / 3) * 15;
      display.drawRect(x, y, 15, 15, SSD1306_WHITE);
      if (mineState[i] & 2) { display.setCursor(x + 5, y + 4); if (mineState[i] & 1) display.print("*"); else { uint8_t adjacent = adjacentMineCount(i); display.print(adjacent ? (char)('0' + adjacent) : '.'); } }
      else if (mineState[i] & 4) { display.setCursor(x + 5, y + 4); display.print("F"); }
      if (i == mineCursor) display.drawRect(x + 2, y + 2, 11, 11, SSD1306_WHITE);
    }
    if (mineResult) { display.setCursor(0, 58); display.print(mineResult == 'W' ? "YOU WIN - PRESS" : "BOOM - PRESS RESTART"); }
  } else if (gameScreen == GAME_MEMORY) {
    display.setCursor(0, 0); display.printf("MEMORY  %u/4  A:%u", memoryMatches, memoryAttempts);
    for (uint8_t i = 0; i < 9; ++i) { int16_t x = 41 + (i % 3) * 15, y = 12 + (i / 3) * 15; display.drawRect(x, y, 15, 15, SSD1306_WHITE);
      if (memoryMatched[i] || i == memoryFirst || i == memorySecond) { display.setCursor(x + 5, y + 4); display.print(memoryCards[i] ? (char)('0' + memoryCards[i]) : ' '); }
    }
    display.setCursor(0, 59); display.print(memoryMatches == 4 ? "COMPLETE - PRESS" : "PRESS SW1-SW8");
  } else if (gameScreen == GAME_SIMON) {
    uint8_t cells[9] = {0}; if (simonPlayback && simonLit) cells[simonSequence[simonPlaybackIndex]] = 1;
    display.setCursor(0, 0); display.printf("SIMON  LEVEL %u", simonLength);
    drawGridGame("", cells, 255);
    display.setCursor(0, 57); display.print(simonOver ? "WRONG - PRESS RESTART" : simonPlayback ? "WATCH" : "REPEAT SW1-SW9");
  } else if (gameScreen == GAME_LIGHTS_OUT) {
    uint8_t cells[9]; for (uint8_t i = 0; i < 9; ++i) cells[i] = (lightsBoard >> i) & 1;
    display.setCursor(0, 0); display.print("LIGHTS OUT"); drawGridGame("", cells, 255);
    display.setCursor(0, 57); display.print(lightsBoard ? "SWITCH CELLS - CLEAR" : "SOLVED! PRESS SW TO RESTART");
  } else if (gameScreen == GAME_WHACK) {
    uint8_t cells[9] = {0}; if (whackMisses < 3) cells[whackTarget] = 1;
    display.setCursor(0, 0); display.printf("WHACK  %u  MISS:%u", whackScore, whackMisses); drawGridGame("", cells, 255);
    display.setCursor(0, 57); display.print(whackMisses >= 3 ? "GAME OVER - PRESS" : "HIT THE LIT SWITCH");
  }
  display.display();
}

void drawScreen() {
  display.clearDisplay();

  if (gameScreen != GAME_OFF) {
    drawGamesScreen();
    return;
  }

  if (screenCustom) {
    const ScreenEventPage& events = screenEvents.pages[currentScreenPage];
    if (activeScreenEvent >= 0) {
      // Temporary event screen: stored design, or a synthesized default.
      if (events.mask & (1u << activeScreenEvent)) {
        const ScreenEventDesign& design = events.designs[activeScreenEvent];
        drawScreenElements(design.elements, design.count, design.bitmapData);
      } else {
        buildDefaultEventDesign(activeScreenEvent, defaultEventBuf);
        drawScreenElements(defaultEventBuf.elements, defaultEventBuf.count, defaultEventBuf.bitmapData);
      }
    } else if (events.mask & (1u << EV_IDLE)) {
      // Explicit idle design overrides the page design.
      const ScreenEventDesign& design = events.designs[EV_IDLE];
      drawScreenElements(design.elements, design.count, design.bitmapData);
    } else {
      const ScreenDesign& design = screenPages.pages[currentScreenPage].design;
      drawScreenElements(design.elements, design.count, design.bitmapData);
    }
    if (screenPages.count > 1) {
      display.fillRect(101, 0, 27, 9, SSD1306_BLACK);
      display.setTextSize(1); display.setTextColor(SSD1306_WHITE); display.setCursor(103, 1);
      display.printf("%u/%u", currentScreenPage + 1, screenPages.count);
    }
    display.display();
    return;
  }

  // 3x3 grid: filled = pressed
  for (uint8_t r = 0; r < ROWS; r++) {
    for (uint8_t c = 0; c < COLS; c++) {
      int x = 4 + c * 22;
      int y = 1 + r * 22;
      if (keyState[r][c]) display.fillRoundRect(x, y, 18, 18, 3, SSD1306_WHITE);
      else                display.drawRoundRect(x, y, 18, 18, 3, SSD1306_WHITE);
    }
  }

  // OS badge (inverted)
  display.fillRoundRect(72, 1, 54, 12, 2, SSD1306_WHITE);
  display.setTextSize(1);
  display.setTextColor(SSD1306_BLACK);
  display.setCursor(76, 3);
  display.print(HOST_NAMES[cfg.host]);

  display.setTextColor(SSD1306_WHITE);
  display.setCursor(72, 20);
  display.print("Last:");
  display.setCursor(72, 31);
  display.print(lastSlot >= 0 ? cfg.labels[lastSlot] : "--");

  display.setCursor(72, 44);
  display.print(encMsg);

  if (!hidEnabled) {
    display.setCursor(72, 55);
    display.print("HID OFF");
  }

  if (screenPages.count > 1) {
    display.fillRect(101, 0, 27, 9, SSD1306_BLACK);
    display.setTextSize(1); display.setTextColor(SSD1306_WHITE); display.setCursor(103, 1);
    display.printf("%u/%u", currentScreenPage + 1, screenPages.count);
  }
  display.display();
}

void onKeyEvent(uint8_t key, bool pressed) {
  needRedraw = true;                // the grid changes on press and release
  if (gameScreen == GAME_TTT || gameScreen == GAME_MINES || gameScreen == GAME_MEMORY ||
      gameScreen == GAME_SIMON || gameScreen == GAME_LIGHTS_OUT || gameScreen == GAME_WHACK) {
    // These games consume the complete physical matrix. In particular SW7-SW9
    // remain Tic-Tac-Toe squares and never trigger page/game navigation here.
    if (pressed) gameSwitchPress(key);
    return;
  }
  if (key >= 7) {
    const uint8_t gameKey = key - 7;
    if (gameScreen != GAME_OFF) {
      if (!pressed) { gameNavigationKeyHandled[gameKey] = false; return; }
      gameNavigationKeyHandled[gameKey] = true;
      if (key == 7) {
        if (gameScreen == GAME_MENU) exitGameMode();
        else enterGameMenu();
      } else if (key == 8) {
        enterGameMenu();
        Serial.println("NAV GAMES");
        if (hidEnabled) AppSerial.println("NAV GAMES");
      } else if (key == 9) {
        if (gameScreen == GAME_MENU) gameMenuSelection = (gameMenuSelection + 1) % GAME_COUNT;
        else { enterGameMenu(); gameMenuSelection = (gameMenuSelection + 1) % GAME_COUNT; }
        needRedraw = true;
      }
      return;
    }
    if (!pressed && gameNavigationKeyHandled[gameKey]) { gameNavigationKeyHandled[gameKey] = false; return; }
  }
  if (gameScreen != GAME_OFF) {
    if (!pressed) return;
    if (key == 7) {
      if (gameScreen == GAME_MENU) exitGameMode();
      else enterGameMenu();
    } else if (key == 8) {
      enterGameMenu();
      Serial.println("NAV GAMES");
      if (hidEnabled) AppSerial.println("NAV GAMES");
    }
    return;
  }
  const bool pageNav = screenCustom && screenPages.count > 1 && key >= 7;

  if (pressed) {
    if (pageNav) {
      // SW7/SW8/SW9 are reserved while multi-page mode is active.
      if (key == 7 && currentScreenPage > 0) currentScreenPage--;
      else if (key == 8) {
        gameMenuSelection = 0;
        enterGameMenu();
        Serial.println("NAV GAMES");
        if (hidEnabled) AppSerial.println("NAV GAMES");
      }
      else if (key == 9) currentScreenPage = (currentScreenPage + 1) % screenPages.count;
      if (key == 7 || key == 9) {
        prefs.putUChar("page", currentScreenPage);
        Serial.printf("PAGE %u %u\n", currentScreenPage + 1, screenPages.count);
        AppSerial.printf("PAGE %u %u\n", currentScreenPage + 1, screenPages.count);
      }
    } else {
      lastSlot = key - 1;
      Serial.printf("SW%u -> %s [%s] (%s)\n", key, visibleSlotLabel(lastSlot),
                    visibleSlotCombo(lastSlot), HOST_NAMES[cfg.host]);
      fireSlot(lastSlot);
    }
    if (gameScreen == GAME_OFF && screenEvents.trigger == 0) triggerScreenEvent(key, key);   // event id == SW number
  } else if (screenEvents.trigger == 1) {
    if (gameScreen == GAME_OFF) triggerScreenEvent(key, 0);         // release-triggered screen remains until another event
  }
}

// Actively drain leftover charge on the columns. Without this, a key held in
// the previous row can be read again as a ghost key in the next row.
void dischargeColumns() {
  for (uint8_t c = 0; c < COLS; c++) {
    pinMode(colPins[c], OUTPUT);
    digitalWrite(colPins[c], LOW);
  }
  delayMicroseconds(10);
  for (uint8_t c = 0; c < COLS; c++) {
    pinMode(colPins[c], INPUT_PULLDOWN);
  }
}

// ---------- Encoder logic ----------
void onEncoderShortPress() {
  if (gameScreen != GAME_OFF) { routeGameInput(GAME_SELECT); return; }
  Serial.printf("Knob: %s\n", cfg.labels[SLOT_PRESS]);
  fireSlot(SLOT_PRESS);
  showEncMsg(cfg.labels[SLOT_PRESS]);
}

void onEncoderLongPress() {
  if (gameScreen == GAME_MENU) { exitGameMode(); return; }
  if (gameScreen != GAME_OFF) { enterGameMenu(); return; }
  cfg.host = (cfg.host + 1) % HOST_COUNT;
  markDirty();
  Serial.printf("OS changed to %s\n", HOST_NAMES[cfg.host]);
  needRedraw = true;
}

void pollEncoderButton() {
  bool raw = (digitalRead(ENC_SW) == LOW);   // active LOW (pull-up)
  uint32_t now = millis();

  if (raw != btnLastRaw) {
    btnLastRaw = raw;
    btnLastChange = now;
  } else if (raw != btnState && (now - btnLastChange) >= DEBOUNCE_MS) {
    btnState = raw;
    if (btnState) {
      btnPressedAt = now;
      longFired = false;
      encoderPressStartedInGame = gameScreen != GAME_OFF;
      if (gameScreen == GAME_OFF && screenEvents.trigger == 0) triggerScreenEvent(EV_ENCP, 10);
    } else {
      if (gameScreen == GAME_OFF && screenEvents.trigger == 1) triggerScreenEvent(EV_ENCP, 0);
      if (!longFired) {
        if (encoderPressStartedInGame) {
          if (gameScreen != GAME_OFF) routeGameInput(GAME_SELECT);
        } else if (gameScreen == GAME_OFF) onEncoderShortPress(); // ignore a press spanning a mode transition
      }
      encoderPressStartedInGame = false;
    }
  }

  if (btnState && !longFired && (now - btnPressedAt) >= LONG_PRESS_MS) {
    longFired = true;
    if (gameScreen != GAME_OFF) onEncoderLongPress();
    else if (!encoderPressStartedInGame) onEncoderLongPress();
  }
}

void pollEncoderPosition() {
  int32_t pos = encPos;
  int32_t d = pos - lastPos;
  if (d == 0) return;
  lastPos = pos;

  uint8_t slot = (d > 0) ? SLOT_CW : SLOT_CCW;
  int32_t n = abs(d);
  if (n > 10) n = 10;
  if (gameScreen != GAME_OFF) {
    for (int32_t i = 0; i < n; i++) routeGameInput(d > 0 ? GAME_RIGHT : GAME_LEFT);
    return;
  }
  for (int32_t i = 0; i < n; i++) fireSlot(slot);

  Serial.printf("Knob: %s\n", cfg.labels[slot]);
  showEncMsg(cfg.labels[slot]);
  triggerScreenEvent(d > 0 ? EV_ENCW : EV_ENCCW, 0);   // encoder feedback, once per poll
}

// ---------- Commands ----------
int parseSlot(const char* t) {
  if (t[0] >= '1' && t[0] <= '9' && t[1] == 0) return t[0] - '1';
  if (!strcmp(t, "CW")) return SLOT_CW;
  if (!strcmp(t, "CCW")) return SLOT_CCW;
  if (!strcmp(t, "PRESS")) return SLOT_PRESS;
  return -1;
}

int parseHost(const char* t) {
  for (uint8_t i = 0; i < HOST_COUNT; i++) {
    if (!strcmp(t, HOST_IDS[i])) return i;
  }
  if (!strcmp(t, "WIN")) return HOST_WINDOWS;
  if (!strcmp(t, "MAC")) return HOST_MACOS;
  if (!strcmp(t, "ALL")) return HOST_ALL;
  return -1;
}

void slotId(uint8_t slot, char* buf) {
  if (slot < 9) { buf[0] = '1' + slot; buf[1] = 0; }
  else strcpy(buf, slot == SLOT_CW ? "CW" : (slot == SLOT_CCW ? "CCW" : "PRESS"));
}

uint8_t parseScreenBinding(const char* value) {
  if (!strcmp(value, "STATIC")) return SCREEN_STATIC;
  if (!strcmp(value, "HOST")) return SCREEN_HOST;
  if (!strcmp(value, "LAST")) return SCREEN_LAST;
  if (!strcmp(value, "ENCODER")) return SCREEN_ENCODER;
  if (!strcmp(value, "HID")) return SCREEN_HID;
  if (!strcmp(value, "KEYGRID")) return SCREEN_KEYGRID;
  if (!strcmp(value, "RECT")) return SCREEN_RECT;
  if (!strcmp(value, "FILL_RECT")) return SCREEN_FILL_RECT;
  if (!strcmp(value, "CIRCLE")) return SCREEN_CIRCLE;
  if (!strcmp(value, "FILL_CIRCLE")) return SCREEN_FILL_CIRCLE;
  if (!strcmp(value, "LINE")) return SCREEN_LINE;
  return 255;
}

uint8_t parseScreenAlignment(const char* value) {
  if (!strcmp(value, "LEFT")) return SCREEN_LEFT;
  if (!strcmp(value, "CENTER")) return SCREEN_CENTER;
  if (!strcmp(value, "RIGHT")) return SCREEN_RIGHT;
  return 255;
}

int8_t screenHexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool decodeScreenText(const char* encoded, char* output, size_t capacity) {
  if (!strcmp(encoded, "-")) { output[0] = 0; return true; }
  size_t length = strlen(encoded);
  if ((length & 1) || length / 2 >= capacity) return false;
  for (size_t i = 0; i < length; i += 2) {
    int8_t high = screenHexDigit(encoded[i]), low = screenHexDigit(encoded[i + 1]);
    if (high < 0 || low < 0) return false;
    char ch = (char)((high << 4) | low);
    if (ch < 32 || ch > 126) return false;
    output[i / 2] = ch;
  }
  output[length / 2] = 0;
  return true;
}

// Parses one ITEM payload (the part after "SCREEN ITEM", "SCREEN PAGE ITEM p i",
// or "SCREEN EVENT ITEM"):
//   text:   index x y size mode binding alignment hextext
//   bitmap: index x y width mode BITMAP height hexdata
// Bitmap bytes are appended to the design's arena; the caller validates the
// containing design afterwards.
bool parseScreenItemArgs(Stream& out, char* args, ScreenElement& item, uint8_t expectedIndex,
                         uint8_t* bitmapData, uint16_t& bitmapDataLength, uint16_t bitmapCap) {
  char* f[6];
  for (uint8_t i = 0; i < 6; i++) f[i] = nextToken(&args);
  if (!f[0] || !f[1] || !f[2] || !f[3] || !f[4] || !f[5]) {
    out.println("ERR usage: ITEM index x y size|width mode binding|BITMAP ..."); return false;
  }
  uint8_t index = (uint8_t)atoi(f[0]);
  uint16_t x = (uint16_t)atoi(f[1]), y = (uint16_t)atoi(f[2]), a = (uint16_t)atoi(f[3]);
  upperInPlace(f[4]);
  const bool hidden = !strncmp(f[4], "HIDDEN_", 7);
  const char* mode = hidden ? f[4] + 7 : f[4];
  if (strcmp(mode, "NORMAL") && strcmp(mode, "INVERSE")) { out.println("ERR invalid screen item"); return false; }
  const bool inverse = !strcmp(mode, "INVERSE");

  if (!strcmp(f[5], "BITMAP")) {
    char* heightText = nextToken(&args);
    while (*args == ' ' || *args == '\t') args++;
    uint16_t height = heightText ? (uint16_t)atoi(heightText) : 0;
    uint16_t width = a;
    uint16_t rowBytes = (width + 7) / 8;
    uint32_t expectedBytes = (uint32_t)rowBytes * height;
    if (index != expectedIndex || index >= 8 || x >= SCREEN_W || y >= SCREEN_H ||
        width < 1 || height < 1 || x + width > SCREEN_W || y + height > SCREEN_H ||
        expectedBytes < 1 || expectedBytes > bitmapCap ||
        strlen(args) != expectedBytes * 2 || bitmapDataLength + expectedBytes > bitmapCap) {
      out.println("ERR invalid screen bitmap item"); return false;
    }
    uint16_t offset = bitmapDataLength;
    for (uint32_t i = 0; i < expectedBytes; i++) {
      int8_t high = screenHexDigit(args[i * 2]), low = screenHexDigit(args[i * 2 + 1]);
      if (high < 0 || low < 0) { out.println("ERR invalid bitmap encoding"); return false; }
      bitmapData[offset + i] = (uint8_t)((high << 4) | low);
    }
    memset(&item, 0, sizeof(item));
    item.x = x; item.y = y; item.width = width; item.height = height;
    item.size = 1; item.binding = SCREEN_BITMAP; item.alignment = SCREEN_LEFT | (hidden ? 0x80 : 0);
    item.inverse = inverse;
    item.bitmapOffset = offset; item.bitmapLength = (uint16_t)expectedBytes;
    bitmapDataLength = offset + (uint16_t)expectedBytes;
    return true;
  }

  upperInPlace(f[5]);
  const uint8_t primitive = parseScreenBinding(f[5]);
  if (primitive >= SCREEN_RECT && primitive <= SCREEN_LINE) {
    char* heightText = nextToken(&args);
    uint16_t height = heightText ? (uint16_t)atoi(heightText) : 0;
    if (index != expectedIndex || index >= 8 || x >= SCREEN_W || y >= SCREEN_H || a < 1 || height < 1 ||
        x + a > SCREEN_W || y + height > SCREEN_H || (primitive == SCREEN_LINE && inverse) ||
        ((primitive == SCREEN_CIRCLE || primitive == SCREEN_FILL_CIRCLE) && a != height)) {
      out.println("ERR invalid screen shape"); return false;
    }
    memset(&item, 0, sizeof(item));
    item.x = x; item.y = y; item.width = a; item.height = height;
    item.size = 1; item.binding = primitive; item.alignment = SCREEN_LEFT | (hidden ? 0x80 : 0); item.inverse = inverse;
    return true;
  }

  // Text form: f[5] is the binding; the alignment token and hex text follow.
  char* alignmentText = nextToken(&args);
  while (*args == ' ' || *args == '\t') args++;
  if (!alignmentText) { out.println("ERR usage: ITEM index x y size mode binding alignment text"); return false; }
  upperInPlace(alignmentText);
  uint8_t binding = parseScreenBinding(f[5]);
  uint8_t alignment = parseScreenAlignment(alignmentText);
  if (index != expectedIndex || index >= 8 || x >= SCREEN_W || y >= SCREEN_H ||
      (a != 1 && a != 2) || binding == 255 || alignment == 255 || strlen(args) > 42) {
    out.println("ERR invalid screen item"); return false;
  }
  char textBuf[22];
  if (!decodeScreenText(args, textBuf, sizeof(textBuf))) { out.println("ERR invalid screen text encoding"); return false; }
  memset(&item, 0, sizeof(item));
  item.x = x; item.y = y; item.size = a; item.binding = binding; item.alignment = alignment | (hidden ? 0x80 : 0);
  item.inverse = inverse;
  strncpy(item.text, textBuf, sizeof(item.text) - 1);
  return true;
}

// Fills a page ScreenDesign element (with its 1024-byte bitmap arena).
bool parseScreenItem(Stream& out, char* args, ScreenDesign& target) {
  uint16_t oldBitmapLength = target.bitmapDataLength;
  ScreenElement item;
  if (!parseScreenItemArgs(out, args, item, target.count, target.bitmapData,
                           target.bitmapDataLength, sizeof(target.bitmapData))) return false;
  target.elements[target.count] = item;
  target.count++;
  if (!validateScreenDesign(target)) {
    target.count--; target.bitmapDataLength = oldBitmapLength;
    out.println("ERR invalid screen item bounds"); return false;
  }
  return true;
}

// Same as parseScreenItem but for event designs (256-byte bitmap arena).
bool parseScreenEventItem(Stream& out, char* args, ScreenEventDesign& target) {
  uint16_t oldBitmapLength = target.bitmapDataLength;
  ScreenElement item;
  if (!parseScreenItemArgs(out, args, item, target.count, target.bitmapData,
                           target.bitmapDataLength, sizeof(target.bitmapData))) return false;
  target.elements[target.count] = item;
  target.count++;
  if (!validateScreenEventDesign(target)) {
    target.count--; target.bitmapDataLength = oldBitmapLength;
    out.println("ERR invalid screen item bounds"); return false;
  }
  return true;
}

const char* screenBindingName(uint8_t binding) {
  switch (binding) {
    case SCREEN_HOST: return "HOST";
    case SCREEN_LAST: return "LAST";
    case SCREEN_ENCODER: return "ENCODER";
    case SCREEN_HID: return "HID";
    case SCREEN_KEYGRID: return "KEYGRID";
    case SCREEN_BITMAP: return "BITMAP";
    case SCREEN_RECT: return "RECT";
    case SCREEN_FILL_RECT: return "FILL_RECT";
    case SCREEN_CIRCLE: return "CIRCLE";
    case SCREEN_FILL_CIRCLE: return "FILL_CIRCLE";
    case SCREEN_LINE: return "LINE";
    default: return "STATIC";
  }
}

// Emits one "SCREEN ITEM ..." row (text or bitmap form) for GET readback.
void dumpScreenElement(Stream& out, uint8_t index, const ScreenElement& item, const uint8_t* bitmapData) {
  const char* mode = item.alignment & 0x80 ? (item.inverse ? "HIDDEN_INVERSE" : "HIDDEN_NORMAL") : (item.inverse ? "INVERSE" : "NORMAL");
  if (item.binding >= SCREEN_RECT && item.binding <= SCREEN_LINE) {
    out.printf("SCREEN ITEM %u %u %u %u %s %s %u\n", index, item.x, item.y, item.width,
               mode, screenBindingName(item.binding), item.height);
    return;
  }
  if (item.binding == SCREEN_BITMAP) {
    out.printf("SCREEN ITEM %u %u %u %u %s BITMAP %u ", index, item.x, item.y,
               item.width, mode, item.height);
    for (uint16_t n = 0; n < item.bitmapLength; n++) out.printf("%02x", bitmapData[item.bitmapOffset + n]);
    out.println();
    return;
  }
  const uint8_t align = item.alignment & 0x7F;
  const char* alignment = align == SCREEN_CENTER ? "CENTER" : align == SCREEN_RIGHT ? "RIGHT" : "LEFT";
  out.printf("SCREEN ITEM %u %u %u %u %s %s %s ", index, item.x, item.y, item.size,
             mode, screenBindingName(item.binding), alignment);
  if (item.text[0]) {
    for (size_t n = 0; item.text[n]; n++) out.printf("%02x", (uint8_t)item.text[n]);
  } else out.print("-");
  out.println();
}

void dumpScreenDesign(Stream& out) {
  if (!screenCustom) {
    out.println("SCREEN LEGACY");
    out.println("SCREEN END");
    return;
  }
  const ScreenDesign& activeDesign = screenPages.pages[currentScreenPage].design;
  for (uint8_t i = 0; i < activeDesign.count; i++) {
    dumpScreenElement(out, i, activeDesign.elements[i], activeDesign.bitmapData);
  }
  out.println("SCREEN END");
}

void dumpScreenPages(Stream& out) {
  out.printf("SCREEN PAGES %u\nSCREEN CURRENT %u\n", screenPages.count, currentScreenPage);
  for (uint8_t p = 0; p < screenPages.count; p++) {
    out.printf("SCREEN PAGE %u ", p);
    if (screenPages.pages[p].name[0]) for (size_t n = 0; screenPages.pages[p].name[n]; n++) out.printf("%02x", (uint8_t)screenPages.pages[p].name[n]);
    else out.print("-");
    out.println();
    const ScreenDesign& design = screenPages.pages[p].design;
    for (uint8_t i = 0; i < design.count; i++) {
      dumpScreenElement(out, i, design.elements[i], design.bitmapData);
    }
    out.println("SCREEN PAGE END");
  }
  out.println("SCREEN END");
}

// Persists pages + event screens: the SPIFFS file when the partition is
// available, otherwise the legacy NVS blob (kept for older partition tables).
bool persistScreens() {
  if (saveScreensFile()) return true;
  return prefs.putBytes("scrn", &screenPages, sizeof(screenPages)) == sizeof(screenPages);
}

int8_t parseEventName(const char* t) {
  for (uint8_t i = 0; i < EV_COUNT; i++) if (!strcmp(t, EVENT_NAMES[i])) return (int8_t)i;
  return -1;
}

bool parseEventDurationToken(const char* t, uint16_t* out) {
  if (!strcmp(t, "STICKY")) { *out = EVENT_DURATION_STICKY; return true; }
  if (!strcmp(t, "HOLD")) { *out = EVENT_DURATION_HOLD; return true; }
  int value = atoi(t);
  if (value != 500 && value != 1000 && value != 1500 && value != 2000 && value != 3000) return false;
  *out = (uint16_t)value;
  return true;
}

bool validateScreenEventsDraft() {
  if (screenEventsDraft.durationMs != EVENT_DURATION_STICKY && screenEventsDraft.durationMs != EVENT_DURATION_HOLD &&
      (screenEventsDraft.durationMs < 500 || screenEventsDraft.durationMs > 3000)) return false;
  if (screenEventsDraft.trigger > 1) return false;
  for (uint8_t p = 0; p < 8; p++) {
    if (screenEventsDraft.pages[p].mask & ~((1u << EV_COUNT) - 1)) return false;
    for (uint8_t e = 0; e < EV_COUNT; e++) {
      if (screenEventsDraft.pages[p].mask & (1u << e) &&
          !validateScreenEventDesign(screenEventsDraft.pages[p].designs[e])) return false;
    }
  }
  return true;
}

void dumpScreenEvents(Stream& out) {
  char durationText[6];
  const char* durationToken;
  if (screenEvents.durationMs == EVENT_DURATION_STICKY) durationToken = "STICKY";
  else if (screenEvents.durationMs == EVENT_DURATION_HOLD) durationToken = "HOLD";
  else { snprintf(durationText, sizeof(durationText), "%u", screenEvents.durationMs); durationToken = durationText; }
  out.printf("SCREEN EVENTS %s %s\n", durationToken, screenEvents.trigger ? "RELEASE" : "PRESS");
  for (uint8_t p = 0; p < screenPages.count; p++) {
    const ScreenEventPage& page = screenEvents.pages[p];
    for (uint8_t e = 0; e < EV_COUNT; e++) {
      if (!(page.mask & (1u << e))) continue;
      const ScreenEventDesign& design = page.designs[e];
      out.printf("SCREEN EVENT %u %s %u\n", p, EVENT_NAMES[e], design.count);
      for (uint8_t i = 0; i < design.count; i++) dumpScreenElement(out, i, design.elements[i], design.bitmapData);
      out.println("SCREEN EVENT END");
    }
  }
  out.println("SCREEN EVENTS END");
}

void handleScreenEventsCommand(Stream& out, char* args) {
  char* action = nextToken(&args);
  if (!action) { out.println("ERR usage: SCREEN EVENTS GET|BEGIN|CLEAR|SETTINGS|VALIDATE|COMMIT"); return; }
  upperInPlace(action);

  if (!strcmp(action, "GET")) { dumpScreenEvents(out); return; }
  if (!strcmp(action, "BEGIN")) {
    screenEventsDraft = screenEvents;
    screenEventsDraftOpen = true;
    out.println("OK SCREEN EVENTS BEGIN"); return;
  }
  if (!screenEventsDraftOpen) { out.println("ERR SCREEN EVENTS BEGIN required"); return; }
  if (!strcmp(action, "CLEAR")) {
    setDefaultScreenEvents(screenEventsDraft);
    out.println("OK SCREEN EVENTS CLEAR"); return;
  }
  if (!strcmp(action, "SETTINGS")) {
    char* durationText = nextToken(&args);
    char* triggerText = nextToken(&args);
    if (durationText) upperInPlace(durationText);
    if (triggerText) upperInPlace(triggerText);
    uint16_t duration = 0;
    if (!durationText || !triggerText || !parseEventDurationToken(durationText, &duration) ||
        (strcmp(triggerText, "PRESS") && strcmp(triggerText, "RELEASE"))) {
      out.println("ERR usage: SCREEN EVENTS SETTINGS <500|1000|1500|2000|3000|STICKY|HOLD> <PRESS|RELEASE>"); return;
    }
    screenEventsDraft.durationMs = duration;
    screenEventsDraft.trigger = !strcmp(triggerText, "RELEASE") ? 1 : 0;
    out.println("OK SCREEN EVENTS SETTINGS"); return;
  }
  if (!strcmp(action, "VALIDATE")) {
    out.println(validateScreenEventsDraft() ? "OK SCREEN EVENTS VALID" : "ERR invalid screen events"); return;
  }
  if (!strcmp(action, "COMMIT")) {
    if (!validateScreenEventsDraft()) { out.println("ERR invalid screen events"); return; }
    screenEvents = screenEventsDraft;
    screenEventsDraftOpen = false;
    needRedraw = true;
    if (!persistScreens()) { out.println("ERR screen storage failed"); return; }
    out.println("OK SCREEN EVENTS COMMITTED"); return;
  }
  out.println("ERR unknown SCREEN EVENTS command");
}

void handleScreenEventCommand(Stream& out, char* args) {
  char* action = nextToken(&args);
  if (!action) { out.println("ERR usage: SCREEN EVENT SELECT|ITEM"); return; }
  upperInPlace(action);
  if (!screenEventsDraftOpen) { out.println("ERR SCREEN EVENTS BEGIN required"); return; }

  if (!strcmp(action, "SELECT")) {
    char* pageText = nextToken(&args);
    char* eventText = nextToken(&args);
    int pageIndex = pageText ? atoi(pageText) : -1;
    if (eventText) upperInPlace(eventText);
    int eventIndex = eventText ? parseEventName(eventText) : -1;
    if (pageIndex < 0 || pageIndex >= 8 || eventIndex < 0) { out.println("ERR invalid event target"); return; }
    eventDraftPage = (uint8_t)pageIndex;
    eventDraftId = (uint8_t)eventIndex;
    ScreenEventDesign& design = screenEventsDraft.pages[eventDraftPage].designs[eventDraftId];
    memset(&design, 0, sizeof(design));
    screenEventsDraft.pages[eventDraftPage].mask |= (uint16_t)(1u << eventDraftId);
    out.println("OK SCREEN EVENT SELECTED"); return;
  }
  if (!strcmp(action, "ITEM")) {
    if (!parseScreenEventItem(out, args, screenEventsDraft.pages[eventDraftPage].designs[eventDraftId])) return;
    out.println("OK SCREEN EVENT ITEM"); return;
  }
  out.println("ERR unknown SCREEN EVENT command");
}

void handleScreenCommand(Stream& out, char* args) {
  char* sub = nextToken(&args);
  if (!sub) { out.println("ERR usage: SCREEN GET|BEGIN|CLEAR|ITEM|VALIDATE|COMMIT"); return; }
  upperInPlace(sub);

  if (!strcmp(sub, "EVENTS")) { handleScreenEventsCommand(out, args); return; }
  if (!strcmp(sub, "EVENT")) { handleScreenEventCommand(out, args); return; }
  if (!strcmp(sub, "PAGES")) {
    char* action = nextToken(&args);
    if (!action) { out.println("ERR usage: SCREEN PAGES GET|BEGIN|CLEAR|VALIDATE|COMMIT"); return; }
    upperInPlace(action);
    if (!strcmp(action, "GET")) { dumpScreenPages(out); return; }
    if (!strcmp(action, "BEGIN")) {
      memset(&screenPagesDraft, 0, sizeof(screenPagesDraft)); screenPagesDraft.magic = SCREEN_PAGES_MAGIC;
      if (screenCustom) screenPagesDraft = screenPages;
      else { screenPagesDraft.count = 1; strcpy(screenPagesDraft.pages[0].name, "Page 1"); setDefaultScreenDesign(screenPagesDraft.pages[0].design); }
      screenPagesDraftOpen = true; out.println("OK SCREEN PAGES BEGIN"); return;
    }
    if (!screenPagesDraftOpen) { out.println("ERR SCREEN PAGES BEGIN required"); return; }
    if (!strcmp(action, "CLEAR")) { memset(&screenPagesDraft, 0, sizeof(screenPagesDraft)); screenPagesDraft.magic = SCREEN_PAGES_MAGIC; out.println("OK SCREEN PAGES CLEAR"); return; }
    if (!strcmp(action, "VALIDATE")) {
      bool valid = screenPagesDraft.count >= 1 && screenPagesDraft.count <= 8;
      for (uint8_t p = 0; valid && p < screenPagesDraft.count; p++) valid = validateScreenPageName(screenPagesDraft.pages[p].name) && validateScreenDesign(screenPagesDraft.pages[p].design);
      out.println(valid ? "OK SCREEN PAGES VALID" : "ERR invalid screen pages"); return;
    }
    if (!strcmp(action, "COMMIT")) {
      bool valid = screenPagesDraft.count >= 1 && screenPagesDraft.count <= 8;
      for (uint8_t p = 0; valid && p < screenPagesDraft.count; p++) valid = validateScreenPageName(screenPagesDraft.pages[p].name) && validateScreenDesign(screenPagesDraft.pages[p].design);
      if (!valid) { out.println("ERR invalid screen pages"); return; }
      screenPagesDraft.magic = SCREEN_PAGES_MAGIC;
      screenPages = screenPagesDraft; screenCustom = true; currentScreenPage = 0;
      screenPagesDraftOpen = false; screenDraftOpen = false; needRedraw = true;
      if (!persistScreens()) { out.println("ERR screen storage failed"); return; }
      out.println("OK SCREEN PAGES COMMITTED"); return;
    }
    out.println("ERR unknown SCREEN PAGES command"); return;
  }
  if (!strcmp(sub, "PAGE")) {
    char* action = nextToken(&args);
    if (!action) { out.println("ERR usage: SCREEN PAGE ADD|ITEM"); return; }
    upperInPlace(action);
    if (!strcmp(action, "SET")) {
      char* pageText = nextToken(&args); int pageIndex = pageText ? atoi(pageText) : -1;
      if (!screenCustom || pageIndex < 0 || pageIndex >= screenPages.count) { out.println("ERR invalid page index"); return; }
      currentScreenPage = (uint8_t)pageIndex; prefs.putUChar("page", currentScreenPage); needRedraw = true; out.println("OK SCREEN PAGE SELECTED"); return;
    }
    if (!screenPagesDraftOpen) { out.println("ERR SCREEN PAGES BEGIN required"); return; }
    if (!strcmp(action, "ADD")) {
      char* indexText = nextToken(&args); char* nameText = nextToken(&args);
      if (!indexText || !nameText || screenPagesDraft.count >= 8 || atoi(indexText) != screenPagesDraft.count) { out.println("ERR invalid page index"); return; }
      ScreenPageData& page = screenPagesDraft.pages[screenPagesDraft.count];
      if (!decodeScreenText(nameText, page.name, sizeof(page.name)) || !page.name[0]) { out.println("ERR invalid page name"); return; }
      memset(&page.design, 0, sizeof(page.design)); page.design.magic = SCREEN_MAGIC; screenPagesDraft.count++; out.println("OK SCREEN PAGE ADDED"); return;
    }
    if (!strcmp(action, "ITEM")) {
      char* pageText = nextToken(&args);
      if (!pageText) { out.println("ERR missing page index"); return; }
      int pageIndex = atoi(pageText);
      if (pageIndex < 0 || pageIndex >= screenPagesDraft.count) { out.println("ERR invalid page index"); return; }
      if (!parseScreenItem(out, args, screenPagesDraft.pages[pageIndex].design)) return;
      out.println("OK SCREEN PAGE ITEM"); return;
    }
    out.println("ERR unknown SCREEN PAGE command"); return;
  }

  if (!strcmp(sub, "GET")) {
    dumpScreenDesign(out);
  } else if (!strcmp(sub, "BEGIN")) {
    if (screenCustom) screenDraft = screenPages.pages[currentScreenPage].design;
    else setDefaultScreenDesign(screenDraft);
    screenDraftOpen = true;
    out.println("OK SCREEN BEGIN");
  } else if (!strcmp(sub, "CLEAR")) {
    if (!screenDraftOpen) { out.println("ERR SCREEN BEGIN required"); return; }
    memset(&screenDraft, 0, sizeof(screenDraft));
    screenDraft.magic = SCREEN_MAGIC;
    out.println("OK SCREEN CLEAR");
  } else if (!strcmp(sub, "ITEM")) {
    if (!screenDraftOpen) { out.println("ERR SCREEN BEGIN required"); return; }
    if (!parseScreenItem(out, args, screenDraft)) return;
    out.println("OK SCREEN ITEM");
  } else if (!strcmp(sub, "VALIDATE")) {
    if (!screenDraftOpen || !validateScreenDesign(screenDraft)) { out.println("ERR invalid screen design"); return; }
    out.println("OK SCREEN VALID");
  } else if (!strcmp(sub, "COMMIT")) {
    if (!screenDraftOpen || !validateScreenDesign(screenDraft)) { out.println("ERR invalid screen design"); return; }
    screenDraft.magic = SCREEN_MAGIC;
    screenDesign = screenDraft;
    memset(&screenPages, 0, sizeof(screenPages)); screenPages.magic = SCREEN_PAGES_MAGIC; screenPages.count = 1;
    strcpy(screenPages.pages[0].name, "Page 1"); screenPages.pages[0].design = screenDraft; currentScreenPage = 0;
    screenCustom = true;
    screenDraftOpen = false;
    needRedraw = true;
    if (!persistScreens()) { out.println("ERR screen storage failed"); return; }
    out.println("OK SCREEN COMMITTED");
  } else {
    out.println("ERR unknown SCREEN command");
  }
}

// The output is made of valid commands, so it can be pasted back to restore it
void dumpConfig(Stream& out) {
  char id[8];
  out.printf("HOST %s\n", HOST_IDS[cfg.host]);
  for (uint8_t s = 0; s < SLOT_COUNT; s++) {
    slotId(s, id);
    out.printf("LABEL %s %s\n", id, cfg.labels[s]);
  }
  for (uint8_t h = 0; h < HOST_COUNT; h++) {
    for (uint8_t s = 0; s < SLOT_COUNT; s++) {
      slotId(s, id);
      out.printf("SET %s %s %s\n", id, HOST_IDS[h], cfg.combos[h][s]);
    }
  }
  out.println("END");
}

void dumpMacroPages(Stream& out) {
  out.printf("MACROS PAGES %u\n", macroPages.count);
  for (uint8_t p = 0; p < macroPages.count; p++) {
    const MacroPageData& page = macroPages.pages[p];
    out.printf("MACRO PAGE %u ", p);
    for (size_t n = 0; page.id[n]; n++) out.printf("%02x", (uint8_t)page.id[n]);
    out.print(" ");
    for (size_t n = 0; page.name[n]; n++) out.printf("%02x", (uint8_t)page.name[n]);
    out.println();
    for (uint8_t slot = 0; slot < PAGE_BUTTON_COUNT; slot++) {
      out.printf("MACRO LABEL %u %u ", p, slot + 1);
      if (page.labels[slot][0]) for (size_t n = 0; page.labels[slot][n]; n++) out.printf("%02x", (uint8_t)page.labels[slot][n]);
      else out.print("-");
      out.println();
      for (uint8_t host = 0; host < HOST_COUNT; host++)
        out.printf("MACRO SET %u %u %s %s\n", p, slot + 1, HOST_IDS[host], page.combos[host][slot]);
    }
  }
  out.println("MACROS END");
}

void handleMacroPagesCommand(Stream& out, char* args) {
  char* action = nextToken(&args);
  if (!action) { out.println("ERR usage: MACROS GET|BEGIN|CLEAR|PAGE|LABEL|SET|VALIDATE|COMMIT"); return; }
  upperInPlace(action);
  if (!strcmp(action, "GET")) { dumpMacroPages(out); return; }
  if (!strcmp(action, "BEGIN")) {
    macroPagesDraft = macroPages;
    macroPagesDraftOpen = true;
    out.println("OK MACROS BEGIN"); return;
  }
  if (!macroPagesDraftOpen) { out.println("ERR MACROS BEGIN required"); return; }
  if (!strcmp(action, "CLEAR")) {
    memset(&macroPagesDraft, 0, sizeof(macroPagesDraft));
    macroPagesDraft.magic = MACRO_PAGES_MAGIC;
    out.println("OK MACROS CLEAR"); return;
  }
  if (!strcmp(action, "PAGE")) {
    char* indexText = nextToken(&args); char* idText = nextToken(&args); char* nameText = nextToken(&args);
    const int index = indexText ? atoi(indexText) : -1;
    if (!idText || !nameText || index != macroPagesDraft.count || index < 0 || index >= MAX_MACRO_PAGES) {
      out.println("ERR invalid shortcut page index"); return;
    }
    MacroPageData& page = macroPagesDraft.pages[index];
    if (!decodeScreenText(idText, page.id, sizeof(page.id)) || !decodeScreenText(nameText, page.name, sizeof(page.name)) ||
        !validMacroPageText(page.id, sizeof(page.id)) || !validMacroPageText(page.name, sizeof(page.name))) {
      out.println("ERR invalid shortcut page name"); return;
    }
    macroPagesDraft.count++;
    out.println("OK MACROS PAGE"); return;
  }
  if (!strcmp(action, "LABEL")) {
    char* pageText = nextToken(&args); char* slotText = nextToken(&args); char* labelText = nextToken(&args);
    int page = pageText ? atoi(pageText) : -1; int slot = slotText ? atoi(slotText) : 0;
    if (!labelText || page < 0 || page >= macroPagesDraft.count || slot < 1 || slot > PAGE_BUTTON_COUNT ||
        !decodeScreenText(labelText, macroPagesDraft.pages[page].labels[slot - 1], 9) ||
        !validMacroPageText(macroPagesDraft.pages[page].labels[slot - 1], 9, true)) {
      out.println("ERR invalid shortcut label"); return;
    }
    out.println("OK MACROS LABEL"); return;
  }
  if (!strcmp(action, "SET")) {
    char* pageText = nextToken(&args); char* slotText = nextToken(&args); char* hostText = nextToken(&args); char* combo = nextToken(&args);
    int page = pageText ? atoi(pageText) : -1; int slot = slotText ? atoi(slotText) : 0;
    int host = -1; if (hostText) { upperInPlace(hostText); host = parseHost(hostText); }
    if (!combo || page < 0 || page >= macroPagesDraft.count || slot < 1 || slot > PAGE_BUTTON_COUNT || host < 0 || host >= HOST_COUNT || strlen(combo) > 23) {
      out.println("ERR invalid shortcut assignment"); return;
    }
    upperInPlace(combo); uint8_t type, mods; uint16_t code;
    if (!parseCombo(combo, &type, &mods, &code)) { out.println("ERR bad combo"); return; }
    strncpy(macroPagesDraft.pages[page].combos[host][slot - 1], combo, 23);
    out.println("OK MACROS SET"); return;
  }
  if (!strcmp(action, "VALIDATE")) {
    macroPagesDraft.magic = MACRO_PAGES_MAGIC;
    out.println(validateMacroPages(macroPagesDraft) ? "OK MACROS VALID" : "ERR invalid shortcut pages"); return;
  }
  if (!strcmp(action, "COMMIT")) {
    macroPagesDraft.magic = MACRO_PAGES_MAGIC;
    if (!validateMacroPages(macroPagesDraft)) { out.println("ERR invalid shortcut pages"); return; }
    macroPages = macroPagesDraft; macroPagesDraftOpen = false;
    if (!saveMacroPagesFile()) { out.println("ERR shortcut page storage failed"); return; }
    out.println("OK MACROS COMMITTED"); return;
  }
  out.println("ERR unknown MACROS command");
}

void handleGameCommand(Stream& out, char* args) {
  char* action = nextToken(&args);
  if (!action) { out.println("ERR usage: GAME START MENU|SNAKE|TTT|PONG|2048|MINESWEEPER|MEMORY|SIMON|LIGHTS_OUT|WHACK | GAME EXIT | GAME STATUS"); return; }
  upperInPlace(action);
  if (!strcmp(action, "EXIT")) {
    exitGameMode();
    out.println("OK GAME EXIT");
    return;
  }
  if (!strcmp(action, "STATUS")) {
    const char* state = "EXIT";
    if (gameScreen == GAME_MENU) state = "MENU";
    else if (gameScreen == GAME_SNAKE) state = "SNAKE";
    else if (gameScreen == GAME_TTT) state = "TTT";
    else if (gameScreen == GAME_PONG) state = "PONG";
    else if (gameScreen == GAME_2048) state = "2048";
    else if (gameScreen == GAME_MINES) state = "MINESWEEPER";
    else if (gameScreen == GAME_MEMORY) state = "MEMORY";
    else if (gameScreen == GAME_SIMON) state = "SIMON";
    else if (gameScreen == GAME_LIGHTS_OUT) state = "LIGHTS_OUT";
    else if (gameScreen == GAME_WHACK) state = "WHACK";
    out.printf("GAME STATE %s\n", state);
    return;
  }
  if (!strcmp(action, "START")) {
    char* selection = nextToken(&args);
    if (!selection) { out.println("ERR usage: GAME START MENU|SNAKE|TTT|PONG|2048|MINESWEEPER|MEMORY|SIMON|LIGHTS_OUT|WHACK"); return; }
    upperInPlace(selection);
    if (!strcmp(selection, "MENU")) {
      enterGameMenu();
      out.println("OK GAME MENU");
    } else if (!strcmp(selection, "SNAKE")) {
      startSnakeGame();
      out.println("OK GAME START SNAKE");
    } else if (!strcmp(selection, "TTT") || !strcmp(selection, "TIC-TAC-TOE")) {
      startTicTacToeGame();
      out.println("OK GAME START TTT");
    } else if (!strcmp(selection, "PONG")) { startPongGame(); out.println("OK GAME START PONG"); }
    else if (!strcmp(selection, "2048")) { start2048Game(); out.println("OK GAME START 2048"); }
    else if (!strcmp(selection, "MINES") || !strcmp(selection, "MINESWEEPER")) { startMinesGame(); out.println("OK GAME START MINESWEEPER"); }
    else if (!strcmp(selection, "MEMORY")) { startMemoryGame(); out.println("OK GAME START MEMORY"); }
    else if (!strcmp(selection, "SIMON")) { startSimonGame(); out.println("OK GAME START SIMON"); }
    else if (!strcmp(selection, "LIGHTS_OUT") || !strcmp(selection, "LIGHTS")) { startLightsGame(); out.println("OK GAME START LIGHTS_OUT"); }
    else if (!strcmp(selection, "WHACK") || !strcmp(selection, "WHACK-A-MOLE")) { startWhackGame(); out.println("OK GAME START WHACK"); }
    else out.println("ERR unknown game; use GAME STATUS for supported states");
    return;
  }
  out.println("ERR usage: GAME START MENU|SNAKE|TTT|PONG|2048|MINESWEEPER|MEMORY|SIMON|LIGHTS_OUT|WHACK | GAME EXIT | GAME STATUS");
}

void handleCommand(Stream& out, char* line) {
  char* p = line;
  char* cmd = nextToken(&p);
  if (!cmd) return;
  upperInPlace(cmd);

  if (!strcmp(cmd, "MACROS")) {
    handleMacroPagesCommand(out, p);
  } else if (!strcmp(cmd, "GAME")) {
    handleGameCommand(out, p);
  } else if (!strcmp(cmd, "SCREEN")) {
    handleScreenCommand(out, p);
  } else if (!strcmp(cmd, "HELLO")) {
    out.println("OK MACROPAD 2");

  } else if (!strcmp(cmd, "GET")) {
    dumpConfig(out);

  } else if (!strcmp(cmd, "SAVE")) {
    saveConfig();
    cfgDirty = false;
    out.println("OK saved");

  } else if (!strcmp(cmd, "RESET")) {
    uint8_t keepHost = cfg.host;
    loadDefaults();
    cfg.host = keepHost;
    rebuildAll();
    saveConfig();
    cfgDirty = false;
    needRedraw = true;
    out.println("OK reset to defaults");

  } else if (!strcmp(cmd, "HOST")) {
    char* o = nextToken(&p);
    int h = -1;
    if (o) { upperInPlace(o); h = parseHost(o); }
    if (h < 0 || h >= HOST_COUNT) {
      out.println("ERR usage: HOST WINDOWS|LINUX|MACOS|OMARCHY");
      return;
    }
    cfg.host = h;
    markDirty();
    needRedraw = true;
    out.println("OK");

  } else if (!strcmp(cmd, "LABEL")) {
    char* s = nextToken(&p);
    int slot = -1;
    if (s) { upperInPlace(s); slot = parseSlot(s); }
    while (*p == ' ' || *p == '\t') p++;
    if (slot < 0 || *p == 0) {
      out.println("ERR usage: LABEL <slot> <text, up to 8 characters>");
      return;
    }
    memset(cfg.labels[slot], 0, 9);
    for (uint8_t i = 0; i < 8 && p[i]; i++) {
      char ch = p[i];
      cfg.labels[slot][i] = (ch >= 32 && ch < 127) ? ch : '?';   // the screen font is ASCII only
    }
    markDirty();
    needRedraw = true;
    out.println("OK");

  } else if (!strcmp(cmd, "SET")) {
    char* s = nextToken(&p);
    char* o = nextToken(&p);
    char* c = nextToken(&p);
    int slot = -1;
    int h = -1;
    if (s) { upperInPlace(s); slot = parseSlot(s); }
    if (o) { upperInPlace(o); h = parseHost(o); }
    if (slot < 0 || h < 0 || !c) {
      out.println("ERR usage: SET <slot> <os|ALL> <combo>");
      return;
    }
    upperInPlace(c);
    uint8_t t, m;
    uint16_t k;
    if (strlen(c) > 23 || !parseCombo(c, &t, &m, &k)) {
      out.println("ERR bad combo");
      return;
    }
    if (h == HOST_ALL) {
      for (uint8_t i = 0; i < HOST_COUNT; i++) applyCombo(i, slot, c);
    } else {
      applyCombo(h, slot, c);
    }
    markDirty();
    out.println("OK");

  } else {
    out.println("ERR unknown command");
  }
}

// ---------- Reading command lines from a serial port ----------
// Screen ITEM lines can carry up to ~2 KB of bitmap hex, so buffers must be large.
char lineBuf[2][2200];
uint16_t lineLen[2] = {0, 0};

void pollStream(Stream& s, uint8_t id) {
  while (s.available()) {
    char c = (char)s.read();
    if (c == '\r' || c == '\n') {
      if (lineLen[id] > 0) {
        lineBuf[id][lineLen[id]] = 0;
        lineLen[id] = 0;
        handleCommand(s, lineBuf[id]);
      }
    } else if (lineLen[id] < sizeof(lineBuf[id]) - 1) {
      lineBuf[id][lineLen[id]++] = c;
    }
  }
}

void setup() {
  Serial.begin(115200);

  for (uint8_t r = 0; r < ROWS; r++) {
    pinMode(rowPins[r], OUTPUT);
    digitalWrite(rowPins[r], LOW);
  }
  for (uint8_t c = 0; c < COLS; c++) {
    pinMode(colPins[c], INPUT_PULLDOWN);
  }

  pinMode(ENC_CLK, INPUT_PULLUP);
  pinMode(ENC_DT, INPUT_PULLUP);
  pinMode(ENC_SW, INPUT_PULLUP);
  delay(20);                                       // let the pull-up settle
  hidEnabled = (digitalRead(ENC_SW) == HIGH);      // knob held at power-up = safe mode

  encState = (digitalRead(ENC_CLK) << 1) | digitalRead(ENC_DT);
  attachInterrupt(digitalPinToInterrupt(ENC_CLK), encoderISR, CHANGE);
  attachInterrupt(digitalPinToInterrupt(ENC_DT), encoderISR, CHANGE);

  prefs.begin("macropad", false);
  // Screen pages + event screens live in SPIFFS when the partition exists;
  // without it they stay in RAM and the legacy NVS blob is used instead.
  // Never format the user's SPIFFS partition on boot. If it cannot be mounted,
  // leave stored screen/event/page data untouched and report it as unavailable.
  screenSpiFs = SPIFFS.begin(false);
  if (!screenSpiFs) Serial.println("SPIFFS unavailable: screen designs will not persist");
  loadConfig();
  loadScreenDesign();
  loadMacroPages();
  currentScreenPage = min((uint8_t)prefs.getUChar("page", 0), (uint8_t)(screenPages.count - 1));

  if (hidEnabled) {
    Keyboard.begin();
    ConsumerControl.begin();
    AppSerial.begin();
    USB.productName("3x3 Macropad");
    USB.begin();
  } else {
    Serial.println("SAFE MODE: USB keyboard is disabled");
  }

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);
  oledOk = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  if (!oledOk) Serial.println("SSD1306 not found, check wiring/address");

  display.setRotation(2);           // flip the screen upside down (180 degrees)
  Serial.println("Ready. Send HELLO or GET");
}

void loop() {
  screenEventLoopId++;
  for (uint8_t r = 0; r < ROWS; r++) {
    dischargeColumns();
    digitalWrite(rowPins[r], HIGH);
    delayMicroseconds(20);          // let the line settle

    for (uint8_t c = 0; c < COLS; c++) {
      bool raw = digitalRead(colPins[c]);
      uint32_t now = millis();

      if (raw != lastRaw[r][c]) {
        lastRaw[r][c] = raw;
        lastChange[r][c] = now;
      } else if (raw != keyState[r][c] && (now - lastChange[r][c]) >= DEBOUNCE_MS) {
        keyState[r][c] = raw;
        onKeyEvent(r * COLS + c + 1, raw);
      }
    }

    digitalWrite(rowPins[r], LOW);
  }

  pollEncoderButton();
  pollEncoderPosition();

  pollStream(Serial, 0);                         // commands from the COM port
  if (hidEnabled) pollStream(AppSerial, 1);      // commands from the USB port (the app)

  if (cfgDirty && (millis() - cfgDirtyAt) > 2000) {
    saveConfig();
    cfgDirty = false;
  }

  pollScreenEvents();                        // non-blocking event screen timer
  if (gameScreen == GAME_SNAKE) updateSnakeGame();
  updateOtherGames();

  if (encMsg[0] != '\0' && (int32_t)(millis() - encMsgUntil) >= 0) {
    encMsg = "";
    needRedraw = true;
  }

  if (needRedraw && oledOk) {
    needRedraw = false;
    drawScreen();
  }
}
