# AGENTS.md — 跨 AI 硬规则清单

> 本文件面向在本仓库工作的任意 AI Agent。**开工前必须读完本文件**，再读 [`HANDOVER.md`](./HANDOVER.md) 获取完整背景。
> 两者冲突时，**以本文件的红线为准**。
>
> ⚠️ **本仓库是 Public 仓库**（2026-09-10 从 private 改为 public，为的是用 GitHub Actions 免费 macOS runner 出包）。
> 所有提交内容**对全网可见且会被搜索引擎/爬虫收录**。因此：任何密钥、凭据、token、账号信息、个人信息
> **一律不得**写入任何会入库的文件——**包括 `.workbuddy/memory/` 下的记忆文件**（这些文件是被 git 跟踪的）。
> CI 用的密钥只放 GitHub Secrets。

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

### 0.1 拉不动 / 推不上去时（中国大陆网络，先看这段）

`github.com` 常被单独阻断，而 `api.github.com` / `raw.githubusercontent.com` / `codeload.github.com` 往往仍可访问。**只有 `github.com` 不通是正常现象**，不代表整台机器断网。

遇到 `CONNECT tunnel failed`、`Connection was reset`、`schannel: failed to receive handshake`、`could not read Username` 或直接挂死时，按顺序来：

**第 1 步 · 先确认代理出口是活的**（Clash 系默认 `127.0.0.1:7890`，端口不同自行替换）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" -x http://127.0.0.1:7890 https://github.com/
```

期望 `200`。**若是 `000`，说明代理根本没连上节点——先去修代理/VPN，不要在 git 上折腾。**

**第 2 步 · 让 git 显式走代理**（不动全局配置，只对单条命令生效）：

```bash
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 pull --rebase
```

**第 3 步 · 凭据助手卡住时，绕过它**。本机装的是 GCM，但 git 的 helper 选择器有时会挂死；直接调 GCM 取凭据反而正常：

```bash
GCM="$(dirname "$(dirname "$(git --exec-path)")")/bin/git-credential-manager.exe"
printf "protocol=https\nhost=github.com\n\n" | GCM_INTERACTIVE=never "$GCM" get
```

拿到 `username` / `password` 后，用**只对这一条命令生效**的 helper 推送：

```bash
git -c http.proxy=http://127.0.0.1:7890 -c credential.helper= -c credential.helper="$GCM" push origin main
```

> ⚠️ **不要把代理写进 `.git/config`，也不要提交任何代理或密钥配置。** 换机器 / 换网络立刻失效，还会污染仓库。

> ⚠️ 若本机 shell 里存在别处注入的 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量且指向不可用的端口，它会覆盖你的显式设置。排查时先 `env | grep -i proxy` 看一眼，必要时用 `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy git ...` 清掉。

---

## 1. 四条硬红线（违反即回退）

| # | 红线 | 原因 |
|---|---|---|
| 1 | **禁止 EAS 云端打包**：不得执行 `eas build` / `npx eas build` / `npm run build:ios:dev` / `eas build --local`，除非用户**明确说出「现在可以打包」**。日常出包走第 1.1 节的 CI 路径 | EAS 免费配额仅 **15 次/月 iOS**，误触发要重新排队 |
| 2 | **禁止品牌分支**：不得为 Leica / Fuji / Ricoh 等任何品牌在原生层写 `switch-case`。8 台相机必须共用 `ProfileRenderer.apply`，风格**只由 `assets/camera-profiles.json` 定义** | 加新相机必须只改 JSON |
| 3 | **禁止改回非共享 `CIContext`**：必须保持 `PhotoCaptureDelegate.sharedContext` 静态共享，不得在每次快门时 `new CIContext()` | 连续拍照会显存泄露并被 iOS Jetsam 杀进程 |
| 4 | **禁止假虚化**：无物理可变光圈硬件时，UI 必须显示 `Fixed ƒ/x` 并锁定光圈交互，**严禁做纯软件景深/背景虚化** | 产品诚实性 |

### 1.1 日常出包：走 GitHub Actions，不占 EAS 配额

`.github/workflows/ios-dev-build.yml` 在 GitHub 的 macOS runner 上直接 `expo prebuild` + `xcodebuild` 出 `.ipa`，
**不调用 EAS、不依赖 Expo 登录态，因此不消耗 EAS 配额**——它是红线 1 的替代路径，不是例外。

- **触发方式只有 `workflow_dispatch`（手动）**。❌ **严禁给它加 `push` / `schedule` 自动触发**：构建成本高，出包必须由用户显式发起，这条与红线 1 的精神一致。
- **前置条件**（缺任何一项 workflow 会在 30 秒内 preflight 失败）：仓库为 public、`app.json` 的 `bundleIdentifier` 不是 `com.example.*`、4 个 repository secrets 已配置、目标 iPhone 的 UDID 已登记。详见 `README.md` 的 `CI: iOS dev builds on GitHub Actions`。
- **密钥只放 GitHub Secrets**：`ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_P8`（含私钥）/ `APPLE_TEAM_ID`。**任何情况下都不得把它们写进仓库、日志或记忆文件**。
- **签名机制**：用 App Store Connect API Key + `-allowProvisioningUpdates`，让 Xcode 在云端自行创建/复用分发证书与 Ad Hoc 描述文件。**不要在 CI 里改成手动搬 `.p12` + keychain**——那是给有 Mac 的自托管 runner 用的，本环境（Windows）做不了。
- **产物与装机**：每次成功构建创建一个 `dev-r<序号>` Release（含 `.ipa` + OTA `manifest.plist`），run summary 里给出 `itms-services://` 链接，iPhone 用 **Safari** 打开即装（微信/QQ 内置浏览器不支持）。

