# 项目交接与 AI 协作维护手册 (HANDOVER.md)

本文件专为跨设备维护及不同 AI Agent / 开发者交接设计。在接手本项目进行迭代时，**请务必通读此文档**，严格遵守既定架构与红线约束。

> 📌 **机器可读的硬规则在 [`AGENTS.md`](./AGENTS.md)** —— 那份是给 AI 的精简红线清单，本文件是完整背景叙述。**两份都要读。** 若两者冲突，以 `AGENTS.md` 的红线为准。

---

## 零、开工第一步：同步远端（多机协作命门）

仓库：<https://github.com/cornpiess/camera_ccd>

本项目的**唯一真相来源是远端仓库**。这台电脑上看到的代码不一定是"最新"的，另一台机器可能已经改过。任何一轮工作都必须按下面顺序走：

```bash
git pull --rebase     # 1. 先拉最新。禁止在落后状态下动手
npm install           # 2. 依赖可能变了（package-lock.json 变更时）
npm run verify        # 3. 确认基线是绿的，再改任何东西

# ... 改代码 ...

npm run verify        # 4. 改完再验一次，必须全绿
git add -A
git commit -m "..."   # 5. 一次逻辑改动 = 一个提交，别攒成一大坨
git push              # 6. 收工必须 push，否则另一台机器永远看不到
```

**纪律**：
- ❌ 禁止 `git push --force`（除非用户明确要求，且已确认没有别的机器在开发中）。
- ❌ 禁止在没 `git pull` 的情况下直接改代码 —— 这是多机分叉的头号来源。
- ❌ 禁止提交 `node_modules/`、`.expo/`、`dist-check/`、任何证书或密钥。
- ✅ 提交信息用中文或英文均可，但要说清「改了什么 + 为什么」。

**⚠️ 网络不通时**：`github.com` 在中国大陆常被**单独**阻断，而 `api.github.com` / `raw.githubusercontent.com` / `codeload.github.com` 仍可访问——所以「`github.com` 不通」不等于断网。完整的排查与绕过步骤（含代理端口验证、凭据助手卡死的处理）见 [`AGENTS.md` 第 0.1 节](./AGENTS.md)。

---

## 一、核心定位与最高产品原则

这是一个专注于 **iPhone 18 Pro / Pro Max 物理可变光圈** 的复古/胶片风格拟真相机应用。
核心交互只有一行逻辑：
> **「选相机 → 拧光圈 → 拍照」**

### 1. 严格禁止（Anti-Goals）
接手 AI **禁止** 引入以下功能，不要过度设计：
- ❌ 手动 ISO / 手动快门速度 / 手动白平衡 (WB) / 手动 EV / 曝光补偿
- ❌ 滤镜选择器、滤镜强度滑块、后期照片编辑器
- ❌ AI 消除、AI 增强、计算摄影风格化算法
- ❌ 直方图、九宫格水平仪、专业模式 (Pro Mode)、前后置镜头切换、多镜头缩放切换
- ❌ 账号体系、云端同步、社交社区、Redux / Zustand 等重型状态管理库

### 2. 硬件控制边界
- **用户只控制两件事**：1. 相机模拟型号 (8 个 Profile)；2. 光圈大小 ($f$-stop)。
- **其余一切全自动**：AF（自动对焦）、AE（自动曝光）、ISO、快门速度、AWB、系统防抖。
- **光圈回退机制**：当前非 iPhone 18 Pro 机型或不支持物理可变光圈的硬件，界面明确显示 `Fixed ƒ/x`，光圈调节交互呈禁用/锁定状态，**严禁做纯软件虚化的假光圈**。

---

## 二、开发与构建红线（极度重要）

1. **开发环境**：
   - 当前在 Windows 下开发（没有本地 Xcode，没有 macOS，不能运行 `expo run:ios`）。
   - 技术栈：`Expo SDK 55` + `React Native 0.83.10` + `React 19.2.0` + `TypeScript (Strict)` + 本地 Swift Expo Module (`modules/camera-engine`)。
