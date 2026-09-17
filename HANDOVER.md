# 项目交接与 AI 协作维护手册 (HANDOVER.md)

本文件专为跨设备维护及不同 AI Agent / 开发者交接设计。在接手本项目进行迭代时，**请务必通读此文档**，严格遵守既定架构与红线约束。

> 📌 **机器可读的硬规则在 [`AGENTS.md`](./AGENTS.md)** —— 那份是给 AI 的精简红线清单，本文件是完整背景叙述。**两份都要读。** 若两者冲突，以 `AGENTS.md` 的红线为准。

---

## 快照：交接时的当前状态（2026-09-17，commit `cea290f`）

- **最新成功构建：TestFlight build 78**（run number 78，commit `fb3076b`）。**build 78 之后代码又前进了一轮（`f513925`→`cea290f`，5 个 feature/fix + 1 个 CI），尚未出包**——下一轮出包（TestFlight 或 App Store）都会覆盖这批改动，**必须真机回归「七」的清单**。本轮改动一览：
  1. **V-MF 正式管线**：`VMF_HN_33_v2.cube`（color.lut, intensity 1.0）+ **仅成片 deharsh 阶段**（新 schema 字段 `texture.deharsh`，高亮去饱和掩罩、luma 不变、Core Image 官方滤镜）；profile 其余参数按用户规格重校（tone 全中性、微调 hueBands、accent #7F756D）。
  2. **光圈量程探针**：capability 曾只验 ƒ/1.48 一点，真机大光圈端 supportsExposureModeCustom 为 false 时松手被拒回弹。现 `acceptedApertureRange` 按 0.1 档网格全量程探查（format 级查询、按设备 uniqueID 缓存），getCapabilities 上报**实测可接受子区间**为 min/max（UI 刻度端点=硬止挡、Camera Control 滑条同源），settle 越界夹到端点。
  3. **连续滑动回弹修复**：手指所有权总闸（`apertureDraggingRef`）+ settle 序号（`apertureSettleSeqRef`）——拖动期间所有非手指写入者（旧 settle 回调/原生回显含 3s 看门狗/签名光圈回读）静默；只挡 UI 写入，簿记照常。
  4. **测试门**：mock 光圈行 + 三指校准台默认隐藏，版本号 7 连点（≤2s 间隔）解锁、会话内有效；全部依赖原生 `testingBuild` 编译期标志，生产包静默 no-op。版本号在相机选择面板底栏。
  5. **法务入口**：相机选择面板底栏 用户协议·隐私政策·支持（cornpiess.github.io/camera18/，open 前 https+host 白名单校验）。
  6. **UI**：刻度窗口与侧视图共用居中槽位；`BAND_SCALE 1.5`（尺带超出窗口两侧，间距 ~3.7px/根）。
  7. **LUT bundle 收敛**：58→7 款（仅被引用的，48MB→6.6MB）；源库 `Camera18_LUT_V0/luts/` 全量保留，做新相机从那里拷。
  8. **生产编译修复**：`setMockApertureMode` 入口补 `#if`——生产配置（无 CAMERA18_TESTING）此前必编译失败。
  9. **CI**：新增 `ios-appstore.yml`（无测试标志的上架流水线，build number = run number + 10000 防撞号）。**生产配置从未被编译过，它的首跑就是生产代码路径的首次真编译验证。**
