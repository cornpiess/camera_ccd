# Camera Profile Library Changelog

## 1.0.0

- 建立 `camera-look-engine/v1` 稳定契约。
- 新增富士 NC、徕卡 M9、理光正片、佳能 G7X2 四个独立设计的初版 Profile。
- Preview 使用 17³ LUT，Final 使用 33³ LUT；两者由同一 authoring model 生成。
- 增加结构校验、LUT 校验和完整性清单。

> 版本策略：Profile 的任何视觉变化都必须提升该 Profile 的 `version`；改变字段或语义时提升 `schemaVersion` 和 engine contract。
