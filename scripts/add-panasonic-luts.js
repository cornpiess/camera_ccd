// 一次性脚本：从 V-Log-Alchemy 存档目录(fdkevin0/lumix_luts, 松下中国官方 Real-Time LUT Library 快照)
// 下载选定的官方 LUT，生成 LUT-only 中性 Profile 并同步三处清单。
// 用法: node scripts/add-panasonic-luts.js
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPO = "fdkevin0/lumix_luts";
const BRANCH = "main";

// 手工选定的 13 个：跨品类、33/32pt、体积合理；displayName 与 LUT 官方中文名一一对应
const PICKS = [
  { id: "camping-vibe", zh: "露营氛围", short: "露营", accent: "#8FAE8B", cat: "outdoor" },
  { id: "verdant-scenery", zh: "青绿风景", short: "青绿", accent: "#8FAE8B", cat: "outdoor" },
  { id: "dusk-atmosphere", zh: "黄昏氛围", short: "黄昏", accent: "#B49A78", cat: "outdoor" },
  { id: "positive-film", zh: "正片", short: "正片", accent: "#A8987F", cat: "outdoor" },
  { id: "film-vintage", zh: "胶片复古", short: "复古", accent: "#A8987F", cat: "indoor" },
  { id: "bw-old-film", zh: "黑白旧胶片", short: "黑白", accent: "#9A9A9F", cat: "indoor" },
  { id: "food-film", zh: "美食胶片", short: "美食", accent: "#C9A66B", cat: "indoor" },
  { id: "aesthetic-portrait", zh: "唯美人像", short: "唯美", accent: "#C99A8E", cat: "portrait" },
  { id: "snow-portrait", zh: "雪天人像", short: "雪天", accent: "#A9B8C4", cat: "portrait" },
  { id: "healing-light", zh: "治愈光影", short: "治愈", accent: "#C9B9A0", cat: "portrait" },
  { id: "forest-green-cool", zh: "森绿清冷", short: "森绿", accent: "#7F9E8F", cat: "portrait" },
  { id: "y2000", zh: "y2000", short: "Y2K", accent: "#C7A163", cat: "anniversary" },
  { id: "txd-agfaphoto-lebox", zh: "TXD AgfaPhoto LeBox", short: "Agfa", accent: "#B4554D", cat: "anniversary" },
];

const gh = (p) =>
  execSync(`curl -s --max-time 120 "https://api.github.com/repos/${REPO}/contents/${p}" -H "Accept: application/vnd.github.raw"`, { maxBuffer: 64 * 1024 * 1024 });

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, ".tmp-luts.json"), "utf8"));

function neutralProfile(lutName, displayName, short, accent) {
  const band = { hue: 0, saturation: 1, luminance: 1 };
  const hueBands = {};
  for (const k of ["red", "orange", "yellow", "green", "cyan", "blue", "magenta"]) hueBands[k] = { ...band };
  return {
    aperture: { preferred: 4, starZone: 4 },
    ui: { shortName: short, accent, dialStyle: "compact", personality: "soft", markerStyle: "line", labelStyle: "minimal", glassTintStrength: 0.06 },
    raw: { sharpness: 0, detail: 0, localToneMap: 0, luminanceNoiseReduction: 0, colorNoiseReduction: 0 },
    tone: { exposure: 0, contrast: 1, blackPoint: 0, curve: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]], exposureBias: 0 },
    color: { saturation: 1, temperature: 0, tint: 0, hueBands, lut: lutName, lutIntensity: 1 },
    texture: { grain: { amount: 0, size: 0.25 }, vignette: { amount: 0, radius: 0.75 }, halation: { amount: 0, radius: 0.2 } },
  };
}