- 架构不变量仍是：**物理镜头路由**（26/35/52 共用物理主摄只动 zoom，13mm/Tele 才换 input）、**Aperture Manual / Shutter AUTO / ISO AUTO**、快门 promise 与后处理解耦（`onPhotoProcessed`）、ORIG 零渲染直通。**改 Swift 前先读 `AGENTS.md` 坑表（#10–#18）与本文档「四」的坑指南，CI 是唯一编译器。**
- **多机协作网络**：`api.github.com` 直连通常可用；`github.com` 时好时坏，push/pull 失败走 Clash 代理 `127.0.0.1:7890`（完整手法见 `AGENTS.md` 0.1，**必须在沙箱外执行**）。gh CLI 在 `C:\Program Files\GitHub CLI\gh.exe`（同样要挂 `HTTPS_PROXY`）。**⚠️ 推 `.github/workflows/` 的改动必须直推 github.com（挂代理），gh-proxy 镜像服务端用它自己的凭据转发，永远过不了 workflow scope 校验**（坑 #17）。
- 出包 = 用户明确要求后触发 workflow（`workflow_dispatch`），`gh run watch <id> --exit-status` 监督；CI 连败先读 `AGENTS.md` 1.5。上架提审一律用 `ios-appstore.yml` 的构建（build number = run+10000，好认），**不要拿 TestFlight 构建提审**。

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
- **用户只控制三件事**：1. 相机模拟型号（8 个公开 Profile，见第五节）；2. 光圈大小（$f$-stop 无极环；可变光圈硬件上是**真实光圈**，其余机型显示真实固定光圈）；3. 后置焦段档位（13mm=物理超广、26/35/52mm=物理主摄裁切、Tele=物理长焦，**没有对应物理镜头的档位直接隐藏**）。
- **其余一切全自动**：AF、AE（Shutter AUTO + ISO AUTO）、AWB、系统防抖。代码**从不**设置曝光时长/ISO/EV，也不设 `activeMaxExposureDuration`。
- **诚实性红线**：非可变光圈机型严禁软件假虚化；`ERR_APERTURE_UNSUPPORTED` 一律诚实失败，**不存在** currentExposureDuration/currentISO/固定快门/固定 ISO 的冻结回退。
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
│   └── camera-profiles.json          # 8 个公开相机的全部 DNA（唯一真理来源）；ORIG 带 "passthrough": true
├── modules/
│   └── camera-engine/                # 核心原生模块 (Swift + Core Image + AVFoundation)
│       ├── ios/
│       │   ├── CameraEngineModule.swift   # 原生会话、物理镜头路由、光圈优先、快门解耦、拍照入库（全仓库唯一 Swift 文件）
│       │   └── LUTs/                 # 57 个 .cube（resource bundle CameraEngineLUTs；8 个公开 Profile 引用其中 6 个）
│       ├── CameraEngine.podspec      # Pod 规范 (依赖 CoreImage, AVFoundation, Photos, MetalKit 等)
│       ├── expo-module.config.json   # platforms: ["apple"] —— 无 Android 实现
│       └── index.ts                  # 模块入口 (当前零引用，且是裸 requireNativeModule——不要 import 它；App 走 src/camera/CameraEngine.tsx)
└── src/
    ├── camera/
    │   ├── CameraEngine.tsx          # 原生模块 TypeScript 封装、能力定义、错误码、事件监听
    │   ├── focalLadder.ts            # ★ 焦段阶梯（物理镜头路由真值源）：FocalStop{id,mm,lens,zoom}
    │   └── apertureVisualProfile.ts  # 光圈→视觉联动因子（当前 APERTURE_VISUAL_LINKAGE_ENABLED=false）
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
        ├── ApertureBar.tsx           # ★ 光圈条：光圈孔/刻度/侧视图（后两者互斥、轻点切换，窗口=侧视图宽）；
        │                             #   可变=可拖+SIG 标记，固定=纯展示；光圈洞用绝对 f 映射（f/1.48–f/4 参考量程）
        ├── ApertureSideView.tsx      # 光圈侧视剖面（切换视图之一；非可变镜头的默认视图）
        ├── IrisGlyph.tsx             # 光圈叶片 SVG (随 f-stop 开合)
        ├── ShutterButton.tsx         # 物理风格两段式快门按钮
        ├── ThumbnailPreview.tsx      # 左下角成片缩略图 (直读生成图，不滥查相册)
        ├── ProfileOverlay.tsx        # 取景器实时色彩风格近似遮罩（已导出但当前未挂载——死代码，可删）
        ├── TopBar.tsx                # 顶部相机徽章；带 onPress 时是 Camera Selector 的入口
        ├── FocalCircleRow.tsx        # 焦段档位行（消费 focalLadder 的 FocalStop；无物理镜头的档不出现）
        ├── CameraStateViews.tsx      # 三种启动态：PermissionRequestView / CameraLoadingView / CameraErrorView
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

