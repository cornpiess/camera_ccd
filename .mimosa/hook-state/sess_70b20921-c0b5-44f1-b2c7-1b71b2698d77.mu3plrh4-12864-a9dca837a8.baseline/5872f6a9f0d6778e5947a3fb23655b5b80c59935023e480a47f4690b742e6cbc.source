// Generator for luts/absolute-hero.cube — "Absolute Hero" camera-character LUT.
//
// Direction source: the 像素蛋糕 CameraRecipe 140501「绝对主角」sample icon (vivid glossy
// urban portrait: bright clean exposure, cobalt-dominant blues, luminous warm skin,
// crisp but not crushed blacks). This is an ORIGINAL approximation of that direction —
// the commercial Look data itself was never exported or measured (see 相机模拟分析/README).
//
// The LUT is the last "camera character" layer in CameraDNARenderer (after exposure /
// tone curve / saturation / WB / hue bands), so it stays deliberately gentle — same
// magnitude band as the other V0 LUTs (~0.02–0.03 avg per-channel delta).
//
// Run: node generate-absolute-hero.js   (writes luts/absolute-hero.cube)
'use strict';
const fs = require('fs');
const path = require('path');

const SIZE = 33;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

// Gentle filmic S so blacks stay crisp and highlights get a soft glossy shoulder
// without fighting the JSON tone curve (which already carries the main S).
function baseS(x) {
  return lerp(x, smooth(x), 0.2);
}

// Hue distance in degrees on a circle.
function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

function transform(r, g, b) {
  // 1. Gentle S-contrast
  let R = baseS(r), G = baseS(g), B = baseS(b);

  const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const s0 = rgbToHsl(R, G, B).s;

  // 2. Split tone: clean cool-blue shadows, warm glossy highlight glow
  const wShadow = Math.pow(clamp01(1 - lum), 2.2);
  const wHigh = Math.pow(clamp01(lum), 2.4);
  R += -0.024 * wShadow + 0.028 * wHigh;
  G += -0.007 * wShadow + 0.007 * wHigh;
  B +=  0.036 * wShadow - 0.019 * wHigh;

  // Vibrance: lift muted colors toward the glossy-magazine vividness; saturated
  // colors (already vivid) get almost nothing, so skin stays believable.
  {
    const l2 = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const chroma = 1 + 0.09 * (1 - Math.min(1, s0 * 1.4));
    R = l2 + (R - l2) * chroma;
    G = l2 + (G - l2) * chroma;
    B = l2 + (B - l2) * chroma;
  }

  // 3. Hue-selective micro character
  const { h, s, l } = rgbToHsl(clamp01(R), clamp01(G), clamp01(B));
  if (s > 0.08) {
    // Cobalt/azure boost: the "hero dress" zone — purer, slightly deeper blues
    const wBlue = smooth(Math.max(0, 1 - hueDist(h, 235) / 55));
    if (wBlue > 0) {
      const boost = wBlue * 0.09 * s;
      R -= boost * 0.10;
      G -= boost * 0.04;
      B += boost * 0.14;
    }
    // Skin zone: tiny hue toward peach + luminous lift (transparent, not orange)
    const wSkin = smooth(Math.max(0, 1 - hueDist(h, 28) / 42));
    if (wSkin > 0) {
      R += wSkin * 0.012 * s;
      G += wSkin * 0.005 * s;
      B -= wSkin * 0.006 * s;
    }
    // Reds: slight push so signage/lips pop without clipping toward orange
    const wRed = smooth(Math.max(0, 1 - hueDist(h, 5) / 40));
    if (wRed > 0) {
      R += wRed * 0.014 * s;
      G -= wRed * 0.008 * s;
      B -= wRed * 0.006 * s;
    }
    // Magenta/neon: small vividness assist
    const wMag = smooth(Math.max(0, 1 - hueDist(h, 305) / 45));
    if (wMag > 0) {
      R += wMag * 0.012 * s;
      B += wMag * 0.012 * s;
      G -= wMag * 0.010 * s;
    }
  }

  return [clamp01(R), clamp01(G), clamp01(B)];
}

const lines = [
  'TITLE "Camera18 V0 - Absolute Hero (PixCake 140501 direction, original approximation)"',
  `LUT_3D_SIZE ${SIZE}`,
  'DOMAIN_MIN 0.0 0.0 0.0',
  'DOMAIN_MAX 1.0 1.0 1.0',
  '# Original Camera 18 V0 approximation; input expected normalized display-referred RGB.',
  '# Vivid glossy portrait direction: clean bright mids, cobalt-blue boost, luminous warm skin,',
  '# cool clean shadows, warm highlight glow. Character layer only — tone/texture stay in JSON.',
];

let maxDelta = 0, sumDelta = 0, count = 0;
for (let b = 0; b < SIZE; b++) {
  for (let g = 0; g < SIZE; g++) {
    for (let r = 0; r < SIZE; r++) {
      const [R, G, B] = transform(r / (SIZE - 1), g / (SIZE - 1), b / (SIZE - 1));
      lines.push(`${R.toFixed(6)} ${G.toFixed(6)} ${B.toFixed(6)}`);
      const d = (Math.abs(R - r / (SIZE - 1)) + Math.abs(G - g / (SIZE - 1)) + Math.abs(B - b / (SIZE - 1)));
      maxDelta = Math.max(maxDelta, d); sumDelta += d; count++;
    }
  }
}

const out = path.join(__dirname, 'luts', 'absolute-hero.cube');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${out}`);
console.log(`avg per-channel delta = ${(sumDelta / count / 3).toFixed(4)} (band reference: V0 peers 0.019–0.031)`);
console.log(`max rgb delta sum = ${maxDelta.toFixed(3)} (peers: 0.16–0.36)`);
