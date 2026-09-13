// 一次性脚本（专家方案 §1/§6/§7-12）：把 camera-profiles.json 收敛为 6 款核心相机，
// 参数取专家提供的精确 JSON；保留 ui 段与 LUT 文件映射。备份写入 .backup-51/。
// 用法: node scripts/converge-six-cameras.js
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

// 专家参数（逐字采用，含 lutIntensity 起点值）
const SIX = [
  {
    id: "ricoh_positive", name: "Ricoh Positive", displayName: "Ricoh Positive",
    ui: { shortName: "RIC", accent: "#C7AFA0", dialStyle: "snap", personality: "crisp", markerStyle: "line", labelStyle: "minimal", glassTintStrength: 0.06 },
    json: require("./six-cameras/ricoh-positive.json"),
  },
  {
    id: "ricoh_negative", name: "Ricoh Negative", displayName: "Ricoh Negative",
    ui: { shortName: "NEG", accent: "#9FB4C4", dialStyle: "compact", personality: "soft", markerStyle: "dot", labelStyle: "minimal", glassTintStrength: 0.06 },
    json: require("./six-cameras/ricoh-negative.json"),
  },
  {
    id: "canon_portrait", name: "Canon Portrait", displayName: "Canon Portrait",
    ui: { shortName: "POR", accent: "#D9B98A", dialStyle: "compact", personality: "soft", markerStyle: "dot", labelStyle: "minimal", glassTintStrength: 0.06 },
    json: require("./six-cameras/canon-portrait.json"),
  },
  {
    id: "fuji_classic_chrome", name: "Fujifilm Classic Chrome", displayName: "Fujifilm Classic Chrome",
    ui: { shortName: "FCC", accent: "#A8A8A0", dialStyle: "knurled", personality: "nostalgic", markerStyle: "line", labelStyle: "minimal", glassTintStrength: 0.06 },
    json: require("./six-cameras/fuji-classic-chrome.json"),
  },
  {
    id: "fuji_classic_negative", name: "Fujifilm Classic Negative", displayName: "Fujifilm Classic Negative",
    ui: { shortName: "FCN", accent: "#97A06A", dialStyle: "knurled", personality: "nostalgic", markerStyle: "line", labelStyle: "minimal", glassTintStrength: 0.06 },
    json: require("./six-cameras/fuji-classic-negative.json"),
  },
  {
    id: "leica_m9", name: "Leica M9", displayName: "Leica M9",
    ui: { shortName: "M9", accent: "#B4554D", dialStyle: "snap", personality: "crisp", markerStyle: "line", labelStyle: "minimal", glassTintStrength: 0.06 },
    json: require("./six-cameras/leica-m9.json"),
  },
];

// 专家 JSON 的 color.lut 值 → 实际 .cube 资产名（canon-portrait 复用 G7X II 标定）
const LUT_ALIAS = { "canon-portrait": "canon-g7x2" };

const profilesPath = path.join(ROOT, "assets/camera-profiles.json");
const mapPath = path.join(ROOT, "Camera18_LUT_V0/profiles-lut-map.json");
const doc = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
const oldMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));

// 备份当前 51 台
const backupDir = path.join(ROOT, ".backup-51-profiles");
fs.mkdirSync(backupDir, { recursive: true });
fs.writeFileSync(path.join(backupDir, "camera-profiles.json"), fs.readFileSync(profilesPath));
fs.writeFileSync(path.join(backupDir, "profiles-lut-map.json"), fs.readFileSync(mapPath));

const developmentReference = {
  note: "Expert-calibrated six-camera core (2026-09-13): Camera Character over Heavy Filter. Full-parameter JSON available; tone guardrails enforced by scripts/tone-audit.js.",
  calibration: "expert-provided initial parameters",
};

const profiles = SIX.map((entry) => {
  const p = JSON.parse(JSON.stringify(entry.json));
  p.id = entry.id;
  p.name = entry.name;
  p.displayName = entry.displayName;
  p.ui = entry.ui;
  // LUT 别名：专家给的 canon-portrait 用现有 G7X II 标定 cube
  p.color.lut = LUT_ALIAS[p.color.lut] ?? p.color.lut;
  p.developmentReference = developmentReference;
  return p;
});

doc.profiles = profiles;
fs.writeFileSync(profilesPath, JSON.stringify(doc, null, 2) + "\n");

const wantedLuts = new Set(profiles.map((p) => `luts/${p.color.lut}.cube`));
fs.writeFileSync(mapPath, JSON.stringify({
  schemaVersion: 1,
  lutVersion: "Camera18-V1-six",
  warning: "Six-camera expert core. Superseded 51-profile catalog archived in .backup-51-profiles/.",
  profiles: oldMap.profiles.filter((m) => wantedLuts.has(m.lut)),
}, null, 2) + "\n");

// prepackage 数量断言 → 6
const checkPath = path.join(ROOT, "scripts/prepackage-check.js");
const check = fs.readFileSync(checkPath, "utf8");
const m = check.match(/doc\.profiles\.length === (\d+)/);
if (m && Number(m[1]) !== 6) {
  fs.writeFileSync(checkPath, check.replace(`doc.profiles.length === ${m[1]}`, "doc.profiles.length === 6"));
}
console.log("收敛完成:", profiles.map((p) => p.id + "(lut=" + p.color.lut + ",i=" + p.color.lutIntensity + ")").join("\n  "));
console.log("prepackage 断言 → 6");
