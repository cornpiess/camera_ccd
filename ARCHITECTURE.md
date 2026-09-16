# Camera 18 技术架构（供外部评审）

> 定位：iOS 相机应用，产品主张是「8 台经典相机的色彩/质感模拟 + 真实光圈控制」，
> 明确不做：手动快门/ISO/EV、滤镜选择器、后期编辑器、AI 增强、软件假虚化。
> 本文基于当前工作区代码（2026-09-17），供相机系统专家评审。

## 1. 总体分层

```
React Native (Expo, TypeScript)          —— UI / 状态 / Profile JSON 校验
        │  expo-modules 自动链接
        ▼
camera-engine（本地 pod，Swift，无第三方依赖）—— AVCaptureSession 全权接管
        │
        ▼
AVFoundation / Metal / CoreImage / PhotoKit
```

- 单一原生模块 `CameraEngineModule`（`modules/camera-engine/ios/`）持有 session；
  JS 侧 `src/camera/CameraEngine.tsx` 只是类型化桥。UI 不碰任何原生对象。
- 出包：GitHub Actions macOS runner（public 仓库）`expo prebuild + xcodebuild`，
  TestFlight / Ad Hoc 两条 workflow；不用 EAS。

## 2. Capture Session 拓扑（物理镜头路由）

```
AVCaptureSession (preset .photo)
 ├─ input : 物理镜头（绝不用 virtual triple/dual 作为 input）
 │    13mm       → builtInUltraWideCamera
 │    26/35/52mm → builtInWideAngleCamera（一个物理主摄）
 │    Tele       → builtInTelephotoCamera
 ├─ output: AVCapturePhotoOutput   （成片，唯一真相源）
 └─ output: AVCaptureVideoDataOutput（取景器，BGRA，设备级 30fps 上限）
```

- **26/35/52 三档共用物理主摄**：只改 `videoZoomFactor`（1.0 / 35/26 / 2.0），
  不换 input——主摄的真实可变光圈（若硬件支持）天然服务三档。
- **13mm / Tele 切换才换 input**：`beginConfiguration → removeInput → addInput →
  commitConfiguration`，之后对新设备重跑 applyAutoModes（AF/AE/AWB 全自动）、
  30fps 上限、zoom=1.0、orientation、Camera Control 重建、光圈能力重判。
- 焦段档位 capability-driven：设备没有对应物理镜头，档位直接隐藏。
- virtual triple/dual 设备只用来读 tele 的 native 倍数（switchover factor），
  用于推导 tele 等效焦距，**从不作为 capture input**。

## 3. 曝光模型：Aperture Manual / Shutter AUTO / ISO AUTO

- 常规路径：`.continuousAutoFocus / .continuousAutoExposure /
  .continuousAutoWhiteBalance`，代码从不设置任何曝光时长、ISO、EV。
- **光圈优先（仅物理主摄、iOS 27+ 硬件支持时）**：

```
setExposureModeCustomWithLensAperture:duration:ISO:
  lensAperture = clamp(用户值, minLensAperture, maxLensAperture)
  duration     = AVCaptureDevice.autoExposureDuration   （AUTO 哨兵）
  ISO          = AVCaptureDevice.autoISO               （AUTO 哨兵）
```

- 能力判定五条件全过才报告 variable：range 非退化 + `recommendedLensApertureStops
  >1` + setter selector 存在 + `supportsExposureModeCustom(lensAperture:...)` 对
  activeFormat 实测通过 + auto 哨兵存在。缺一即诚实报告 fixed。
- 哨兵获取失败 → 直接 `ERR_APERTURE_UNSUPPORTED`，**故意不做**任何
  currentExposureDuration/currentISO 回退（历史 bug：冻结快门/ISO 导致收缩光圈
  画面变暗）。无软件曝光补偿，无自研 AE。
- iOS 27 符号全部动态调用（KVC / NSSelector / class IMP），任何 Xcode 26+ 可编译。

## 4. 快门响应策略

- `maxPhotoQualityPrioritization = .balanced`（output 级 + 逐张 settings 级），
  在 Apple 多帧融合质量与 capture latency 之间取系统推荐平衡；不用 .speed。
- Fast-capture 三件套（configureSession 内、startRunning 前，一次性，全 capability 门控）：
  - Zero Shutter Lag：`isZeroShutterLagSupported` 才开（iOS 17+）；
  - Fast Capture Prioritization：`isFastCapturePrioritizationSupported` 才开（iOS 17+）；
  - Responsive Capture：iOS 26 期 API，responds+KVC 动态探测后才开。
