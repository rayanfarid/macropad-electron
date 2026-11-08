// 1-bit monochrome image converter for SSD1306 (128x64 OLED)

const SCREEN_WIDTH = 128;
const SCREEN_HEIGHT = 64;

function hexToBitmap(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})*$/i.test(hex)) {
    throw new Error("Invalid hex string for bitmap");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bitmapToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function packBitsToBitmap(bits, width, height) {
  const bytesPerRow = Math.ceil(width / 8);
  const buffer = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bits[y * width + x]) {
        const byteIndex = y * bytesPerRow + (x >> 3);
        const bitIndex = 7 - (x & 7);
        buffer[byteIndex] |= (1 << bitIndex);
      }
    }
  }
  return buffer;
}

function unpackBitmapToBits(bytes, width, height) {
  const bytesPerRow = Math.ceil(width / 8);
  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byteIndex = y * bytesPerRow + (x >> 3);
      const bitIndex = 7 - (x & 7);
      if (bytes[byteIndex] & (1 << bitIndex)) {
        bits[y * width + x] = 1;
      }
    }
  }
  return bits;
}

function rgbaToGrayscale(rgba, width, height) {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (a < 128) {
      // Treat transparent pixels as black/background
      gray[i] = 0;
    } else {
      const alphaFactor = a / 255;
      gray[i] = (0.299 * r + 0.587 * g + 0.114 * b) * alphaFactor;
    }
  }
  return gray;
}

function convertRgbaToMonochromeBitmap(rgba, width, height, options = {}) {
  if (!rgba || width <= 0 || height <= 0) {
    throw new Error("Invalid image buffer or dimensions");
  }
  const threshold = typeof options.threshold === "number" ? Math.max(0, Math.min(255, options.threshold)) : 128;
  const ditherMode = String(options.dither || options.mode || "threshold").toLowerCase().replace(/[\s_-]+/g, "");
  const invert = Boolean(options.invert || options.inverse);

  const gray = rgbaToGrayscale(rgba, width, height);
  const bits = new Uint8Array(width * height);

  if (ditherMode === "floydsteinberg") {
    // Floyd-Steinberg dithering: 7/16 right, 3/16 down-left, 5/16 down, 1/16 down-right
    const errors = new Float32Array(gray);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const current = errors[idx];
        const bit = current >= threshold ? 1 : 0;
        bits[idx] = bit;
        const targetVal = bit ? 255 : 0;
        const err = current - targetVal;

        if (x + 1 < width) errors[idx + 1] += (err * 7) / 16;
        if (y + 1 < height) {
          if (x - 1 >= 0) errors[(y + 1) * width + (x - 1)] += (err * 3) / 16;
          errors[(y + 1) * width + x] += (err * 5) / 16;
          if (x + 1 < width) errors[(y + 1) * width + (x + 1)] += (err * 1) / 16;
        }
      }
    }
  } else if (ditherMode === "atkinson") {
    // Atkinson dithering: 1/8 each to 6 neighbors (diffusing 6/8 of error)
    const errors = new Float32Array(gray);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const current = errors[idx];
        const bit = current >= threshold ? 1 : 0;
        bits[idx] = bit;
        const targetVal = bit ? 255 : 0;
        const err = (current - targetVal) / 8;

        if (x + 1 < width) errors[idx + 1] += err;
        if (x + 2 < width) errors[idx + 2] += err;
        if (y + 1 < height) {
          if (x - 1 >= 0) errors[(y + 1) * width + (x - 1)] += err;
          errors[(y + 1) * width + x] += err;
          if (x + 1 < width) errors[(y + 1) * width + (x + 1)] += err;
        }
        if (y + 2 < height) {
          errors[(y + 2) * width + x] += err;
        }
      }
    }
  } else if (ditherMode === "none" || ditherMode === "nodithering") {
    for (let i = 0; i < width * height; i++) {
      bits[i] = gray[i] >= 128 ? 1 : 0;
    }
  } else {
    // Default to Threshold
    for (let i = 0; i < width * height; i++) {
      bits[i] = gray[i] >= threshold ? 1 : 0;
    }
  }

  if (invert) {
    for (let i = 0; i < width * height; i++) {
      bits[i] = bits[i] ? 0 : 1;
    }
  }

  const bitmap = packBitsToBitmap(bits, width, height);
  const hex = bitmapToHex(bitmap);

  return {
    width,
    height,
    bitmap,
    hex,
    byteLength: bitmap.length,
    bits
  };
}

