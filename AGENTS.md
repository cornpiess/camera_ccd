# AGENTS.md — 跨 AI 硬规则清单

> 本文件面向在本仓库工作的任意 AI Agent。**开工前必须读完本文件**，再读 [`HANDOVER.md`](./HANDOVER.md) 获取完整背景。
> 两者冲突时，**以本文件的红线为准**。

---

## 0. 开工第一步：先同步，再动手

```bash
git pull --rebase   # 落后状态下禁止改任何代码
npm install         # 仅当 package-lock.json 有变更
npm run verify      # 确认基线全绿
```

**收工**：

```bash
npm run verify      # 必须全绿
git add -A
git commit -m "..."  # 一次逻辑改动 = 一个提交
git push             # 不 push = 另一台机器/另一个 AI 永远看不到，等于没做
```

- ❌ 禁止 `git push --force`（除非用户明确要求）。
- ❌ 禁止提交 `node_modules/`、`.expo/`、`dist-check/`、证书或密钥。

---

## 1. 四条硬红线（违反即回退）

| # | 红线 | 原因 |
|---|---|---|
| 1 | **禁止打包**：不得执行 `eas build` / `npm run build:ios:dev` / `npx eas build`，除非用户**明确说出「现在可以打包」** | EAS 次数受限，误触发要重新排队 |
| 2 | **禁止品牌分支**：不得为 Leica / Fuji / Ricoh 等任何品牌在原生层写 `switch-case`。8 台相机必须共用 `ProfileRenderer.apply`，风格**只由 `assets/camera-profiles.json` 定义** | 加新相机必须只改 JSON |
| 3 | **禁止改回非共享 `CIContext`**：必须保持 `PhotoCaptureDelegate.sharedContext` 静态共享，不得在每次快门时 `new CIContext()` | 连续拍照会显存泄露并被 iOS Jetsam 杀进程 |
| 4 | **禁止假虚化**：无物理可变光圈硬件时，UI 必须显示 `Fixed ƒ/x` 并锁定光圈交互，**严禁做纯软件景深/背景虚化** | 产品诚实性 |

## 2. 禁止过度设计

不得引入：手动 ISO / 快门 / WB / EV、滤镜选择器、滤镜强度滑块、后期编辑器、AI 增强、直方图、网格水平仪、Pro Mode、镜头切换、账号体系、云同步、Redux / Zustand。

**用户只控制两件事**：相机型号（8 个 Profile）+ 光圈 f-stop。其余（AF / AE / ISO / 快门 / AWB / 防抖）全自动。

---

## 3. 本地静态验证（改完必跑）

```bash
npm run verify      # = typecheck + lint + doctor，三项必须全绿
```

逐项（排查失败时用）：

| 命令 | 通过标准 |
|---|---|
| `npm run typecheck` | `tsc --noEmit` 无输出 |
| `npm run lint` | 0 error 0 warning |
| `npm run doctor` | **20/20 checks passed** |
| `npx expo install --check` | 依赖版本一致 |
| `npx expo export --platform ios --output-dir dist-check` | **607 modules**（基线，数字异常先查清原因）；用完 `rm -rf dist-check` |

**Swift 代码**：本机（Windows）**没有 `swift` / `swiftc`**。只能做括号/字符串配平级别的结构自查，**语法与类型只能等 EAS Build**。

---

## 4. 汇报纪律

任何涉及真机或 Xcode 的结论，**必须**明确标注下列分级，**不得声称「已验证通过」**：

- `待 EAS Build 验证` — Swift 能否编译、podspec 能否集成
- `待普通 iPhone 真机验证` — 取景器 Overlay 流畅度、ProRAW 捕获、相册权限、三指长按呼出校准面板
- `待 iPhone 18 Pro 真机验证` — 物理可变光圈叶片联动与真实景深/星芒

诚实桩须知：`ApertureController.getCapabilities` 当前**恒返回 `supportsVariableAperture = false`**，`setAperture` 恒抛 `ERR_APERTURE_UNSUPPORTED`。这是等 Apple 公开可变光圈 API 的**刻意设计，不是 bug**；`App.tsx` 的 `deriveVariableApertures()` 因此当前不可达。

---

## 5. 容易踩的坑（改相关文件前先看 HANDOVER.md 第四节）

1. `didFinishProcessingPhoto` 里 `if expectedPhotoCount > 1 && !isRaw { return }` 必须在 `guard error == nil` **之前**。
2. 拍摄 Promise 必须有兜底（原生 `didAcceptAnyPhoto` + JS 20s 超时），否则快门会永久卡死。
3. `App.tsx` 的 `previewPanResponder` 必须保留 `onPanResponderStart` 里的多指守卫——`onPanResponderGrant` 的同类守卫是**死代码**，第 2、3 指落下时它不会重跑。
4. 八台相机的风格只改 `assets/camera-profiles.json`。**改 JSON 后必须验证 `tone.curve` 恰好 5 个点**——原生 `toneCurve` 要求 5 点，否则静默丢弃整条曲线（当前 `validation.ts` 只校验 `>= 2`，保护不足）。

---

## 6. 交流约定

- 语言：**中文**。风格：简洁、结构化要点、不客套。
- 用户以**编号列表**提问题 → 逐条修复并验证后再出下一版。
- 改完要能说清「改了什么文件 + 为什么 + 验证结果 + 哪些还挂在待真机」。
