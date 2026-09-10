# 项目长期记忆 — Aperture Camera

> 权威交接文档是根目录 `HANDOVER.md`，每轮上工前必须先通读。本文件只记录补充约定，不取代 HANDOVER.md。

## 项目本质
- iPhone 18 Pro / Pro Max **物理可变光圈** 复古胶片拟真相机。
- 唯一交互链路：「选相机 → 拧光圈 → 拍照」。其余全自动（AF/AE/ISO/快门/AWB/防抖）。
- 用户只控制两件事：8 个相机 Profile（`assets/camera-profiles.json`）、光圈 f-stop。

## 技术栈与环境
- Expo SDK 55 + RN 0.83.10 + React 19.2.0 + TypeScript strict。
- 原生：本地 Expo Module `modules/camera-engine`（Swift + AVFoundation + Core Image + PhotoKit）。
- 在 Windows 开发，**没有本地 Xcode**，不能跑 `expo run:ios`。
- 必须 Development Build，Expo Go 无法加载本地 Swift 模块。
- **本机也跑不了 `npx expo prebuild --platform ios`**：Expo 会直接跳过 iOS 工程生成（"Skipping generating the iOS native project files"）。故 `app.json` 的原生键值在本机只能弱验证（`npx expo config --type prebuild`）+ CI 强验证。

## 应用身份（2026-09-10 定案）
- `expo.ios.bundleIdentifier` = **`com.cornpiess.rainbowcamera`**（原 `com.example.aperturecamera`；Apple 禁注册 `com.example` 前缀）。
- 主屏幕显示名 = **彩虹相机**，通过 `ios.infoPlist.CFBundleDisplayName` 设置。
- `expo.name` = **`Rainbow Camera`**，**必须保持 ASCII**：Xcode 侧 `PRODUCT_NAME` 由 `sanitizedName(expo.name)` 生成，中文字符会被 `/[^\W_]+/g` 过滤干净 → 回退成字面量 `app`。中文名只能走 `infoPlist.CFBundleDisplayName`（该覆盖被 config-plugins 的 property guard 正式支持）。
- `expo.slug` 刻意保持 **`aperture-camera`** 不变 —— 它是稳定机器标识，与显示名解耦。
- CI 产物名 = `RainbowCamera-dev.ipa`，workflow 内 **6 处必须同步**：`cp` / `unzip` / OTA `IPA_URL` / `gh release` 上传两处 / artifact path。

## 红线（不可违反）
1. 除非用户明说「现在可以打包」，**禁止执行任何 `eas build` / `npm run build:ios:dev` / `eas build --local`**（EAS 免费配额仅 15 次/月 iOS）。**日常出包走 GitHub Actions CI**（`.github/workflows/ios-dev-build.yml`），它不调用 EAS、不占配额——见文末「出包路径」。
2. 8 台相机必须共用 `ProfileRenderer.apply`，**禁止**为某个品牌写原生 `switch-case` 分支；风格只由 JSON 定义。
3. `CIContext` 必须保持静态共享（`PhotoCaptureDelegate.sharedContext`），**禁止**改回每次快门 `new CIContext()`。
4. 无物理可变光圈硬件时，UI 显示 `Fixed ƒ/x` 并锁定光圈交互，**严禁做纯软件假虚化**。
5. 不引入过度设计：无手动 ISO/快门/WB/EV、无滤镜选择器、无后期编辑器、无 AI 增强、无取景网格/水平仪、无账号/云同步、无 Redux/Zustand。

## 当前真实硬件状态
- `ApertureController.getCapabilities` **恒返回 `supportsVariableAperture = false`**（诚实桩，等 Apple 公开可变光圈 API）。
- `setAperture` 恒抛出 `ERR_APERTURE_UNSUPPORTED`。故目前真机上光圈控件始终是 `Fixed ƒ/x`。
- `App.tsx` 里的 `deriveVariableApertures()` 属于预留逻辑，当前不可达。

