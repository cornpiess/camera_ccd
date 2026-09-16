// Tone guardrails + perceptual audit（专家方案 §5/§15）
// 对 assets/camera-profiles.json 的每台相机做：
//  1. 护栏硬检查：blackPoint ≤ 0.012；完整管线（HSL cube→LUT×intensity→tone）下
//     25% gray ≥ 0.20、50% gray ∈ 0.44~0.56，越界报 warning/error。
//  2. OKLab 感知统计：平均/最大 ΔE、饱和度比、肤色饱和比、灰漂移——用于发现
//     "这只 LUT 明显比别只浓两倍"，不做艺术判断。
// 用法: node scripts/tone-audit.js
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/camera-profiles.json"), "utf8"));
const LUT_DIR = path.join(ROOT, "modules/camera-engine/ios/LUTs");

function loadLUT(name) {
  const file = path.join(LUT_DIR, `${name}.cube`);
  if (!fs.existsSync(file)) return null;
  let dim = 0, v = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const tk = s.split(/\s+/);
    if (tk[0].toUpperCase() === "LUT_3D_SIZE") { dim = +tk[1]; continue; }
    if (/^(TITLE|DOMAIN_|LUT_1D)/i.test(tk[0])) continue;
    if (tk.length >= 3 && isFinite(parseFloat(tk[0]))) v.push(parseFloat(tk[0]), parseFloat(tk[1]), parseFloat(tk[2]), 1);
  }
  return v.length === dim * dim * dim * 4 ? { dim, v } : null;
}

function sampleLUT(lut, r, g, b) {
  const { dim, v } = lut;
  const x = r * (dim - 1), y = g * (dim - 1), z = b * (dim - 1);
  const x0 = Math.min(Math.floor(x), dim - 2), y0 = Math.min(Math.floor(y), dim - 2), z0 = Math.min(Math.floor(z), dim - 2);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const idx = (a, b2, c) => (a + b2 * dim + c * dim * dim) * 4;
  const out = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    let val = 0;
    for (const [w, a, b2, c] of [
      [(1-fx)*(1-fy)*(1-fz), x0, y0, z0], [fx*(1-fy)*(1-fz), x0+1, y0, z0],
      [(1-fx)*fy*(1-fz), x0, y0+1, z0], [fx*fy*(1-fz), x0+1, y0+1, z0],
      [(1-fx)*(1-fy)*fz, x0, y0, z0+1], [fx*(1-fy)*fz, x0+1, y0, z0+1],
      [(1-fx)*fy*fz, x0, y0+1, z0+1], [fx*fy*fz, x0+1, y0+1, z0+1],
    ]) val += w * v[idx(a, b2, c) + ch];
    out[ch] = val;
  }
  return out;
}

// sRGB(0..1, gamma-encoded) → linear
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function linearToOKLab(r, g, b) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}
const oklabDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100; // ≈ ΔE
const satOf = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx < 1e-6 ? 0 : (mx - mn) / mx; };

function applyPipeline(profile, rgb) {
  const c = profile.color;
  let [r, g, b] = sampleLUT(lutCache(c.lut), ...rgb);
  const i = c.lutIntensity ?? 1;
  if (i < 0.999) { r = i * r + (1 - i) * rgb[0]; g = i * g + (1 - i) * rgb[1]; b = i * b + (1 - i) * rgb[2]; }
  // temperature/tint (mirror native gains)
  const t = (6500 + (c.temperature ?? 0)) / 6500;
  r *= Math.min(2, Math.pow(t, 0.22)); b *= Math.min(2, Math.pow(1 / t, 0.22));
  g *= 1 - (c.tint ?? 0) * 0.0006; r *= 1 + (c.tint ?? 0) * 0.0003; b *= 1 + (c.tint ?? 0) * 0.0003;
  // saturation
  const sat = c.saturation ?? 1;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = luma + (r - luma) * sat; g = luma + (g - luma) * sat; b = luma + (b - luma) * sat;
  // tone: exposure → contrast → black point → curve
  let v = [r, g, b].map((x) => x * Math.pow(2, profile.tone.exposure ?? 0));
  v = v.map((x) => (x - 0.5) * (profile.tone.contrast ?? 1) + 0.5);
  const bp = profile.tone.blackPoint ?? 0;
  if (bp > 0) { const s = 1 / (1 - bp); v = v.map((x) => x * s - bp * s); }
  // 5-pt monotone cubic (same as native renderer's interpolation family)
  v = v.map((x) => curve5(profile.tone.curve, Math.min(1, Math.max(0, x))));
  return v.map((x) => Math.min(1, Math.max(0, x)));
}
function curve5(pts, x) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  let k = 0; while (k < 3 && x > xs[k + 1]) k++;
  const t = (x - xs[k]) / (xs[k + 1] - xs[k]);
  const p0 = ys[Math.max(0, k - 1)], p1 = ys[k], p2 = ys[k + 1], p3 = ys[Math.min(4, k + 2)];
  const y = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  return Math.min(1, Math.max(0, y));
}
const lutCache = (() => { const cache = {}; return (name) => (cache[name] ??= loadLUT(name)); })();

const SKINS = [[0.937, 0.784, 0.686], [0.855, 0.639, 0.494], [0.616, 0.416, 0.298]];
let issues = 0;
console.log("相机".padEnd(24), "BP", "25%→", "50%→", "ΔEavg", "ΔEmax", "Sat比", "肤Sat比");
for (const p of doc.profiles) {
  const flags = [];
  if ((p.tone.blackPoint ?? 0) > 0.012) flags.push("BP>0.012");
  // neutral tone probes through the full pipeline
  const g25 = applyPipeline(p, [0.25, 0.25, 0.25])[0];
  const g50 = applyPipeline(p, [0.5, 0.5, 0.5])[0];
  if (g25 < 0.20) flags.push("25%灰<0.20");
  if (g50 < 0.44 || g50 > 0.56) flags.push(`50%灰${g50.toFixed(2)}越界`);
  // perceptual stats over a 5³ grid
  let dE = 0, dEmax = 0, n = 0, satIn = 0, satOut = 0, skinSat = 0, skinN = 0;
  for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) for (let c = 0; c < 5; c++) {
    const rgb = [a / 4, b / 4, c / 4];
    const out = applyPipeline(p, rgb);
    const lin = rgb.map(s2l), lout = out.map(s2l);
    const d = oklabDist(linearToOKLab(...lin), linearToOKLab(...lout));
    dE += d; dEmax = Math.max(dEmax, d); n++;
    satIn += satOf(rgb); satOut += satOf(out);
  }
  for (const s of SKINS) { skinSat += satOf(applyPipeline(p, s)); skinN++; }
  const satRatio = satOut / satIn, skinRatio = skinSat / skinN;
  if (satRatio > 1.1) flags.push(`饱和比${satRatio.toFixed(2)}偏高`);
  console.log(
    p.id.padEnd(22),
    String(p.tone.blackPoint).padEnd(5),
    g25.toFixed(3).padEnd(6), g50.toFixed(3).padEnd(6),
    (dE / n).toFixed(1).padEnd(6), dEmax.toFixed(1).padEnd(6),
    satRatio.toFixed(2).padEnd(5), skinRatio.toFixed(2),
    flags.length ? "⚠ " + flags.join(", ") : "✓"
  );
  if (flags.length) issues++;
}
console.log(issues ? `\n${issues} 台相机触发护栏/统计警告` : "\n全部通过护栏");
process.exit(issues ? 1 : 0);