**Capture Session（物理镜头路由）**：
```text
AVCaptureSession (preset .photo)
 ├─ input  = 物理镜头：13mm→UltraWide · 26/35/52mm→Wide(一个主摄，zoom 1.0/1.346/2.0) · Tele→Telephoto
 │           （26↔35↔52 只动 videoZoomFactor 不换 input；13/Tele 才 beginConfiguration 换 input，
 │             换完必走 configureForCurrentPhysicalCamera 统一重建——尺寸/快拍三件套/光圈能力全按新镜头重读）
 └─ output = AVCapturePhotoOutput（成片唯一真相源）+ VideoDataOutput（取景，设备级 30fps 上限）
```

**预览（Color/Tone WYSIWYG，逐帧 30fps；颗粒/halation/detail 仅成片，不宣称完整像素级 WYSIWYG）**：
```text
AVCaptureVideoDataOutput(BGRA, .photo preset 全分辨率)
   ↓ captureOutput: CIImage 头部降采样到 ≤1280px（videoSettings 尺寸键无效，见坑 #11）
   ↓ CameraDNARenderer.apply(mode: .preview)：effectiveColorCube(LUT×强度×色温×饱和×7分区HSL 预编译 33³)
     → Exposure → Contrast/BlackPoint → 5 点曲线
   ↓ 合成到纯黑底板（逐帧重涂全部像素——否则信箱黑边残留上一帧 → 横屏双画面，build 44 教训）
   ↓ PreviewRenderer(MTKView) letterbox 绘制；连接方向由 CoreMotion 重力驱动（切换有 0.82 迟滞阈值）
```