## 本地静态验证（改完必跑）
```
npm run typecheck   # tsc --noEmit
npm run lint        # expo lint
npm run doctor      # 需保持 20/20
npx expo install --check
npx expo export --platform ios --output-dir dist-check   # 验证完删掉 dist-check
```
凡需要真机/Xcode 的结论，一律在汇报里标注 `待 CI 构建验证`（走 CI 路径时）或 `待 EAS Build 验证`（走 EAS 路径时）。

### 注意：`npm run lint` 无输出 ≠ 没跑
ESLint 无问题时就是零输出。想确认真扫了文件，用：
`npx eslint src App.tsx -f json`，看返回数组的 `filePath` 条目数与 `errorCount`。

### Windows 上没有 Swift 编译器，改完 .swift 怎么自检
本机无 `swift`/`swiftc`，`CameraEngineModule.swift` 只能做**结构冒烟检查**：写一个词法扫描器依次跳过
`//` 行注释、`/* */` 块注释、`"..."` 字符串，并对字符串插值 `\(...)` 单独压栈，然后核对
`{} () []` 是否配平。**第一次实现踩过坑**：不能用「插值深度计数器」，因为 `"\(UUID().uuidString)"`
里 `UUID(` 的 `)` 会被误判为插值结束；必须把插值本身也当一个栈帧，靠**栈帧类型**判断哪个 `)` 收尾。
没有配平检查的 Swift 改动，绝不能只凭肉眼下结论。语法/类型是否真通过，只能用 CI 构建（或 EAS）。

### 同一个文件不要在一轮里并行发两个 Edit
并行编辑同一文件会互相覆盖：先发的那次（尤其 `replace_all` 批量改名）会被后发的按旧内容写回，**工具仍报 success**。跨文件可并行，同文件必须串行，改完 grep 复核。

## 协作流程约定
- 用户在多台电脑、用不同 AI 轮流维护。上工时先通读 `HANDOVER.md`，汇报按四档分级：「待 CI 构建验证 / 待 EAS Build 验证 / 待普通 iPhone 真机验证 / 待 iPhone 18 Pro 真机验证」。
- 反馈方式：用户以编号列表提问题，逐条修复并验证后再出下一版。
- 交流语言：中文。回复风格：简洁 + 结构化要点。

## 出包路径（2026-09-10 新增）
- **仓库已由 private 改为 public**，为的是用 GitHub Actions 免费 macOS runner 出 iOS 包，绕开 EAS 每月 15 次 iOS 的硬墙。
- 出包走 `.github/workflows/ios-dev-build.yml`：`workflow_dispatch` **手动触发**（❌ 严禁加 push/schedule 自动触发）；不依赖 EAS/Expo 登录态，因此与红线 1 无冲突。
- 签名用 App Store Connect API Key + `-allowProvisioningUpdates`（Xcode 云端自建证书与 Ad Hoc 描述文件）；**不要改成手动搬 `.p12` + keychain**，Windows 环境做不了。
- 前置条件：public 仓库 ✅、`bundleIdentifier` 非 `com.example.*` ✅（已设 `com.cornpiess.rainbowcamera`）、**4 个 secrets（待用户配）**、**目标 iPhone UDID（待登记）**。详见 `README.md` 的 CI 章节与 `AGENTS.md` 第 1.1/1.2 节。
- 产物：每次构建出 `dev-r<序号>` Release（`.ipa` + OTA `manifest.plist`），iPhone 用 **Safari** 打开 `itms-services://` 链接即装。

## ⚠️ 公开仓库安全约定（重要）
- 仓库 public 后**所有提交内容全网可见**，且 `.workbuddy/memory/*.md` **是被 git 跟踪的**（会被一起公开）。
- 因此：**绝不**在入库文件（含记忆文件）里写密钥、token、密码、真实个人信息。CI 密钥只放 GitHub Secrets。
- 2026-09-10 已扫描当前工作树：**未发现任何密钥或凭据泄漏**（仅出现过 GitHub 账号名 `cornpiess`，而它本就在仓库 URL 里）。
- 记忆文件是否继续入库（跨机同步记忆 vs 不再公开）**待用户决定**。

