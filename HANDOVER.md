# 项目交接与 AI 协作维护手册 (HANDOVER.md)

本文件专为跨设备维护及不同 AI Agent / 开发者交接设计。在接手本项目进行迭代时，**请务必通读此文档**，严格遵守既定架构与红线约束。

> 📌 **机器可读的硬规则在 [`AGENTS.md`](./AGENTS.md)** —— 那份是给 AI 的精简红线清单，本文件是完整背景叙述。**两份都要读。** 若两者冲突，以 `AGENTS.md` 的红线为准。

---

## 快照：交接时的当前状态（2026-09-14）

- **最新成功构建：TestFlight build 46**（run 46，commit `880ef71`）。此前 build 42 授权即崩（lutIntensity 循环越界）、run 43/45 是 SDK 兼容编译错误，均已修复——教训全部沉淀在 `AGENTS.md` 第 5 节坑表（坑 #10/#11），**先读坑表再动 Swift**。
- **待真机验证（build 46，iPhone 14 Plus）**：① 横屏单画面不抽搐（双画面根因 = Core Image 只写落点像素，已改逐帧黑底重涂 + 陀螺仪迟滞）；② 光圈刻度 1/24 档 + 阻尼 420px 手感；③ 六台相机 SVG 图标与配色区分；④ 35/52mm 拍摄后相册显示对应焦距（EXIF `FocalLengthIn35mmFilm` 盖戳，diag 日志记录实际 zoom）。
- **待 iPhone 18 Pro 真机验证**：物理可变光圈（哨兵已按 SDK 实测修正为 `AVCaptureDevice.currentExposureDuration/currentISO`，调用为「settle 单次提交 + ack/看门狗」模式）。
- **多机协作实测（2026-09-13/14，Windows 机）**：`api.github.com` 直连稳定可用（拉 CI 日志、触发 workflow 都走它）；`github.com` 直连**时好时坏**（本次会话内 200 与连接重置交替出现），本机 Clash 代理 `127.0.0.1:7890` 也时启时停——push 失败先重试直连，再探测代理端口（手法见 `AGENTS.md` 0.1）。CI 日志需要认证：用 GCM 存的凭据调 `GET /actions/jobs/{id}/logs`（token 只进内存，不落日志/文件）。
- 出包 = 手动触发 `ios-testflight.yml`（`workflow_dispatch`，API 或网页均可），监督手法：轮询 `GET /actions/runs/{id}` 直到 `completed`，失败则按 job id 拉日志 grep `: error:`。

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
- ❌ 直方图、九宫格水平仪、专业模式 (Pro Mode)、前后置镜头切换（后置多镜头切换已于 2026-09-12 获用户批准，为正式功能，UI 呈现为焦段 mm 数值转盘）
- ❌ 账号体系、云端同步、社交社区、Redux / Zustand 等重型状态管理库

### 2. 硬件控制边界
- **用户只控制三件事**：1. 相机模拟型号 (6 个核心 Profile)；2. 光圈大小 ($f$-stop，无极环；无硬件光圈的机型是 DEMO 模式——可拧、联动视觉，成片始终是镜头真实光圈)；3. 后置焦段档位 (13/26/35/52…mm，虚拟设备 `videoZoomFactor` 无缝变焦)。
- **其余一切全自动**：AF（自动对焦）、AE（自动曝光）、ISO、快门速度、AWB、系统防抖。
- **光圈回退机制**：非 iPhone 18 Pro 机型走 DEMO 模式（默认开，条上明示 DEMO），成片永远不假虚化；真机上 `ERR_APERTURE_UNSUPPORTED` 会自动降级为固定光圈 + DEMO。**严禁做纯软件虚化的假光圈**。

---

## 二、开发与构建红线（极度重要）

1. **开发环境**：
   - 当前在 Windows 下开发（没有本地 Xcode，没有 macOS，不能运行 `expo run:ios`）。
   - 技术栈：`Expo SDK 55` + `React Native 0.83.10` + `React 19.2.0` + `TypeScript (Strict)` + 本地 Swift Expo Module (`modules/camera-engine`)。