### 1.2 改 CI workflow 后的验证义务

GitHub Actions 的 workflow 只能靠实跑验证，但**能静态验的部分必须先验**，别把 YAML 错误推到云端：

```bash
# YAML 结构 + shell 语法（本机即可跑，两项都过了再提交）
node -e "const Y=require('yaml'),fs=require('fs');const d=Y.parse(fs.readFileSync('.github/workflows/ios-dev-build.yml','utf8'));console.log('YAML OK',d.jobs.build.steps.length)"
```

要点：`run: |` 块里的 heredoc，**结束标记（如 `PLIST`）在 YAML 块标量处理后必须落在行首**，否则 shell 语法静默错误。新增/修改 heredoc 时逐个用 `bash -n` 过一遍。

---

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

**Swift 代码**：本机（Windows）**没有 `swift` / `swiftc`**。只能做括号/字符串配平级别的结构自查，**语法与类型只能等 CI 构建（或 EAS Build）验证**。

**原生配置（`app.json` 的 `ios.*`）**：本机也验不了。Expo 在 Windows 上会直接跳过 iOS 工程生成：

```
⚠️  Skipping generating the iOS native project files. Run npx expo prebuild again from macOS or Linux
```

所以 `bundleIdentifier` / `Info.plist` 键值是否真的落进 `Info.plist`，只能靠 `npx expo config --type prebuild` 看解析结果（弱验证）+ CI 上首次构建（强验证）。

---

## 4. 汇报纪律

任何涉及真机或 Xcode 的结论，**必须**明确标注下列分级，**不得声称「已验证通过」**：

- `待 CI 构建验证` — 本机（Windows）验不了的一切：Swift 能否编译、podspec 能否集成、CocoaPods 能否装上、`xcodebuild` 能否签出 Ad Hoc 包。**走 CI 路径时用这一档。**
- `待 EAS Build 验证` — 同上，但仅在使用 EAS 路径、需要验证 EAS 侧配置时适用。
- `待普通 iPhone 真机验证` — 取景器 Overlay 流畅度、ProRAW 捕获、相册权限、三指长按呼出校准面板。
- `待 iPhone 18 Pro 真机验证` — 物理可变光圈叶片联动与真实景深/星芒。

诚实桩须知：`ApertureController.getCapabilities` 当前**恒返回 `supportsVariableAperture = false`**，`setAperture` 恒抛 `ERR_APERTURE_UNSUPPORTED`。这是等 Apple 公开可变光圈 API 的**刻意设计，不是 bug**；`App.tsx` 的 `deriveVariableApertures()` 因此当前不可达。

---

## 5. 容易踩的坑（改相关文件前先看 HANDOVER.md 第四节）

1. `didFinishProcessingPhoto` 里 `if expectedPhotoCount > 1 && !isRaw { return }` 必须在 `guard error == nil` **之前**。
2. 拍摄 Promise 必须有兜底（原生 `didAcceptAnyPhoto` + JS 20s 超时），否则快门会永久卡死。
3. `App.tsx` 的 `previewPanResponder` 必须保留 `onPanResponderStart` 里的多指守卫——`onPanResponderGrant` 的同类守卫是**死代码**，第 2、3 指落下时它不会重跑。
4. 八台相机的风格只改 `assets/camera-profiles.json`。**改 JSON 后必须验证 `tone.curve` 恰好 5 个点**——原生 `toneCurve` 要求 5 点，否则静默丢弃整条曲线（当前 `validation.ts` 只校验 `>= 2`，保护不足）。
5. **仓库已公开，`.workbuddy/memory/*.md` 也在库里**——那些文件是被 git 跟踪的，写进去就等于发到网上。落笔前先自问「这句能让全网看吗」，**绝不写密钥、token、密码、真实个人信息**。
6. **CI 里的 `npm ci` 按 `package-lock.json` 锁定的源下载**，而当前 lock 的 `resolved` 指向 `registry.npmmirror.com`。海外 runner 上若拉包失败或极慢，**不要在本机重新生成 lock 文件**（两台机器的 npm 源不同，会来回翻动 lock，把 diff 搞成噪声）；先在 workflow 里排查或临时指定 registry。
7. **改 CI workflow 时，别把密钥写进 workflow 文件或日志**。`ASC_KEY_P8` 是含私钥的完整 `.p8`，只在 step 内通过 `env: ${{ secrets.XXX }}` 注入并写到磁盘临时路径，**不要 `echo` 出来**。公开仓库的 workflow 文件本身对所有人可见。

---

## 6. 交流约定

- 语言：**中文**。风格：简洁、结构化要点、不客套。
- 用户以**编号列表**提问题 → 逐条修复并验证后再出下一版。
- 改完要能说清「改了什么文件 + 为什么 + 验证结果 + 哪些还挂在待真机」。
