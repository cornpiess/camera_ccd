四个 P0 根因修复（build 31）

## 1. 相机选择列表可滚动（确定性 bug 修复）
文件：src/components/CameraSelector.tsx
- panelHeight 改为 min(profiles.length × ROW_HEIGHT, 屏幕高度 × 0.62)，morph 动画公式同步使用 cap 后高度
- 行列表包进 ScrollView，选中相机自动滚到可见位置

## 2. 光圈环拖不动（源码级根因修复）
文件：src/components/ApertureBar.tsx
- PanResponder 稳定化：openness/currentAperture/onApertureChange/interactive 改经 ref 读取，拖动全程不再重建手势器（重建会清零 gestureState.dx，数值回弹到起点——"拖不动"的确切机制）
- 拖拽热区从 252pt 刻度带扩为整条 bar
- DEMO 徽标改为 accent 色描边小徽章（可辨识）

## 3. 缩略图 → App 内全屏看大图
文件：App.tsx
- 点缩略图全屏显示最近照片（优先全分辨率 fileUri、存在性检查失败回退持久缩略图），点击任意处关闭
- 移除 photos-redirect/photos scheme 死路

## 4. 照片入库失败可取证
文件：modules/camera-engine/ios/CameraEngineModule.swift
- performChanges 目前丢弃 PhotoKit 的 NSError → 改为把 error.localizedDescription 带入 reject message（detail 贯穿 settle）
- 权限拒绝分支同样带上权限状态细节；诊断日志将记录每次保存失败的准确原因
- 不改保存逻辑本身

## 验证与交付
- npm run verify 全绿 + Swift 配平自查
- 你出 build 31 后真机验收四项；若照片仍不入库，诊断面板/日志会有确切原因，发我定案
- 分级：Swift 待 CI 构建验证；交互待真机