- **Deferred photo delivery 保持关闭**：产品要求照片同步回到
  `didFinishProcessingPhoto`（全图 → Camera DNA → HEIF → PhotoKit 单阶段），
  不引入 proxy/final 双阶段。
- 已知取舍：24MP 全分辨率在 App 内做一次 decode → CIImage 渲染 → HEIF 编码，
  这段延迟仍在快门 promise 路径上（见 §7 开放问题）。

## 5. 成片管线（一解码、一渲染、一编码）

```
AVCapturePhotoOutput (Apple processed photo, JPEG 源)
  → CIImage (applyOrientation)
  → CameraDNARenderer(.final)：
       LUT .cube (CIColorCube, 按 lutIntensity 向恒等插值稀释)
       + 细分色彩 (hueBands) + tone curve（恰好 5 点，原生渲染器要求）
       + 仅成片阶段：detail/deharsh、完整颗粒、halation
  → HEIF 0.95（不可用则 JPEG 0.95 fallback）
  → PhotoKit 保存；EXIF 盖戳 FocalLengthIn35mmFilm
```

- 预览：VideoDataOutput → CIImage → **同一个** CameraDNARenderer(.preview)
  （共享阶段：LUT/曝光/色彩/色调/对比/暗角；颗粒/halation 仅成片）→ MTKView。
  取景与成片共用同一套 Color/Tone 管线（Color/Tone WYSIWYG——颗粒/halation/detail 仅成片，不宣称完整像素级 WYSIWYG）。
- **静态共享 CIContext**（红线：禁止逐张 new，防显存泄露被 Jetsam 杀）。
- 预览流按 previewCap 在管线头部降采样；成片全程全分辨率，管线有分辨率回归断言。

## 6. Profile 系统（8 模式）

- `assets/camera-profiles.json` 单文件定义全部风格：GRIT P/GRIT N/SKIN C/CC/NC/
  M-RF/V-MF/ORIG（passthrough）。**加相机只改 JSON，原生零分支**（架构红线）。
- 字段：LUT + lutIntensity、tone(5 点曲线)、hueBands(细分色彩)、texture(颗粒/
  暗角/halation)、signatureAperture（该镜头的经典光圈，切 Profile 时光圈环
  吸附参考，不强制）、ui.accent（界面 chrome 主题色）。
- `src/profiles/validation.ts` 强 schema 校验（曲线必须恰 5 点、lut 文件存在性、
  lutIntensity∈[0,1] 等），非法文档在校验层直接报错，不放行到渲染。
- ORIG 为纯 passthrough：无 LUT、无 aperture 字段（校验器允许缺失）。

## 7. 开放问题 / 已知取舍（请专家重点评审）

1. **物理 input 切换的延迟与预览闪断**：13mm↔Wide↔Tele 换 input 有一次
   beginConfiguration 代价（相对 virtual device 的无缝 crossfade 是退让），
   这是产品确定性（每档对应确定物理镜头+确定光圈语义）换来的，接受度请评估。
2. **Tele 档 EXIF 焦距盖戳已知错误**：`capture()` 里 `baseEquivalentMM` 按
   deviceType==wide?26:13 取值，物理 tele input（zoom=1.0）会被盖成 13mm 而非
   真实 tele 等效焦距。已识别，待修（一处映射表的事）。
3. **快门 promise 包含 App 内后处理**：balanced + ZSL 已把采集段压短，但
   24MP CIImage 渲染 + HEIF 编码仍在 promise 路径；进一步缩短需 preview 尺寸
   伴生图或 deferred（产品当前明确不要）。
4. **光圈洞/侧视图的绝对 f 映射**（f/1.48–f/4 参考量程）是纯展示层约定，
   与硬件无关，请评估其产品诚实性表述是否成立（DEMO 模式明示）。
5. Mock aperture（CAMERA18_TESTING，仅测试包编译）只改 UI 状态机，从不碰
   硬件/成片——用于普通 iPhone 验收可变光圈 UI。正式包该代码不编译。

## 8. 质量与验证纪律

- 本机（Windows，无 iOS SDK）：`npm run verify`（tsc/lint/expo-doctor）+
  `npm run prepackage`（export 模块数基线、Swift 括号配平、LUT/Profile 校验、
  autolinking、密钥扫描）。Swift 语法只能 CI 实锤。
- 每次拍照 diag 日志输出 photoDimensions/ISO/曝光时间（EXIF），用于线上分诊。
- 真机验收清单（TESTING.md）：授权→取景→主交互冒烟、拍照入库、光圈手感、
  切焦恢复、Camera Control 滑条联动。