**成片（快门与后处理解耦）**：
```text
[按下快门] → AVCapturePhotoOutput（JPEG 源；photoQualityPrioritization = .balanced；
             Responsive/ZSL/Fast Capture 三件套 capability 门控，Deferred Delivery 关闭）
   ↓ PhotoCaptureDelegate.onCaptured：didFinishProcessingPhoto 即 resolve JS promise（快门解锁）
   ↓ 全图投递串行 photoProcessingQueue（后台继续，不挡快门）：
       ORIG（passthrough）→ 原样 bytes 写盘（零渲染零二次编码，metadata 原样保留）
       其余 7 个 Profile → CameraDNA 渲染 (.final) → HEIF 0.95（JPEG fallback）
   ↓ EXIF：FocalLengthIn35mmFilm = 当前 FocalStop.mm（JS ladder 真值，native 只缓存）
   ↓ PhotoKit (add-only) 入相册 → sendEvent("onPhotoProcessed") → JS 更新缩略图 chip/报错
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

9. **EXIF 焦距真值在 JS focal ladder**：`FocalLengthIn35mmFilm` = 当前 `FocalStop.mm`（`focalLadder.ts` 按物理镜头算好的等效焦距），App 拍照时直传 + `setZoomFactor(factor, mm)` 缓存到原生。原生只保留「deviceType 基准 × zoom」作为**无 ladder 信息时的最后兜底**（Camera Control 硬快门）——物理 Tele 镜头曾被这个兜底错写成 13mm（build 77 教训），**不要删掉 ladder 传参**。

10. **相机 Profile 渲染一致性**：**禁止** 针对 Leica、Fuji、Ricoh 分别编写 `switch-case` 原生代码，所有相机（现 8 个公开模式）必须共用统一的 `CameraDNARenderer.apply`，其风格完全由 JSON 矩阵定义。

11. **（Iteration 4 已修订）RAW 拍摄失败时的安全网**：旧行为是「RAW 失败即整张失败，不回退伴生 processed JPEG」（当时的产品决策）。按 Iteration 4「照片绝不静默消失」原则已改为：伴生 processed 图保留在 `companionData`，RAW/Camera DNA 管线失败时保存 Apple 原图并通过 `processingFallback` 标记告知用户。**不要改回静默丢弃**；若未来要收紧，必须先与用户确认。

12. **capture input 永远是物理镜头（2026-09-17 定稿）**：26/35/52 共用物理 Wide（只动 `videoZoomFactor`，**不换 input、不重置光圈**）；13mm/Tele 才经 `setLens` 换 input。换 input 后**必须**走 `configureForCurrentPhysicalCamera` 统一重建（maxPhotoDimensions 按**新镜头** activeFormat 重读 24MP 策略、快拍三件套 re-check、光圈能力按新镜头 format 重判）——**严禁沿用上一颗镜头的任何缓存**。不要改回 virtual triple/dual capture input；virtual 设备只允许用于读 tele 倍数（inventory）。

13. **镜头切换的三件套不可拆**：① 预览 crossfade（`PreviewRenderer` 的 hold/fade，`beginHold` 用 `latestImage` 兜底防硬切）；② `lensSwitching` 禁拍窗（`capture()` 拒绝 + 新镜头首帧解锁 + **2.5s watchdog 必须保留**，否则帧流异常时快门永久锁死）；③ 换 input 后统一重建。拆掉任何一个都会黑闪/锁快门/拿到旧镜头的拍摄参数。

14. **快门 promise = Apple capture 完成，不含后处理**：`didFinishProcessingPhoto` 即 resolve（`onCaptured`），Camera DNA/HEIF/PhotoKit 走串行 `processingQueue`，结果经 `onPhotoProcessed` 事件回 JS（缩略图 chip/报错都挂在那里）。**不要把后处理拉回 promise 路径**；`captureReadiness != .ready` 的 busy 门控是 Apple 官方 readiness，别用自研状态替代。

15. **Mock aperture 只存在于测试构建**：`setMockApertureMode`（real/mock-variable/mock-fixed）整个 `#if DEBUG || CAMERA18_TESTING`，只改 UI 状态机、永不碰硬件/成片。App 侧 `mockApertureModeRef` 负责：mock-variable 下**跳过** setAperture 后的真实硬件回读（否则 capabilities 会报真实镜头的 1.8 把环弹回去）。正式包这段代码不编译。**入口也有第二道门**：mock 光圈行与三指校准台默认隐藏，版本号 7 连点（≤2s 间隔）解锁、会话内有效（`testingBuildRef`）——新增任何开发面板都走同一扇门，且**不要**把入口做成生产包可达（App Store 2.3.1）。

16. **光圈环的手指所有权总闸（连续滑动回弹，2026-09-17 修复）**：连续滑动时，上一手势的异步回调（settle promise 成败回写、原生 `onApertureChanged` 回显含 **3s 看门狗迟到成功**、签名光圈硬件回读）会落在新手势中间，把 `currentAperture` 拽回旧值（用户报：滑到 ƒ/4 跳回 ƒ/1.5，反之亦然）。现约定：**任何非手指来源的光圈写入者必须先查 `apertureDraggingRef`，拖动中只允许簿记（confirmedApertureRef）不许写 UI**；settle 侧还有 `apertureSettleSeqRef` 序号，出序解析的旧 settle 不得覆盖新结果。新增异步光圈写入点时**必须**接同一总闸。ApertureBar 内部的 "JUMP FIX"（拖动中抑制 effect 重定位）只挡刻度带动画，挡不住值——别误以为有它就够了。

17. **gh-proxy 镜像推不了 `.github/workflows/` 的改动**：镜像（`gh-proxy.com`）在服务端用它自己的凭据向 GitHub 转发，GitHub 按镜像的 OAuth 权限校验 workflow 文件，本地 token 加了 `workflow` scope 也没用——报错形如 "refusing to allow an OAuth App to create or update workflow"。**推 workflow 改动必须挂 Clash 直推 `https://github.com/...`**（`HTTPS_PROXY=http://127.0.0.1:7890 git push https://github.com/cornpiess/camera_ccd.git main`）。凭据注意：这台机器的 git 走 GCM 存的旧凭据，`gh auth refresh` 刷新的是 gh 钥匙串——已配置 github.com 与 gh-proxy.com 的 credential helper 指向 `gh auth git-credential`（见 `git config --global --get-regexp credential`）；换新机器要先 `gh auth login` + `gh auth setup-git`，并确保 token 带 `workflow` scope。

