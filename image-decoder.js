// Image decoder for PNG, JPEG, BMP, and WebP buffers
const zlib = require("zlib");
const { execFileSync } = require("child_process");

function tryElectronDecode(buffer) {
  try {
    const electron = require("electron");
    if (electron?.nativeImage) {
      const img = electron.nativeImage.createFromBuffer(buffer);
      if (!img.isEmpty()) {
        const size = img.getSize();
        const bmp = img.toBitmap(); // BGRA
        const rgba = new Uint8Array(bmp.length);
        for (let i = 0; i < bmp.length; i += 4) {
          rgba[i] = bmp[i + 2];
          rgba[i + 1] = bmp[i + 1];
          rgba[i + 2] = bmp[i];
          rgba[i + 3] = bmp[i + 3];
        }
        return { width: size.width, height: size.height, data: rgba };
      }
    }
  } catch {}
  return null;
}

function tryMagickDecode(buffer, formatHint) {
  try {
    const prefix = formatHint ? `${formatHint}:-` : "-";
    const info = execFileSync("magick", ["identify", "-format", "%w %h", prefix], { input: buffer }).toString().trim().split(" ");
    const width = parseInt(info[0], 10);
    const height = parseInt(info[1], 10);
    const raw = execFileSync("magick", [prefix, "-depth", "8", "rgba:-"], { input: buffer });
    if (width > 0 && height > 0 && raw.length === width * height * 4) {
      return { width, height, data: new Uint8Array(raw) };
    }
  } catch {}
  return null;
}

function decodePng(buffer) {
  if (!buffer || buffer.length < 8) throw new Error("Invalid PNG: buffer too small");
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    throw new Error("Invalid PNG signature");
  }

  // 1. Try electron nativeImage
  const electronResult = tryElectronDecode(buffer);
  if (electronResult) return electronResult;

  // 2. Pure JS decoding
  try {
    let pos = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idatChunks = [];

    while (pos < buffer.length) {
      if (pos + 8 > buffer.length) break;
      const length = buffer.readUInt32BE(pos);
      const type = buffer.toString("ascii", pos + 4, pos + 8);
      const chunkData = buffer.slice(pos + 8, pos + 8 + length);
      pos += 12 + length;

      if (type === "IHDR") {
        width = chunkData.readUInt32BE(0);
        height = chunkData.readUInt32BE(4);
        bitDepth = chunkData[8];
        colorType = chunkData[9];
      } else if (type === "IDAT") {
        idatChunks.push(chunkData);
      } else if (type === "IEND") {
        break;
      }
    }

    if (!width || !height) throw new Error("Missing PNG IHDR");

    // Standard 8-bit channels
    if (bitDepth === 8 && [0, 2, 4, 6].includes(colorType)) {
      const compressed = Buffer.concat(idatChunks);
      const decompressed = zlib.inflateSync(compressed);

      let bpp = 4;
      if (colorType === 0) bpp = 1;
      else if (colorType === 2) bpp = 3;
      else if (colorType === 4) bpp = 2;
      else if (colorType === 6) bpp = 4;

      const scanlineLength = width * bpp;
      const rawRgba = new Uint8Array(width * height * 4);
      let inPos = 0;
      const prevLine = new Uint8Array(scanlineLength);
      const curLine = new Uint8Array(scanlineLength);

      for (let y = 0; y < height; y++) {
        const filterType = decompressed[inPos++];
        for (let i = 0; i < scanlineLength; i++) {
          const x = decompressed[inPos++];
          const a = i >= bpp ? curLine[i - bpp] : 0;
          const b = prevLine[i];
          const c = i >= bpp ? prevLine[i - bpp] : 0;
          let val = 0;
          switch (filterType) {
            case 0: val = x; break;
            case 1: val = (x + a) & 0xff; break;
            case 2: val = (x + b) & 0xff; break;
            case 3: val = (x + Math.floor((a + b) / 2)) & 0xff; break;
            case 4: {
              const p = a + b - c;
              const pa = Math.abs(p - a);
              const pb = Math.abs(p - b);
              const pc = Math.abs(p - c);
              const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
              val = (x + pr) & 0xff;
              break;
            }
            default: throw new Error(`Unknown PNG filter: ${filterType}`);
          }
          curLine[i] = val;
        }

        for (let x = 0; x < width; x++) {
          const outIdx = (y * width + x) * 4;
          if (colorType === 6) {
            rawRgba[outIdx] = curLine[x * 4];
            rawRgba[outIdx + 1] = curLine[x * 4 + 1];
            rawRgba[outIdx + 2] = curLine[x * 4 + 2];
            rawRgba[outIdx + 3] = curLine[x * 4 + 3];
          } else if (colorType === 2) {
            rawRgba[outIdx] = curLine[x * 3];
            rawRgba[outIdx + 1] = curLine[x * 3 + 1];
            rawRgba[outIdx + 2] = curLine[x * 3 + 2];
            rawRgba[outIdx + 3] = 255;
          } else if (colorType === 0) {
            const g = curLine[x];
            rawRgba[outIdx] = g;
            rawRgba[outIdx + 1] = g;
            rawRgba[outIdx + 2] = g;
            rawRgba[outIdx + 3] = 255;
          } else if (colorType === 4) {
            const g = curLine[x * 2];
            rawRgba[outIdx] = g;
            rawRgba[outIdx + 1] = g;
            rawRgba[outIdx + 2] = g;
            rawRgba[outIdx + 3] = curLine[x * 2 + 1];
          }
        }
        prevLine.set(curLine);
      }
      return { width, height, data: rawRgba };
    }
  } catch {}

  // 3. Fallback to ImageMagick if available
  const magickResult = tryMagickDecode(buffer, "png");
  if (magickResult) return magickResult;

  throw new Error("Could not decode PNG image");
}