2. **EAS Build 次数限制**：
   - **除非用户直接且明确说出「现在可以打包」，否则任何 AI 禁止执行 `eas build`、`npx eas build` 或 `npm run build:ios:dev`！**
   - **日常出包不在此限**：`.github/workflows/ios-dev-build.yml`（Ad Hoc 真机包）与 `.github/workflows/ios-testflight.yml`（App Store → TestFlight）都在 GitHub Actions 上出包，**不调用 EAS、不占配额**，可随时手动触发。见 `AGENTS.md` 第 1.1 节。
   - 所有静态能验证的工作必须在本地完成；必须依赖真机或 Xcode 的工作，一律在输出中标记为：`待 EAS / 真机验证`。

---

## 三、架构全景与关键模块

```text
camera/
├── AGENTS.md                         # 给 AI 的精简红线清单 (必读)
├── HANDOVER.md                       # 本文件：完整背景与交接叙述
├── App.tsx                           # 根控制器 (装配全链路、手势路由、状态机)
├── app.json / eas.json / package.json
├── assets/
│   └── camera-profiles.json          # 8个官方相机的核心色调 DNA (唯一真理来源)
├── modules/
│   └── camera-engine/                # 核心原生模块 (Swift + Core Image + AVFoundation)
│       ├── ios/
│       │   └── CameraEngineModule.swift  # 原生会话、可变光圈抽象、RAW解码与渲染管线
│       ├── CameraEngine.podspec      # Pod 规范 (依赖 CoreImage, AVFoundation, Photos 等)
│       ├── expo-module.config.json   # platforms: ["apple"] —— 无 Android 实现
│       ├── index.ts                  # 模块入口 (当前零引用；App 实际走 src/camera/CameraEngine.tsx)
│       └── package.json
└── src/
    ├── camera/
    │   └── CameraEngine.tsx          # 原生模块 TypeScript 封装、能力定义、错误码
    ├── profiles/
    │   ├── types.ts                  # Profile Schema 强类型定义
    │   ├── validation.ts             # 运行时 Profile 强校验 (严防运行时崩溃)
    │   ├── ProfileProvider.tsx       # Profile 加载、缓存与覆写上下文 (override 文件持久化)
    │   └── index.ts
    ├── calibration/
    │   ├── CalibrationModal.tsx      # 调色校准面板 (JSON 导入 / 覆盖 / 重置) —— 纯面板，不含手势
    │   └── index.ts
    └── components/
        ├── index.ts                  # 统一导出桶；App 只从这里取组件
        ├── types.ts                  # 共享类型 (Point / CameraInfo / Profile 别名)
        ├── declarations.d.ts         # 空占位 (待清理)
        ├── ThreeFingerGestureDetector.tsx  # ★ 三指长按手势的唯一实现
        ├── RadialProfileSelector.tsx # 环形相机轮盘 + 几何工具 (getClampedCenter / computeRadialSector)
        ├── ApertureControl.tsx       # 光圈调节器 (可变光圈可用；否则显示 Fixed ƒ/x 并锁定)
        ├── ShutterButton.tsx         # 物理风格两段式快门按钮
        ├── ThumbnailPreview.tsx      # 左下角成片缩略图 (直读生成图，不滥查相册)
        ├── ProfileOverlay.tsx        # 取景器实时色彩风格近似遮罩
        ├── TopBar.tsx                # 顶部状态信息 (相机名、固定/可变光圈标签)
        └── CameraStateViews.tsx      # 三种启动态：PermissionRequestView / CameraLoadingView / CameraErrorView
```

### ⚠️ 两处必须搞清的归属（文档曾写错）

**1. 三指长按 2 秒的手势不在 `CalibrationModal` 里。**
`CalibrationModal.tsx` 完全没有手势代码，它只是个面板。真正的实现在 `components/ThreeFingerGestureDetector.tsx`：`durationMs = 2000`、位移容差 `35px`、自带 HUD 进度条。`App.tsx` 用 `isCalibrationOpen` 状态把它和面板连起来。

**2. 一共有两套独立手势，它们曾经互相抢占（已于 2026-09-10 修复）。**

| 手势 | 实现位置 | 行为 |
|---|---|---|
| 三指长按 | `ThreeFingerGestureDetector.tsx` | 按住 2000ms → 呼出 `CalibrationModal` |
| 单指长按 | `App.tsx` 的 `previewPanResponder` | 按住 350ms → 呼出 `RadialProfileSelector` 轮盘；>15px 位移取消 |