18. **生产配置（无 CAMERA18_TESTING）从未被编译过，直到 `ios-appstore.yml` 首跑**：TestFlight 流水线固定注入测试标志，正式包路径（如 `setMockApertureMode` 入口的 `#if` 缺口）只有不带标志才暴露。**上架提审一律用 `ios-appstore.yml` 的构建（build number = run number + 10000）**，不要拿 TestFlight 构建提审；该流水线首跑若报编译错误，按日志修源码，**禁止把测试标志加回去**。

19. **松手回弹的真根因是 settle 坐标系镜像反转（2026-09-18 定案），不是竞态**：`tRef` 存的是**刻度带坐标**（0=ƒ/lo 大光圈端，1=ƒ/hi 小光圈端），而 `settleAtLastPosition` 一直写成 `toF(logLo + (1 - t) * span)`——把 t 当 openness 用，**每次松手提交的都是手指位置关于刻度尺中点的镜像值**（拖到 ƒ/1.5 松手 → 提交 ƒ/3.95≈ƒ/4；拖到 ƒ/1.6~1.7 → ƒ/3.5~ƒ/3.7）。拖动过程中的数值是对的（move 公式正确），只在松手/terminate 瞬间跳到镜像端点；轻点条带切侧视图也会顺带提交镜像光圈。它自 `settleAtLastPosition` 诞生（20dcee6）就是反的，**与设备无关、与 mock 无关**——#16 的手指总闸/序号修的是真实但次要的异步竞态，量程探针修的是真实但独立的端止挡问题，都治不了这个确定性数学错误；18 Pro 真机上它曾被「accepted range 端止挡 ƒ/3.8」掩盖成硬件拒绝假象。正确公式：`toF(logLo + t * span)`。**改 settle/带坐标换算前先推导一遍方向**（move 写 `t=(log f−logLo)/span`，effect 读 `t=1−openness`，settle 用 `f=toF(logLo+t·span)`，三方必须同轴）。附带修复：`setDraggingState` 改走 `dragValuesRef` 镜像（PanResponder 只许创建一次，缺依赖警告不许用「加进 useMemo deps」来修——那会复活 build 42 前的 dx 重置拖不动 bug）。

---

## 五、当前支持的 8 个公开相机模式

| id（持久化键，勿改） | 显示名 | 拨盘缩写 | LUT | 推荐光圈 | 风格特征 |
|---|---|---|---|---|---|
| ricoh_positive | GRIT P | GRP | ricoh-positive | ƒ/2.8 | 高饱和、高反差正片风（Ricoh 正片性格） |
| ricoh_negative | GRIT N | GRN | ricoh-negative | ƒ/2.8 | 低反差、清冷泛青负片风（Ricoh 负片性格） |
| canon_portrait | SKIN C | SKC | canon-g7x2 | ƒ/1.8 | 温暖肤色、微发色（Canon 人像性格） |
| fuji_classic_chrome | CC | CC | fuji-classic-chrome | ƒ/4 | 低饱和纪实青灰调（Fuji Classic Chrome 方向） |
| fuji_classic_negative | NC | NC | fuji-classic-negative | ƒ/2.8 | 强红黄硬调暗部偏绿（Fuji Classic Negative 方向） |
| leica_m9 | M-RF | MRF | leica-m9 | ƒ/1.8 | CCD 浓郁暗部沉降（Leica M /旁轴性格） |
| mf50 | V-MF | VMF | **null（无 LUT）** | ƒ/2.5 | 自然中画幅（Hasselblad V /中画幅性格） |
| negative_film | ORIG | ORIG | **null + passthrough:true** | —（无 aperture 字段） | **纯直通**：Apple 原图原样落盘，不进渲染器 |

