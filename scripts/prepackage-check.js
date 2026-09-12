/**
 * 打包门槛检查（npm run prepackage）
 *
 * 任何出包（TestFlight / Dev Build）之前必须全绿。对应标准文档见 TESTING.md。
 * 覆盖历史上真实踩过的坑：
 *  - 黑屏（原生模块未注册 / bundle 缺失）
 *  - CI Swift 编译失败（本地无 Xcode，只能静态自查 + CI 把关）
 *  - LUT / Profile JSON 损坏（tone.curve 必须 5 点）
 *  - autolinking 漏掉本地模块（podspecPath 事故）
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failed = false;

function step(name, fn) {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    const ok = fn();
    if (ok === false) {
      failed = true;
      console.log(`✗ ${name}`);
    } else {
      console.log(`✓ ${name}`);
    }
  } catch (error) {
    failed = true;
    console.log(`✗ ${name}\n  ${error && error.message ? error.message : String(error)}`);
  }
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    ...opts,
  });
  return {
    code: result.status,
    stdout: `${result.stdout || ''}`,
    stderr: `${result.stderr || ''}`,
  };
}

function must(cond, message) {
  if (!cond) throw new Error(message);
}

// 1. typecheck + lint + doctor（AGENTS 第 3 节）
step('npm run verify（typecheck + lint + doctor）', () => {
  const r = run('npm', ['run', 'verify'], { timeout: 600000 });
  must(r.code === 0, `verify 失败:\n${r.stdout}\n${r.stderr}`);
  must(r.stdout.includes('20/20 checks passed'), 'doctor 未达到 20/20');
});

// 2. iOS 离线导出 + 模块数基线
step('expo export（bundle 完整性 + 模块数基线）', () => {
  const r = run('npx', ['expo', 'export', '--platform', 'ios', '--output-dir', 'dist-check'], { timeout: 600000 });
  must(r.code === 0, `export 失败:\n${r.stdout}\n${r.stderr}`);
  const match = (r.stdout + r.stderr).match(/\((\d+) modules\)/);
  must(match, '未解析到模块数');
  const modules = Number(match[1]);
  must(modules >= 619, `模块数 ${modules} 低于基线 619（有文件被误删或未进 bundle）`);
  console.log(`   modules = ${modules}`);
  fs.rmSync(path.join(ROOT, 'dist-check'), { recursive: true, force: true });
});

// 3. Swift 括号/字符串配平（本机无 swiftc 的替代静态检查）
step('Swift 括号配平', () => {
  const files = ['modules/camera-engine/ios/CameraEngineModule.swift'];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = text.split('\n');
    let depth = 0;
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (inBlockComment) {
        const end = line.indexOf('*/');
        if (end === -1) continue;
        line = line.slice(end + 2);
        inBlockComment = false;
      }
      line = line.replace(/"(?:[^"\\]|\\.)*"/g, 'S');
      const blockStart = line.indexOf('/*');
      if (blockStart !== -1) {
        line = line.slice(0, blockStart);
        if (line.indexOf('*/') === -1) inBlockComment = true;
      }
      const lineComment = line.indexOf('//');
      if (lineComment !== -1) line = line.slice(0, lineComment);
      for (const ch of line) {
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth < 0) throw new Error(`${rel}:${i + 1} 括号不平衡`);
        }
      }
    }
    must(depth === 0, `${rel} 括号不平衡（depth=${depth}）`);
  }
});

// 4. autolinking 必须发现 camera-engine（podspecPath 事故回归）
step('expo-modules-autolinking 发现 camera-engine', () => {
  const r = run('npx', ['expo-modules-autolinking', 'resolve', '--platform', 'ios', '--project-root', '.'], { timeout: 300000 });
  must(r.code === 0, `autolinking resolve 失败:\n${r.stdout}\n${r.stderr}`);
  const output = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '');
  must(output.includes('CameraEngineModule'), 'autolinking 未发现 CameraEngineModule——原生模块将无法注册（黑屏回归）');
});

// 5. Profile JSON 与 LUT 一致性
step('camera-profiles.json 与 LUT 资源', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/camera-profiles.json'), 'utf8'));
  must(doc.schemaVersion === 1, 'schemaVersion 必须是 1');
  must(Array.isArray(doc.profiles) && doc.profiles.length === 9, '必须恰好 9 个 Profile');
  const ids = new Set();
  for (const p of doc.profiles) {
    must(typeof p.id === 'string' && p.id.length > 0, 'profile.id 为空');
    must(!ids.has(p.id), `重复 id: ${p.id}`);
    ids.add(p.id);
    must(Array.isArray(p.tone.curve) && p.tone.curve.length === 5, `${p.id} tone.curve 必须恰好 5 点`);
    must(typeof p.color.lut === 'string' && p.color.lut.length > 0, `${p.id} 缺少 color.lut`);
    const lutPath = path.join(ROOT, 'modules/camera-engine/ios/LUTs', `${p.color.lut.replace(/\.cube$/, '')}.cube`);
    must(fs.existsSync(lutPath), `${p.id} 的 LUT 文件缺失: ${lutPath}`);
  }
});

// 6. podspec 资源与依赖声明
step('podspec 资源声明', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'modules/camera-engine/CameraEngine.podspec'), 'utf8');
  must(spec.includes('CameraEngineLUTs'), 'podspec 缺少 CameraEngineLUTs resource_bundles');
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'modules/camera-engine/expo-module.config.json'), 'utf8'));
  must(config.apple && Array.isArray(config.apple.modules) && config.apple.modules.includes('CameraEngineModule'), 'expo-module.config.json 缺少 CameraEngineModule');
  must(config.apple.podspecPath === 'CameraEngine.podspec', 'expo-module.config.json 缺少 apple.podspecPath（原生模块注册回归）');
});

// 7. 公开仓库密钥红线扫描（工作区源码，排除依赖与产物）
step('密钥红线扫描', () => {
  const skip = new Set(['node_modules', '.git', 'dist-check', '.expo', 'Camera18_LUT_V0.zip']);
  const exts = new Set(['.ts', '.tsx', '.js', '.json', '.md', '.swift', '.yml', '.sh', '.podspec']);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (exts.has(path.extname(entry.name))) {
        const text = fs.readFileSync(full, 'utf8');
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) offenders.push(full);
        if (/AKIA[0-9A-Z]{16}/.test(text)) offenders.push(full);
        if (/gh[pousr]_[A-Za-z0-9]{36,}/.test(text)) offenders.push(full);
      }
    }
  };
  walk(ROOT);
  must(offenders.length === 0, `发现疑似密钥: ${offenders.join(', ')}`);
});

process.stdout.write('\n================================\n');
if (failed) {
  console.log('✗ prepackage-check 未通过 —— 禁止打包');
  process.exit(1);
}
console.log('✓ prepackage-check 全部通过 —— 可以打包（真机验收清单见 TESTING.md）');