2. **EAS Build 次数限制**：
   - **除非用户直接且明确说出「现在可以打包」，否则任何 AI 禁止执行 `eas build`、`npx eas build` 或 `npm run build:ios:dev`！**
   - **日常出包不在此限**：`.github/workflows/ios-dev-build.yml`（Ad Hoc 真机包）与 `.github/workflows/ios-testflight.yml`（App Store → TestFlight）都在 GitHub Actions 上出包，**不调用 EAS、不占配额**，可随时手动触发。见 `AGENTS.md` 第 1.1 节。
   - 所有静态能验证的工作必须在本地完成；必须依赖真机或 Xcode 的工作，一律在输出中标记为：`待 CI 构建验证`（本地 Windows 没有 swiftc，Swift 编译错误只有 CI 能抓——run 40/41/43/45 全是这么抓到的）。

---

## 三、架构全景与关键模块

```text
camera/
├── AGENTS.md                         # 给 AI 的精简红线清单 (必读)
├── HANDOVER.md                       # 本文件：完整背景与交接叙述
├── App.tsx                           # 根控制器 (装配全链路、手势路由、状态机)
├── app.json / app.config.js / eas.json / package.json
├── assets/
│   └── camera-profiles.json          # 6 个核心相机的全部 DNA：色彩/纹理/光圈/皮肤色/图标 (唯一真理来源)
├── modules/
│   └── camera-engine/                # 核心原生模块 (Swift + Core Image + AVFoundation)
│       ├── ios/
│       │   ├── CameraEngineModule.swift   # 原生会话、可变光圈抽象、effectiveColorCube 渲染、拍照入库（全仓库唯一 Swift 文件）
│       │   └── LUTs/                 # 57 个 .cube（resource bundle CameraEngineLUTs；核心 6 台只引用其中 6 个）
│       ├── CameraEngine.podspec      # Pod 规范 (依赖 CoreImage, AVFoundation, Photos, MetalKit 等)
│       ├── expo-module.config.json   # platforms: ["apple"] —— 无 Android 实现
│       └── index.ts                  # 模块入口 (当前零引用，且是裸 requireNativeModule——不要 import 它；App 走 src/camera/CameraEngine.tsx)
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
        ├── CameraSelector.tsx        # ★ 正式 Camera Selection 主入口 (点顶部相机徽章弹出列表)
        ├── GlassCard.tsx             # ★ Liquid Glass 封装 (expo-glass-effect; 旧系统/Reduce Transparency 回退实底)
        ├── FocusIndicator.tsx        # ★ Tap-to-Focus 轻量对焦框 (纯视觉，AF/AE 在原生层完成)
        ├── CameraIcon.tsx            # ★ 六台相机的机型剪影 SVG (按 ui.icon 分发；无品牌 logo)
        ├── ApertureBar.tsx           # ★ 光圈无极环：1/24 档刻度 + 半档中刻度 + 阻尼拖动；
        │                             #   per-move 只更新 UI，松手 onApertureSettle 单次硬件提交
        ├── ApertureSideView.tsx      # 光圈侧视剖面 (开发者模式开关)
        ├── IrisGlyph.tsx             # 光圈叶片 SVG (随 f-stop 开合)
        ├── ShutterButton.tsx         # 物理风格两段式快门按钮
        ├── ThumbnailPreview.tsx      # 左下角成片缩略图 (直读生成图，不滥查相册)
        ├── ProfileOverlay.tsx        # 取景器实时色彩风格近似遮罩（已导出但当前未挂载——死代码，可删）
        ├── TopBar.tsx                # 顶部相机徽章；带 onPress 时是 Camera Selector 的入口
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

**预览（Color/Tone WYSIWYG，逐帧 30fps；颗粒/halation/detail 仅成片，不宣称完整像素级 WYSIWYG）**：
```text
AVCaptureVideoDataOutput(BGRA, .photo preset 全分辨率)
   ↓ captureOutput: CIImage 头部降采样到 ≤1280px（videoSettings 尺寸键无效，见坑 #11）
   ↓ CameraDNARenderer.apply(mode: .preview)：effectiveColorCube(LUT×强度×色温×饱和×7分区HSL 预编译 33³)
     → Exposure → Contrast/BlackPoint → 5 点曲线
   ↓ 合成到纯黑底板（逐帧重涂全部像素——否则信箱黑边残留上一帧 → 横屏双画面，build 44 教训）
   ↓ PreviewRenderer(MTKView) letterbox 绘制；连接方向由 CoreMotion 重力驱动（切换有 0.82 迟滞阈值）