修复手法见第四节第 3 条。**改动这两个文件时务必同时考虑对方**。

---

## 四、渲染与图像管线（Core Pipeline）

```text
[按下快门]
   ↓
AVCapturePhotoOutput
   ├─ 支持 ProRAW / RAW → 请求 DNG RAW 数据
   └─ 不支持 ProRAW → 请求标准高质量 Processed JPEG
   ↓
PhotoCaptureDelegate 后台并发队列 (camera-engine.photo-processing)
   ├─ photo.isRawPhoto == true:
   │     ↓
   │  CIRAWFilter(imageData:identifierHint:) 传感器原始解码
   │     ↓
   │  动态注入 Camera DNA 中的 raw.* 参数：
   │    • inputSharpness: 降锐化，消除假轮廓
   │    • inputDetailAmount: 保护微小纹理
   │    • inputLocalToneMapAmount: 控制动态范围
   │    • inputLuminanceNoiseReductionAmount: 噪点平滑
   │    • inputColorNoiseReductionAmount: 色彩降噪
   │    • inputBoostAmount = 0.0: 去除手机假鲜艳
   │
   └─ photo.isRawPhoto == false (Fallback):
         ↓
      标准 CIImage 管道，辅以保守的 Core Image 滤镜模拟
   ↓
统一 Camera DNA 渲染 (ProfileRenderer)
   Tone -> Tone Curve -> Color -> 7-Hue Bands (16³ Color Cube) -> Texture (Grain/Vignette)
   ↓
写出 JPEG 到 Temp 目录 + 生成 512px 缩略图
   ↓
PhotoKit (add-only) 写入相册，界面缩略图立即可见
```

### 关键避坑指南（前人已修，**严禁回退**）：

1. **`PhotoCaptureDelegate` 双格式回调的判定顺序**：请求 RAW+Processed 双格式时，系统会触发两次 `didFinishProcessingPhoto`。在 `didFinishProcessingPhoto` 内部，必须**先**执行 `if expectedPhotoCount > 1 && !isRaw { return }`，**再**执行 `guard error == nil, let photoData = photo.fileDataRepresentation()`。顺序一旦颠倒，伴生的 processed 照片失败时会直接终结整次拍摄并弹「capture failed」，即使 RAW 其实已经拍好——而 processed 失败比 RAW 失败常见得多。（2026-09-10 修正）

2. **拍摄 Promise 必须有兜底，否则快门会永久卡死**：若 `expectedPhotoCount == 2` 但只有 processed 回调到达，processed 被忽略后 `didFinishCaptureFor(error: nil)` 什么也不做 → Promise 永不 resolve → `isCapturing` 永久 `true` → **快门永久禁用**，delegate 永久滞留在 `captureDelegates` 里。
   现有双重保险：原生侧 `didAcceptPhoto`（`completionLock` 保护，通过 guard 后**同步**置位，防止与异步渲染赛跑）配合 `didAcceptAnyPhoto`，在 `didFinishCaptureFor` 里若没拿到任何可用照片就 `finish(.failure)`；JS 侧 `handleCapturePhoto` 另有 `Promise.race` 20 秒超时（`CAPTURE_TIMEOUT_MS`）。（2026-09-10 修正）

3. **两套手势会互相抢占**：`App.tsx` 的取景器 PanResponder 用的是 `onStartShouldSetPanResponder: (evt) => evt.nativeEvent.touches.length === 1`。但第一根手指落下时它**必然**只看到 1 个触点，所以一定抢占成功并启动 350ms 长按计时器；此后第 2、3 根手指落下时 RN 只会触发 `onResponderStart`，**`onPanResponderGrant` 不会二次执行**，于是 `onPanResponderGrant` 里那个 `touches.length > 1` 守卫是死代码。
   → 必须提供 `onPanResponderStart`，在 `gestureState.numberActiveTouches > 1` 时取消长按计时器、关闭可能已弹出的轮盘、清空起手点，否则三指按住约 350ms 后环形轮盘会在校准 HUD 之上弹出来。（2026-09-10 修正）