function decodeBmp(buffer) {
  if (!buffer || buffer.length < 54) throw new Error("Invalid BMP: buffer too small");
  if (buffer[0] !== 0x42 || buffer[1] !== 0x4d) throw new Error("Invalid BMP signature");

  const electronResult = tryElectronDecode(buffer);
  if (electronResult) return electronResult;

  try {
    const pixelOffset = buffer.readUInt32LE(10);
    const width = buffer.readInt32LE(18);
    const rawHeight = buffer.readInt32LE(22);
    const bpp = buffer.readUInt16LE(28);
    const compression = buffer.readUInt32LE(30);

    if ((compression === 0 || compression === 3) && (bpp === 24 || bpp === 32)) {
      const height = Math.abs(rawHeight);
      const bottomUp = rawHeight > 0;
      const rawRgba = new Uint8Array(width * height * 4);
      const bytesPerPixel = bpp / 8;
      const rowStride = Math.floor((bpp * width + 31) / 32) * 4;

      for (let y = 0; y < height; y++) {
        const srcRow = bottomUp ? (height - 1 - y) : y;
        const rowOffset = pixelOffset + srcRow * rowStride;
        for (let x = 0; x < width; x++) {
          const pxOffset = rowOffset + x * bytesPerPixel;
          const b = buffer[pxOffset];
          const g = buffer[pxOffset + 1];
          const r = buffer[pxOffset + 2];
          const a = bytesPerPixel === 4 ? buffer[pxOffset + 3] : 255;

          const outIdx = (y * width + x) * 4;
          rawRgba[outIdx] = r;
          rawRgba[outIdx + 1] = g;
          rawRgba[outIdx + 2] = b;
          rawRgba[outIdx + 3] = a;
        }
      }
      return { width, height, data: rawRgba };
    }
  } catch {}

  const magickResult = tryMagickDecode(buffer, "bmp");
  if (magickResult) return magickResult;

  throw new Error("Could not decode BMP image");
}

function decodeJpeg(buffer) {
  if (!buffer || buffer.length < 4) throw new Error("Invalid JPEG: buffer too small");
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error("Invalid JPEG signature");

  const electronResult = tryElectronDecode(buffer);
  if (electronResult) return electronResult;

  const magickResult = tryMagickDecode(buffer, "jpg");
  if (magickResult) return magickResult;

  throw new Error("Could not decode JPEG image");
}

function decodeImage(buffer) {
  if (!buffer || buffer.length < 4) throw new Error("Image buffer too small");
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return decodePng(buffer);
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return decodeJpeg(buffer);
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return decodeBmp(buffer);
  }
  const electronResult = tryElectronDecode(buffer);
  if (electronResult) return electronResult;
  const magickResult = tryMagickDecode(buffer);
  if (magickResult) return magickResult;

  throw new Error("Unsupported image format. Use PNG, JPEG, BMP, or WebP.");
}

module.exports = {
  decodePng,
  decodeBmp,
  decodeJpeg,
  decodeImage
};