// Sizing calculation helper
function calculateFittedDimensions(srcW, srcH, mode, maxWidth = SCREEN_WIDTH, maxHeight = SCREEN_HEIGHT) {
  if (!srcW || !srcH) return { width: maxWidth, height: maxHeight };
  const safeSrcW = Math.max(1, srcW);
  const safeSrcH = Math.max(1, srcH);

  switch (mode) {
    case "original": {
      const w = Math.min(safeSrcW, maxWidth);
      const h = Math.min(safeSrcH, maxHeight);
      return { width: Math.max(1, w), height: Math.max(1, h) };
    }
    case "fit-screen":
    case "fit": {
      const scale = Math.min(maxWidth / safeSrcW, maxHeight / safeSrcH);
      return {
        width: Math.max(1, Math.min(maxWidth, Math.round(safeSrcW * scale))),
        height: Math.max(1, Math.min(maxHeight, Math.round(safeSrcH * scale)))
      };
    }
    case "fill-screen":
    case "fill": {
      return { width: maxWidth, height: maxHeight };
    }
    case "fit-width": {
      const scale = maxWidth / safeSrcW;
      return {
        width: maxWidth,
        height: Math.max(1, Math.min(maxHeight, Math.round(safeSrcH * scale)))
      };
    }
    case "fit-height": {
      const scale = maxHeight / safeSrcH;
      return {
        width: Math.max(1, Math.min(maxWidth, Math.round(safeSrcW * scale))),
        height: maxHeight
      };
    }
    case "custom":
    default:
      return { width: Math.min(maxWidth, safeSrcW), height: Math.min(maxHeight, safeSrcH) };
  }
}

// Software bilinear resize and crop for Node.js / offline use
function cropAndScaleRgba(srcRgba, srcW, srcH, { cropX = 0, cropY = 0, cropW = srcW, cropH = srcH, targetW, targetH, rotation = 0 }) {
  const safeCropX = Math.max(0, Math.min(srcW - 1, cropX));
  const safeCropY = Math.max(0, Math.min(srcH - 1, cropY));
  const safeCropW = Math.max(1, Math.min(srcW - safeCropX, cropW));
  const safeCropH = Math.max(1, Math.min(srcH - safeCropY, cropH));
  const outW = Math.max(1, Math.min(SCREEN_WIDTH, targetW || safeCropW));
  const outH = Math.max(1, Math.min(SCREEN_HEIGHT, targetH || safeCropH));

  // Handle rotation: 0, 90, 180, 270
  const rot = ((rotation % 360) + 360) % 360;

  const croppedRgba = new Uint8Array(outW * outH * 4);
  const xRatio = safeCropW / outW;
  const yRatio = safeCropH / outH;

  for (let destY = 0; destY < outH; destY++) {
    for (let destX = 0; destX < outW; destX++) {
      // Map to rotated coordinates
      let rx = destX;
      let ry = destY;
      if (rot === 90) {
        rx = destY;
        ry = outW - 1 - destX;
      } else if (rot === 180) {
        rx = outW - 1 - destX;
        ry = outH - 1 - destY;
      } else if (rot === 270) {
        rx = outH - 1 - destY;
        ry = destX;
      }

      const srcPixelX = safeCropX + Math.min(safeCropW - 1, Math.floor(destX * xRatio));
      const srcPixelY = safeCropY + Math.min(safeCropH - 1, Math.floor(destY * yRatio));
      const srcIdx = (srcPixelY * srcW + srcPixelX) * 4;
      const destIdx = (destY * outW + destX) * 4;

      croppedRgba[destIdx] = srcRgba[srcIdx];
      croppedRgba[destIdx + 1] = srcRgba[srcIdx + 1];
      croppedRgba[destIdx + 2] = srcRgba[srcIdx + 2];
      croppedRgba[destIdx + 3] = srcRgba[srcIdx + 3];
    }
  }

  return { rgba: croppedRgba, width: outW, height: outH };
}

module.exports = {
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  hexToBitmap,
  bitmapToHex,
  packBitsToBitmap,
  unpackBitmapToBits,
  rgbaToGrayscale,
  convertRgbaToMonochromeBitmap,
  calculateFittedDimensions,
  cropAndScaleRgba
};
