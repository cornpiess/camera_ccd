# 测试标准（打包门槛）

> 本文件定义 Camera 18 出包前的强制测试集。**任何一次 TestFlight / Dev Build 打包之前必须全部通过**；
> 未通过时禁止打包，即使改动看起来「只是文案」。新增功能时必须同步在「真机验收清单」中补条目。

## 1. 静态门槛（自动，本机执行）

```bash
npm run prepackage-check
```

一条命令覆盖，任何一项失败即禁止打包：

| # | 检查项 | 防的事故 |
|---|---|---|
| 1 | `npm run verify`（typecheck + lint + doctor 20/20） | 基础回归 |
| 2 | `expo export --platform ios` 成功，模块数 ≥ 619 | bundle 缺失 / 文件误删（黑屏） |
| 3 | Swift 括号/字符串配平自查 | 本机无 Xcode，编译错误只能在 CI 暴露，先拦截结构性错误 |
| 4 | `expo-modules-autolinking resolve` 包含 `CameraEngineModule` | 原生模块未注册 → 启动即黑屏（run 12 事故） |
| 5 | camera-profiles.json：8 个 Profile、id 唯一、tone.curve 恰好 5 点、color.lut 均有对应 .cube 文件 | Profile 渲染静默失效 |
| 6 | podspec `resource_bundles` + `expo-module.config.json` 的 modules/podspecPath 声明 | LUT 打不进包 / 模块注册缺失 |
| 7 | 密钥红线扫描（private key / AWS AKIA / GitHub token 模式） | 公开仓库泄密（AGENTS 红线） |

## 2. CI 门槛

1. workflow 必须整条绿；Archive / Export 任何一步红，**先修再出包**，不允许「带红出包后让用户试」。
2. 失败时用仓库凭据拉 `actions/runs/<id>/logs` 定位；三次修复仍红的，停下来向用户汇报。
3. Apple 账号证书额度有限（见 AGENTS.md 1.1）：Archive 报证书数量超限时，属于账号侧操作，**不要反复重跑烧额度**，先让用户吊销旧证书。

## 3. 真机验收清单（打包人手测，P0 全过才算数）

**启动与权限**
1. 首次安装冷启动 → 显示权限说明页（不是报错页）→ 点 Continue（中性词，App Store 审核要求，不得出现 Enable/引导授权类文案）→ **弹出系统授权弹窗**（run 14 回归点：说明页底下必须挂着原生取景视图）。
2. 授权后取景器出现实时画面（带相机 DNA 滤镜）。
3. 在系统设置里关闭相机权限 → 冷启动 → 显示「Open Settings」说明页 → 跳转设置正常。

**取景器（WYSIWYG）**
4. 取景器为 4:3 信箱构图（上下黑边），与成片构图一致。
5. 切换 8 台相机模式，预览色彩**立刻可见变化**；顶部名称同步变化。
6. 预览不卡顿、不花屏、不黑屏；切后台再回来自动恢复。

**镜头**
7. 有多镜头的机型显示 0.5× / 1× 档位并切换生效；单镜头机型不显示档位条。

**拍摄**
8. 快门有反馈（闪白 + 震动），照片保存进相册，缩略图更新。
9. 横持手机拍摄 → 相册里的照片是横向的。
10. 连拍不崩（拍 3 张以上，间隔 ~1s）。

**记忆与诊断**
11. 重启 App → 自动恢复上次的相机模式。
12. 三指长按 2s 呼出校准面板 → Diagnostic Log 可加载、可复制。

**错误兜底**
13. 任何错误页面文字可读（截图可诊断），**不允许全黑屏**。

## 4. 回归预案（历史上真实发生，必须知道）

- **全黑屏不闪退** → 错误边界 + 诊断日志兜底已内置；让用户截图错误页即可定位。
- **「Cannot find native module」** → 检查 expo-module.config.json / podspecPath / autolinking（静态门槛 #4、#6）。
- **Archive 签名失败** → 证书额度，账号侧吊销（AGENTS 1.1）。
- **Swift 编译错误** → 本机无 swiftc，静态门槛只能拦截结构问题；Swift 改动必须在汇报中标注「待 CI 构建验证」，CI 红了先修。