```

**成片**：
```text
[按下快门] → AVCapturePhotoOutput（JPEG；ProRAW 能力保留但默认关闭）
   ↓ PhotoCaptureDelegate（processingQueue；in-flight 上限 3，JS 侧另有 20s 超时兜底）
   ↓ 统一 CameraDNA 渲染 (mode: .final)：preview 全部阶段
     + final-only：降噪/锐化/局部色调、Grain、Vignette
   ↓ EXIF 保留原始元数据 + 盖戳 Orientation=1、FocalLengthIn35mmFilm=基准焦距×实际zoom
   ↓ JPEG 写 Temp + 512px 缩略图（Documents 持久副本防丢）
   ↓ PhotoKit (add-only) 入相册；appliedZoom/equivalentFocal 回传 JS 记 diag
```

### 关键避坑指南（前人已修，**严禁回退**）：

1. **`PhotoCaptureDelegate` 双格式回调的判定顺序**：请求 RAW+Processed 双格式时，系统会触发两次 `didFinishProcessingPhoto`。在 `didFinishProcessingPhoto` 内部，必须**先**执行 `if expectedPhotoCount > 1 && !isRaw { return }`，**再**执行 `guard error == nil, let photoData = photo.fileDataRepresentation()`。顺序一旦颠倒，伴生的 processed 照片失败时会直接终结整次拍摄并弹「capture failed」，即使 RAW 其实已经拍好——而 processed 失败比 RAW 失败常见得多。（2026-09-10 修正）

2. **拍摄 Promise 必须有兜底，否则快门会永久卡死**：若 `expectedPhotoCount == 2` 但只有 processed 回调到达，processed 被忽略后 `didFinishCaptureFor(error: nil)` 什么也不做 → Promise 永不 resolve → `isCapturing` 永久 `true` → **快门永久禁用**，delegate 永久滞留在 `captureDelegates` 里。
   现有双重保险：原生侧 `didAcceptPhoto`（`completionLock` 保护，通过 guard 后**同步**置位，防止与异步渲染赛跑）配合 `didAcceptAnyPhoto`，在 `didFinishCaptureFor` 里若没拿到任何可用照片就 `finish(.failure)`；JS 侧 `handleCapturePhoto` 另有 `Promise.race` 20 秒超时（`CAPTURE_TIMEOUT_MS`）。（2026-09-10 修正）

3. **两套手势会互相抢占**：`App.tsx` 的取景器 PanResponder 用的是 `onStartShouldSetPanResponder: (evt) => evt.nativeEvent.touches.length === 1`。但第一根手指落下时它**必然**只看到 1 个触点，所以一定抢占成功并启动 350ms 长按计时器；此后第 2、3 根手指落下时 RN 只会触发 `onResponderStart`，**`onPanResponderGrant` 不会二次执行**，于是 `onPanResponderGrant` 里那个 `touches.length > 1` 守卫是死代码。
   → 必须提供 `onPanResponderStart`，在 `gestureState.numberActiveTouches > 1` 时取消长按计时器、关闭可能已弹出的轮盘、清空起手点，否则三指按住约 350ms 后环形轮盘会在校准 HUD 之上弹出来。（2026-09-10 修正）

4. **`CIContext` 开销**：`CIContext` 已提升为静态共享对象 (`private static let sharedContext`)，**严禁** 改回在每次按快门时 `new CIContext()`，否则连续拍照必定发生显存泄露并被 iOS Jetsam 杀进程。

5. **effectiveColorCube 缓存纪律**（build 42 P0 教训的另一半）：`setProfile` 每次都会被调用（prop 通道 + applyProfile），`invalidateCompiledProfile` 靠 color 指纹判断是否真的变了——**不要**改回无条件递增 revision，否则每次光圈拖动都会在渲染队列上重建 33³ cube 并向 `effectiveCubeCache` 泄漏 ~0.5MB/次。同 id 只保留最新 revision 的淘汰逻辑同理不可删。

6. **光圈硬件提交必须单次**：拖动过程 `onApertureChange` 只更新 UI，松手 `onApertureSettle` 才发一次 `setAperture`（原生带 ack + 3s 看门狗，`SettleOnceGate` 恰好结算一次）。不要改回每 move 事件一发——sessionQueue 会被 `lockForConfiguration` 命令灌满，真机可变光圈更是命令风暴。

7. **JS↔profile 单通道**：profile 只通过 `<CameraEngineView profile={...}>` 声明式 prop 下发；旧的 `applyProfile` effect 是第二通道（双倍过桥 + 双倍缓存失效）已删除，勿加回。aperture→halation/starburst 视觉联动被 `APERTURE_VISUAL_LINKAGE_ENABLED=false` 门控——渲染器已无这两个阶段，联动是零收益开销；恢复 stages 时再打开。

8. **横屏双画面 = Core Image 只写落点像素**：`PreviewRenderer.draw` 每帧把画面 `composited(over: 纯黑底板)` 重涂全部 drawable 像素。删掉这个合成，信箱黑边就会残留上一帧内容——横竖切换后取景框里新旧两帧叠加（build 44 真机实测）。

9. **EXIF 焦距盖戳语义**：保存的 JPEG 用捕获瞬间设备上**实际生效**的 `videoZoomFactor` 推导等效焦距写入 `FocalLengthIn35mmFilm`（虚拟设备基准 13mm、单广 26mm，与 `focalLadder.ts` 一致）。这是「相册显示 26mm」问题的修复——若未来改成不裁切的实现，必须同步移除盖戳，否则 EXIF 会撒谎。

10. **相机 Profile 渲染一致性**：**禁止** 针对 Leica、Fuji、Ricoh 分别编写 `switch-case` 原生代码，所有相机（现 6 台）必须共用统一的 `CameraDNARenderer.apply`，其风格完全由 JSON 矩阵定义。

11. **（Iteration 4 已修订）RAW 拍摄失败时的安全网**：旧行为是「RAW 失败即整张失败，不回退伴生 processed JPEG」（当时的产品决策）。按 Iteration 4「照片绝不静默消失」原则已改为：伴生 processed 图保留在 `companionData`，RAW/Camera DNA 管线失败时保存 Apple 原图并通过 `processingFallback` 标记告知用户。**不要改回静默丢弃**；若未来要收紧，必须先与用户确认。

---

## 五、当前支持的 6 个核心相机预设

| id | 显示名 | 图标 (`ui.icon`) | 皮肤色 (`ui.accent`) | 推荐光圈 | 风格特征 |
|---|---|---|---|---|---|
| ricoh_positive | Ricoh Positive | ricoh-gr | 沙棕 `#C7AFA0` | ƒ/2.8 | 高饱和、高反差正片风 |
| ricoh_negative | Ricoh Negative | ricoh-gr | 蓝灰 `#9FB4C4` | ƒ/2.8 | 低反差、清冷泛青负片风 |
| canon_portrait | Canon Portrait | canon-compact | 玫紫 `#B78BA3` | ƒ/1.8 | 温暖肤色、微发色、大光圈明亮 |
| fuji_classic_chrome | Fuji Classic Chrome | fuji-rangefinder | 灰绿 `#A8A8A0` | ƒ/4 | 低饱和纪实青灰调 |
| fuji_classic_negative | Fuji Classic Negative | fuji-rangefinder | 橄榄 `#97A06A` | ƒ/2.8 | 强红黄硬调暗部偏绿 |
| leica_m9 | Leica M9 | leica-rangefinder | 深红 `#B4554D` | ƒ/1.8 | CCD 浓郁暗部沉降、高微反差 |