4. **`CIContext` 开销**：`CIContext` 已提升为静态共享对象 (`private static let sharedContext`)，**严禁** 改回在每次按快门时 `new CIContext()`，否则连续拍照必定发生显存泄露并被 iOS Jetsam 杀进程。

5. **相机 Profile 渲染一致性**：**禁止** 针对 Leica、Fuji、Ricoh 分别编写 `switch-case` 原生代码，所有 8 台相机必须共用 `ProfileRenderer.apply`，其风格完全由 JSON 矩阵定义。

6. **刻意未做的事**（标注了 `ponytail:` 注释，不是遗漏）：RAW 拍摄失败时**不**回退到伴生的 processed JPEG。这是产品决策——宁可失败也不悄悄降级画质。要改需先与用户确认。

---

## 五、当前支持的 8 个相机预设

| 相机名称 | 预设推荐物理光圈 | 风格特征 |
|---|---|---|
| **Canon G7X II** | $f/1.8$ | 温暖肤色、微发色、大光圈明亮 |
| **Ricoh Positive** | $f/2.8$ | 高饱和、高反差正片风 |
| **Ricoh Negative** | $f/2.8$ | 低反差、清冷泛青负片风 |
| **Leica M9** | $f/2.0$ | CCD 浓郁暗部沉降、高微反差 |
| **Fuji Classic Chrome** | $f/2.8$ | 低饱和纪实青灰调 |
| **Fuji Classic Negative** | $f/2.8$ | 强红黄硬调暗部偏绿 |
| **Hasselblad Natural** | $f/2.8$ | 极度平滑真实自然色彩体系 |
| **CineStill 800T** | $f/1.48$ | 电影暖冷对比、高光光晕 (Halation) |

*切换相机时，光圈自动归位到 Profile 的推荐值；在不支持该光圈的硬件上由原生层就近吸附。*

---

## 六、交接维护者本地快速验证指令

### 一键三项（最常用）

```bash
npm run verify    # = typecheck + lint + doctor，三项必须全绿
```

### 完整五项

每次修改代码后执行以下命令进行本地静态全检（bash 与 PowerShell 均可，任选其一）：

```bash
# 1. 严格 TypeScript 类型检查 (无 any 隐患)
npm run typecheck

# 2. 代码风格与 Lint 检查 (必须 0 error 0 warning)
npm run lint

# 3. Expo 官方环境依赖自检 (必须保持 20/20 checks passed)
npm run doctor

# 4. 依赖包版本一致性检查
npx expo install --check

# 5. iOS 离线导出与链接验证 (基线：607 modules)
npx expo export --platform ios --output-dir dist-check
rm -rf dist-check
```

```powershell
# 第 1-4 步同上；第 5 步的 PowerShell 写法：
npx expo export --platform ios --output-dir dist-check; if (Test-Path dist-check) { Remove-Item -Recurse -Force dist-check }
```

> ⚠️ **第 5 步的模块数基线是 `607 modules`**。若数字异常变化，说明有文件被误删或被意外引入，需要先查清再提交。
> ⚠️ **`dist-check/` 用完必须删掉**，它是验证产物，不是交付物（已在 `.gitignore` 里，但仍建议手动清理）。

### 原生 Swift 代码

本机（Windows）**没有 `swift` / `swiftc`**，因此：

- 结构层面（括号 / 字符串 / 插值配平）可以写词法扫描脚本自查；
- **语法与类型能否通过，只能等 EAS Build**。

任何涉及 Swift 的改动，汇报时必须标注 `待 EAS / 真机验证`，**不要声称"已验证通过"**。

---

## 七、后续待验证项分级（接手 AI 请按此汇报）

- **待 EAS Build 验证**：
  - 本地 Swift 代码通过云端 Xcode/Clang 编译。
  - `CameraEngine.podspec` 顺利完成 CocoaPods 集成。
- **待普通 iPhone 真机验证**：
  - 取景器实时色彩 Overlay 渲染流畅度。
  - ProRAW / RAW 实机捕获速率、写入相册（PhotoKit add-only）权限弹窗。
  - 三指长按呼出校准（Calibration）面板的热加载流程。
- **待 iPhone 18 Pro 真机验证**：
  - 接入 Apple 正式物理可变光圈 API 后，物理光圈叶片收放联动与真实光学星芒/景深表现。