(async () => {
  // 0. 确认 assets/camera-profiles.json 的格式器就是 JSON.stringify(2)，避免整文件 diff 噪声
  const profilesPath = path.join(ROOT, "assets/camera-profiles.json");
  const doc = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
  const current = fs.readFileSync(profilesPath, "utf8");
  const roundTrip = JSON.stringify(doc, null, 2) + "\n";
  if (roundTrip !== current) {
    // 差异仅可能出现在我上一提交新增的两段（手写缩进），先把它们规范化
    doc.profiles.filter(p => p.id.startsWith("panasonic_")).forEach(p => { /* no-op, just re-serialize */ });
    if (JSON.stringify(doc, null, 2).length !== current.trimEnd().length) {
      console.error("警告: camera-profiles.json 与 JSON.stringify(2) 格式不一致，将以 stringify(2) 重写全文件");
    }
  }

  const mapPath = path.join(ROOT, "Camera18_LUT_V0/profiles-lut-map.json");
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));

  let added = 0;
  for (const pick of PICKS) {
    const profileId = "panasonic_" + pick.id.replace(/-/g, "_");
    const lutName = "panasonic-" + pick.id;
    if (doc.profiles.some(p => p.id === profileId)) { console.log("跳过(已存在):", profileId); continue; }

    // 1. 元数据
    const meta = catalog.luts.find(l => l.id === pick.id);
    if (!meta) throw new Error("catalog 中找不到 " + pick.id);
    const file = meta.files.find(f => (f.format === "cube" || f.type === "cube") && f.variant === "default");
    if (!file) throw new Error(pick.id + " 无 default cube");
    const relPath = "data/" + file.public_path;

    // 2. 下载 .cube 到两处
    for (const dest of [
      path.join(ROOT, "modules/camera-engine/ios/LUTs", lutName + ".cube"),
      path.join(ROOT, "Camera18_LUT_V0/luts", lutName + ".cube"),
    ]) {
      if (!fs.existsSync(dest)) {
        fs.writeFileSync(dest, gh(relPath));
        console.log("下载:", path.basename(dest), Math.round(fs.statSync(dest).size / 1024) + "KB");
      }
    }

    // 3. 生成 Profile（中性底 + LUT-only）
    const p = neutralProfile(lutName, pick.zh, pick.short, pick.accent);
    p.id = profileId;
    p.name = pick.zh;
    p.displayName = pick.zh;
    p.developmentReference = {
      target: `LUT-only profile（其余全中性）。松下中国官方 Real-Time LUT Library「${pick.zh}」by ${meta.author?.name_zh || "?"}，${meta.lut_3d_size}pt cube。输入空间: 标准照片（Lumix Real-Time LUT 预设）。来源快照: github.com/${REPO} (2026-08-24)，SHA256 ${file.sha256.slice(0, 12)}…`,
      lutSource: `https://github.com/${REPO}`,
      lutOrigin: "Panasonic China official Real-Time LUT Library (panasonicshuma.cn)",
      internalTestOnly: true,
    };
    doc.profiles.push(p);

    // 4. LUT map
    map.profiles.push({
      id: profileId,
      displayName: pick.zh,
      lut: `luts/${lutName}.cube`,
      notes: `LUT-only profile (其余全中性)。Panasonic 中国官方 Real-Time LUT Library${pick.cat === "anniversary" ? " 25周年" : ""}「${pick.zh}」by ${meta.author?.name_zh || "?"}。快照: github.com/${REPO} 2026-08-24。仅内部测试使用。`,
    });
    added++;
    console.log("Profile:", profileId, "→", pick.zh);
  }

  if (added > 0) {
    fs.writeFileSync(profilesPath, JSON.stringify(doc, null, 2) + "\n");
    fs.writeFileSync(mapPath, JSON.stringify(map, null, 2) + "\n");

    // 5. prepackage 数量断言
    const checkPath = path.join(ROOT, "scripts/prepackage-check.js");
    const check = fs.readFileSync(checkPath, "utf8");
    const m = check.match(/doc\.profiles\.length === (\d+)/);
    if (m) {
      fs.writeFileSync(checkPath, check.replace(`doc.profiles.length === ${m[1]}`, `doc.profiles.length === ${doc.profiles.length}`));
      console.log(`prepackage 数量断言: ${m[1]} → ${doc.profiles.length}`);
    }
  }
  console.log(`完成: 共 ${doc.profiles.length} 个 Profile, 新增 ${added}`);
})();
