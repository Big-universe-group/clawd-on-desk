// Tray flash icons (#722).
//
// The completion flash blinks the menu bar / taskbar icon between the normal
// icon and a completion mark. macOS uses two natural 18pt Template pairs
// (18×18 plus @2x siblings), so both frames inherit system contrast and occupy
// an identical menu-bar slot. Windows/Linux retain the existing 32px orange
// completion dot.
//
// Windows / Linux trays work in raw pixels and both assets are normalised to
// 32×32 there.

const TRAY_PIXEL_SIZE = 32; // Windows / Linux trays work in pixels

function loadTrayNormalIcon({ nativeImage, platform, templatePath, iconPath }) {
  if (platform === "darwin") {
    const icon = nativeImage.createFromPath(templatePath);
    icon.setTemplateImage(true);
    return icon;
  }
  return nativeImage
    .createFromPath(iconPath)
    .resize({ width: TRAY_PIXEL_SIZE, height: TRAY_PIXEL_SIZE });
}

function loadTrayFlashIcon({ nativeImage, platform, flashPath, flashTemplatePath, fileExists }) {
  const sourcePath = platform === "darwin" ? flashTemplatePath : flashPath;
  if (!sourcePath || !fileExists(sourcePath)) return null;

  const src = nativeImage.createFromPath(sourcePath);
  if (!src || src.isEmpty()) return null;

  if (platform === "darwin") {
    src.setTemplateImage(true);
    return src;
  }
  return src.resize({ width: TRAY_PIXEL_SIZE, height: TRAY_PIXEL_SIZE });
}

// "Rainbow" flash effect: the whole tray icon cycles through these hues.
// 60° steps keep consecutive frames visibly distinct at any flash interval.
const RAINBOW_HUES = Object.freeze([0, 60, 120, 180, 240, 300]);
// Pixels below this HSL saturation (eyes, outlines, highlights) keep their
// colour in hue mode so the icon stays legible.
const HUE_SHIFT_MIN_SATURATION = 0.2;

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// Recolours a premultiplied BGRA bitmap (Electron/Skia N32 layout) into a new
// buffer. `silhouette` paints every visible pixel with the hue — used for the
// monochrome macOS Template icon, whose black glyph has no hue to shift.
// Otherwise saturated pixels take the target hue at their own lightness.
function recolorBitmap(bitmap, hue, { silhouette }) {
  const out = Buffer.from(bitmap);
  const fill = silhouette ? hslToRgb(hue, 1, 0.55) : null;
  for (let i = 0; i + 3 < out.length; i += 4) {
    const a = out[i + 3];
    if (a === 0) continue;
    let rgb = fill;
    if (!rgb) {
      const r = Math.min(1, out[i + 2] / a);
      const g = Math.min(1, out[i + 1] / a);
      const b = Math.min(1, out[i] / a);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      if (s < HUE_SHIFT_MIN_SATURATION) continue;
      rgb = hslToRgb(hue, Math.max(s, 0.75), l);
    }
    out[i + 2] = Math.round((rgb[0] * a) / 255);
    out[i + 1] = Math.round((rgb[1] * a) / 255);
    out[i] = Math.round((rgb[2] * a) / 255);
  }
  return out;
}

// Pixel dimensions of a representation: getSize() reports DIP, toBitmap()
// returns pixels, so prefer DIP×scale and fall back to the DIP size itself.
function resolvePixelSize(bitmap, dipSize, scaleFactor) {
  const candidates = [
    { width: Math.round(dipSize.width * scaleFactor), height: Math.round(dipSize.height * scaleFactor) },
    { width: dipSize.width, height: dipSize.height },
  ];
  return candidates.find((size) => size.width > 0 && size.height > 0
    && size.width * size.height * 4 === bitmap.length) || null;
}

// Builds one non-template frame per hue from the normal tray icon, keeping
// every scale representation (macOS @2x). Returns [] when the icon can't be
// read so callers fall back to the default completion-mark flash.
function buildTrayRainbowFrames({ nativeImage, baseIcon, platform, hues = RAINBOW_HUES }) {
  if (!baseIcon || baseIcon.isEmpty()) return [];
  const scaleFactors = typeof baseIcon.getScaleFactors === "function"
    ? baseIcon.getScaleFactors()
    : [1];
  const reps = [];
  for (const scaleFactor of scaleFactors.length ? scaleFactors : [1]) {
    const bitmap = baseIcon.toBitmap({ scaleFactor });
    const size = resolvePixelSize(bitmap, baseIcon.getSize(scaleFactor), scaleFactor);
    if (size) reps.push({ scaleFactor, bitmap, ...size });
  }
  if (reps.length === 0) return [];

  const silhouette = platform === "darwin";
  const frames = [];
  for (const hue of hues) {
    let frame = null;
    for (const rep of reps) {
      const buffer = recolorBitmap(rep.bitmap, hue, { silhouette });
      const options = { width: rep.width, height: rep.height, scaleFactor: rep.scaleFactor };
      if (!frame) frame = nativeImage.createFromBitmap(buffer, options);
      else frame.addRepresentation({ ...options, buffer });
    }
    if (!frame || frame.isEmpty()) return [];
    frames.push(frame);
  }
  return frames;
}

module.exports = {
  loadTrayNormalIcon,
  loadTrayFlashIcon,
  buildTrayRainbowFrames,
  recolorBitmap,
  RAINBOW_HUES,
  TRAY_PIXEL_SIZE,
};