- 六台只引用 57 个 LUT 中的 6 个（`canon_portrait` 复用 `canon-g7x2.cube`）；其余 51 个是校准工作流资产，运行时由 LUTLoader 的 8 槽 LRU 兜底。
- 51 台旧目录备份在 `.backup-51-profiles/`。
- 切换相机时光圈自动吸附到 Profile 的 `aperture.preferred`；在不支持该光圈的硬件上由原生层就近钳制。

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

# 5. iOS 离线导出与链接验证 (实测基线：748 modules，2026-09-14)
npx expo export --platform ios --output-dir dist-check
rm -rf dist-check
```

```powershell
# 第 1-4 步同上；第 5 步的 PowerShell 写法：
npx expo export --platform ios --output-dir dist-check; if (Test-Path dist-check) { Remove-Item -Recurse -Force dist-check }
```

> ⚠️ **第 5 步的模块数实测基线是 `748 modules`**（脚本门槛是 ≥619 的宽松下限）。若数字异常变化，说明有文件被误删或被意外引入，需要先查清再提交。
> ⚠️ **出包前的完整门槛是 `npm run prepackage`**（= verify + expo export + Swift 括号配平 + autolinking + profile/LUT 一致性 + 密钥扫描），必须全绿才能触发 workflow。
> ⚠️ **`dist-check/` 用完必须删掉**，它是验证产物，不是交付物（已在 `.gitignore` 里，但仍建议手动清理）。

### 原生 Swift 代码

本机（Windows）**没有 `swift` / `swiftc`**，因此：

- 结构层面（括号 / 字符串 / 插值配平）有 `npm run prepackage` 的配平步骤自查；
- **语法与类型能否通过，只能等 CI 构建**（TestFlight workflow，~6 分钟）。
- 历史教训（写新 Swift 前先读 `AGENTS.md` 坑 #10/#11）：数组逐元素循环必须固定索引（run 40/41 + build 42 崩溃）；SDK 会改名/废弃 API——`AVCaptureExposureDurationCurrent→AVCaptureDevice.currentExposureDuration`、`AVCaptureISOCurrent→currentISO`、连接级 `videoMinFrameDuration` 已 unavailable（run 43）；ImageIO 的 EXIF 键没有 Swift 常量，用字面量（run 35/45）。

任何涉及 Swift 的改动，汇报时必须标注 `待 CI 构建验证`，**不要声称"已验证通过"**。

---

## 七、后续待验证项分级（接手 AI 请按此汇报）

- **待 CI 构建验证**：
  - 本地 Swift 代码通过 GitHub Actions 的 Xcode 编译（workflow：`ios-testflight.yml`，手动触发）。
  - `CameraEngine.podspec` 顺利完成 CocoaPods 集成（prepackage 的 autolinking 步骤做本地弱验证）。
- **待普通 iPhone 真机验证（build 46 起未闭环的项）**：
  - 横屏：取景器单画面、无抽搐（双画面根因修复 + 陀螺仪迟滞）。
  - 光圈手感：1/24 档刻度密度与 420px 阻尼。
  - 相机图标：三处入口的机型剪影 SVG 与六色区分。
  - 相册焦距：35/52mm 拍摄后 EXIF 显示对应焦距（diag 记录 appliedZoom/equivalentFocal 可对质）。
  - 授权 → 预览首帧稳定（build 42 崩溃路径的回归哨兵）。
  - 三指长按呼出校准面板、PhotoKit add-only 权限弹窗。
- **待 iPhone 18 Pro 真机验证**：
  - 物理可变光圈：`setExposureModeCustom(lensAperture:...)` 光圈优先（哨兵三级解析 + ack/看门狗单次结算）；光圈叶片联动、真实光圈范围读取、真实光学星芒/景深。
  - 焦段档位的变焦裁切（`videoZoomFactor`）与成片取景一致性。
