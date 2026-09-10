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

## 红线（不可违反）
1. 除非用户明说「现在可以打包」，**禁止执行任何 `eas build` / `npm run build:ios:dev`**（EAS 次数受限）。
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
凡需要真机/Xcode 的结论，一律在汇报里标注 `待 EAS / 真机验证`。

### 注意：`npm run lint` 无输出 ≠ 没跑
ESLint 无问题时就是零输出。想确认真扫了文件，用：
`npx eslint src App.tsx -f json`，看返回数组的 `filePath` 条目数与 `errorCount`。

### Windows 上没有 Swift 编译器，改完 .swift 怎么自检
本机无 `swift`/`swiftc`，`CameraEngineModule.swift` 只能做**结构冒烟检查**：写一个词法扫描器依次跳过
`//` 行注释、`/* */` 块注释、`"..."` 字符串，并对字符串插值 `\(...)` 单独压栈，然后核对
`{} () []` 是否配平。**第一次实现踩过坑**：不能用「插值深度计数器」，因为 `"\(UUID().uuidString)"`
里 `UUID(` 的 `)` 会被误判为插值结束；必须把插值本身也当一个栈帧，靠**栈帧类型**判断哪个 `)` 收尾。
没有配平检查的 Swift 改动，绝不能只凭肉眼下结论。语法/类型是否真通过，只能用 EAS。

## 协作流程约定
- 用户在多台电脑、用不同 AI 轮流维护。上工时先通读 `HANDOVER.md`，汇报按「待 EAS Build 验证 / 待普通 iPhone 真机验证 / 待 iPhone 18 Pro 真机验证」三档分级。
- 反馈方式：用户以编号列表提问题，逐条修复并验证后再出下一版。
- 交流语言：中文。回复风格：简洁 + 结构化要点。
