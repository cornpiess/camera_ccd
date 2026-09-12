# 像素蛋糕「相机模拟」实现资源分析目录

本目录归档对 `com.xiangtian.pixcake.apk`（828MB）中**相机模拟系统**的逆向分析资源。
只包含与相机模拟相关的文件；美颜/磨皮/妆容/背景等功能均已排除。
未导出/解密任何商业 LUT 数据；native 证据均为字符串级摘录。

## 目录架构

```
相机模拟分析/
├── README.md                          ← 本文件：目录架构 + 快速导读
│
├── 01_分析报告/
│   └── 相机模拟实现分析报告.md          ← 完整报告（结论/Q1-Q12/iPhone方案）
│
├── 02_配置资源/                        ← APK 内真实存在的相机模拟配置（可直接阅读）
│   ├── CameraRecipe.json              ← 相机配方面板 UI 配置（140501-140505）
│   ├── CameraRecipe_effect_configs/   ← 每个配方的 effect.json（核心 schema！）
│   │   └── 140501/effect.json         ← color/portrait/lightning/lensBlur/... 组合结构
│   ├── 示例图标_140501.png
│   └── 示例品牌图标_140501.png
│
├── 03_反编译代码/                      ← jadx 反编译的关键类（classes5/6.dex）
│   ├── CameraRecipe*.java             ← 配方数据类 + 面板 ViewModel/Fragment
│   ├── CameraXServiceProvider.java    ← 相机色彩素材查询/下载服务（跨模块路由）
│   ├── CameraRecipeColorLegacyResolver.java
│   │                                   ← 内置 ID 140351-140360 → CameraLook/CS000xx 映射表
│   ├── CameraLookModel.java           ← 效果值 = {id: String, amount: Float}（仅两字段！）
│   ├── CameraLookConfig.java          ← 云端 Look 元数据 {description,sort,hotSort,packageId}
│   ├── AILookInfoRes.java             ← 服务器 Look 列表条目（name/icon/type/url...）
│   ├── AILookListRes.java             ← 服务器 Look 分组列表
│   ├── AILookMetaRes.java             ← CDN urlPrefix
│   ├── CameraLookPreloader_cls6.java  ← 编辑页 Look 素材预下载器
│   ├── CameraLookNameResolver_cls5.java ← CS编码 → 显示名（富士C200等）解析器
│   ├── CubeLutRenderer_混淆名j9k.java  ← 相机页 .cube 3D LUT 渲染器（64³/512×512）
│   ├── PngLutRenderer_混淆名j9q.java   ← 相机页 PNG 打包 LUT 渲染器
│   └── LutReferenceDetector_混淆名d0.java ← LUT 引用检测
│
├── 04_引擎证据/                        ← native 引擎（libPixCookNative.so）字符串证据
│   ├── LUT_fragment_shader_从dex提取.txt ← 相机预览 GLSL：64³ 2D打包 LUT + intensity 混合
│   ├── native_CameraLook包结构字符串.txt  ← Look 下载包内部文件结构（aitoning/* 等 251 条）
│   ├── native_动态适配证据.txt           ← 逐图 CCT/tint 校准 + 分桶偏移表（45 条）
│   ├── native_色彩参数符号.txt           ← ToneCurve/HSL/ColorGrading/SplitToning（313 条）
│   └── native_设备3DLUT清单节选.txt      ← 按手机/相机型号的 3DLUT-Strand 适配清单（873 条）
│
├── 05_API与数据结构/
│   ├── dex内_API与AILook字符串全集.txt   ← v1/api/look/* 等 301 条接口/字段证据
│   └── 数据结构说明.md                  ← 服务端接口、素材包结构、Room 表结构说明
│
└── 06_我们的Swift实现/
    ├── CameraRecipe.swift             ← 8 台英雄相机的数据模型设计
    ├── CameraLookEngine.swift         ← Metal 渲染管线 + 轻量自适应引擎骨架
    └── 实现要点.md                     ← 从本分析推导的实现决策与优先级
```

## 60 秒导读

1. **看 `02_配置资源/CameraRecipe_effect_configs/140501/effect.json`** —— 相机模拟在客户端只是
   一组子效果 ID 的组合，其中 `color.id` 指向真正的"相机色彩"。
2. **看 `03_反编译代码/CameraRecipeColorLegacyResolver.java`** —— `color.id` 映射到
   `CameraLook/CS000xx` 编码；你看到的 24 个相机名（富士C200/柯达5219/徕卡M9…）不在 APK 内，
   由 `v1/api/look/*` 下发（见 `05_API与数据结构`）。
3. **看 `04_引擎证据/native_CameraLook包结构字符串.txt`** —— 每个 Look 是一个下载包：
   `config.json + aitoning/{jsonbuffer.json, lowbits.png, highbits.png, rawbits.bin, profile}`
   + palette512 + preview_cubes，按 RAW/非RAW × 拍摄设备分 Profile。
4. **看 `04_引擎证据/native_动态适配证据.txt`** —— 同一 Look 在不同照片上参数会变：
   本地估计 CCT/tint 后按分桶偏移表取增量曝光/白平衡（规则算法，非 AI、非服务器）。
5. **结论**：类型 C/D 架构 —— 一个统一 PixCook 渲染引擎 + 大量可下载 Look 数据包。
   我们的 iPhone 实现（`06_我们的Swift实现`）采用同构但简化方案：
   1 LUT/相机 + Recipe 参数 + CCT 分桶自适应，无需 AI 与多 LUT。
