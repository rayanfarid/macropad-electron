#ifndef MACROPAD_SCREEN_LAYOUT_H
#define MACROPAD_SCREEN_LAYOUT_H

#include <stdint.h>
#include <stdbool.h>

enum ScreenBinding : uint8_t {
  SCREEN_STATIC,
  SCREEN_HOST,
  SCREEN_LAST,
  SCREEN_ENCODER,
  SCREEN_HID,
  SCREEN_KEYGRID,
  SCREEN_BITMAP,
  SCREEN_RECT,
  SCREEN_FILL_RECT,
  SCREEN_CIRCLE,
  SCREEN_FILL_CIRCLE,
  SCREEN_LINE
};

enum ScreenAlignment : uint8_t { SCREEN_LEFT, SCREEN_CENTER, SCREEN_RIGHT };

#define MAX_PAGE_BITMAP_BYTES 1024

struct ScreenElement {
  uint8_t x, y, width, height;
  uint8_t size, binding, alignment;
  bool inverse;
  char text[22];
  uint16_t bitmapOffset;
  uint16_t bitmapLength;
};

struct ScreenDesign {
  uint32_t magic;
  uint8_t count;
  ScreenElement elements[8];
  uint16_t bitmapDataLength;
  uint8_t bitmapData[MAX_PAGE_BITMAP_BYTES];
};

// Multi-page store: up to 8 named pages, each with its own ScreenDesign.
struct ScreenPageData { char name[21]; ScreenDesign design; };
struct ScreenPageStore { uint32_t magic; uint8_t count; ScreenPageData pages[8]; };

// OLED event screens: thirteen independent layouts per page — idle,
// SW1..SW9 press, encoder CW/CCW/press. A set mask bit means the event has an
// explicitly stored design; a clear bit falls back to firmware defaults.
#define MAX_EVENT_BITMAP_BYTES 256        // per event design (icons stay small)
#define EVENT_DURATION_STICKY 0xFFFF      // show until another event occurs
#define EVENT_DURATION_HOLD    0xFFFE     // show until the triggering control is released

enum ScreenEventId : uint8_t {
  EV_IDLE = 0, EV_SW1 = 1, EV_SW2, EV_SW3, EV_SW4, EV_SW5,
  EV_SW6, EV_SW7, EV_SW8, EV_SW9, EV_ENCW, EV_ENCCW, EV_ENCP, EV_COUNT
};

struct ScreenEventDesign {
  uint8_t count;
  ScreenElement elements[8];
  uint16_t bitmapDataLength;
  uint8_t bitmapData[MAX_EVENT_BITMAP_BYTES];
};
struct ScreenEventPage { uint16_t mask; ScreenEventDesign designs[EV_COUNT]; };
struct ScreenEventStore {
  uint16_t durationMs;     // milliseconds, or EVENT_DURATION_STICKY / EVENT_DURATION_HOLD
  uint8_t trigger;         // 0 = on press, 1 = on release
  uint8_t reserved[5];
  ScreenEventPage pages[8];
};

#endif