- 显示名/缩写可以改 JSON（`name`/`displayName`/`ui.shortName`）；**`id` 是持久化键**（上次用的相机、每相机光圈记忆都按 id 存），改 id 会作废用户数据。
- 8 台只引用 57 个 LUT 中的 6 个；其余是校准工作流资产（LUTLoader 8 槽 LRU 兜底），51 台旧目录备份在 `.backup-51-profiles/`。
- `signatureAperture`（`aperture.preferred`）在可变光圈硬件上是**真实推荐光圈**：切换 Profile → clamp → 真实 `setAperture` → 硬件回读同步 UI；固定镜头不显示不应用；ORIG 没有。

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

# 5. iOS 离线导出与链接验证 (实测基线：747 modules，2026-09-17；脚本门槛是 ≥619 的宽松下限)
npx expo export --platform ios --output-dir dist-check
rm -rf dist-check
```

```powershell
# 第 1-4 步同上；第 5 步的 PowerShell 写法：
npx expo export --platform ios --output-dir dist-check; if (Test-Path dist-check) { Remove-Item -Recurse -Force dist-check }
```

> ⚠️ **第 5 步的模块数实测基线是 `747 modules`**（2026-09-17，随物理路由迭代从 748 变化；脚本门槛是 ≥619 的宽松下限）。若数字异常变化，说明有文件被误删或被意外引入，需要先查清再提交。
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
  - Swift 改动（光圈探针、deharsh、生产编译修复）已过 `npm run verify` 与括号配平，但**尚未出包**——下一轮 TestFlight 即验证。
  - **`ios-appstore.yml` 从未运行过**：生产配置的首次真编译。首跑报错按日志修源码，禁止把 `-DCAMERA18_TESTING` 加回去。
- **待普通 iPhone 真机验证（build 78 之后合并清单）**：
  - 切焦：13mm/Tele 换 input 的 150ms crossfade 无黑闪；切后短暂禁拍的手感；26/35/52 三档互切不闪、不清用户光圈。
  - 快门：连拍响应（balanced + ZSL/Responsive/Fast Capture）；后台保存时快门可再按；缩略图 chip 经 `onPhotoProcessed` 正常刷新。
  - EXIF：Tele 档相册显示真实等效焦距；13/26/35/52 各档对质。
  - ORIG：出片与系统相机原图观感一致（无二次压缩痕迹）。
  - 回归哨兵：授权 → 预览首帧；PhotoKit add-only 弹窗；前台恢复后焦段/预览正常。
- **待 iPhone 18 Pro 真机验证（本轮重点）**：
  - **光圈量程探针**：启动/切镜后 getCapabilities 无可感延迟（首跑多 27 次 format 级查询）；刻度尺端点 = 实测可接受边界；拖到端点不回弹、原生夹取生效。
  - **连续滑动回弹**：松手立刻再拖、反复来回扫——值不得中途跳到旧 f-number（修复前：滑到 ƒ/4 跳回 ƒ/1.5，反之亦然）。
  - **V-MF 管线**：VMF_HN_33_v2 LUT 成片色彩正确（intensity 1.0）；deharsh 0.04 高光无生硬色偏且不压亮度；与预览的差异仅限纹理级（deharsh 仅成片，属预期）。
  - 物理可变光圈全链路：Profile 切换真实应用 signatureAperture（Fixed→Wide 切回联动）；`setExposureModeCustom(lensAperture:)` 光圈优先（shutter/ISO 保持 AUTO）；SIG 标记与硬件回读一致。
  - 测试门：版本号 7 连点解锁 mock 行与校准台；重启 app 后重新隐藏；TestFlight 构建可用、生产构建（ios-appstore.yml）里手势无效。
  - Wide 上的 26/35/52 共享同一真实光圈语义（不因 crop 重置）。
- **上架前（App Store Connect 侧，用户操作）**：名称查重、类别 Photo & Video、4+ 分级、截图（6.9 吋）；隐私标签「不收集数据」，Privacy Policy / Support URL 填 cornpiess.github.io/camera18/ 对应页；描述文案不得出现第三方相机品牌名。
