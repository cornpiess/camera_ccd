import Foundation
import CoreGraphics

// MARK: - 相机模拟 Recipe（数据驱动：新增相机 = 新增一份数据，零代码改动）

struct CameraRecipe: Codable, Identifiable {
    let id: String                    // "fuji-c200"、"leica-m9"
    let displayName: String
    let brandIconName: String?

    /// 预览用低精度 LUT（33³ ≈ 1KB），导出用高精度（64³/128³ 16-bit）
    let previewLUT: LUTConfig
    let exportLUT: LUTConfig

    /// 固定基础量（等价于 Look 包 jsonbuffer 里的静态参数）
    let exposure: Float               // EV
    let temperature: Float            // K 偏移
    let tint: Float                   // 绿-品红偏移
    let contrast: Float
    let highlights: Float
    let shadows: Float
    let blacks: Float

    let toneCurve: ToneCurve          // RGB + 可选 per-channel
    let hsl: HSLConfig                // 8 色相 × hue/sat/lum

    let grain: GrainConfig?           // 仅黑白/高ISO风格机型启用
    let vignette: VignetteConfig?

    /// 轻量自适应：对齐像素蛋糕 autoWB/autoExposure + cctKey/tintKey 分桶
    let adaptive: AdaptiveConfig

    /// 按拍摄输入分的 Profile（对齐它的 Non_Raw × camera model 思路）
    /// 例如 front/wide/back 各一份微调参数；缺省用 default
    var profiles: [LookProfile]      // 查找顺序：精确匹配 → default
}

struct LUTConfig: Codable {
    enum Storage: String, Codable { case cube3D, png2DPacked } // PNG 双通道16bit可选
    let resource: String              // 资产名
    let size: Int                     // 33 / 64 / 128
    let storage: Storage
    let is16Bit: Bool
}

struct ToneCurve: Codable {
    var rgb: [SIMD2<Float>]           // 控制点，运行时转 1D LUT
    var red: [SIMD2<Float>]?
    var green: [SIMD2<Float>]?
    var blue: [SIMD2<Float>]?
}

struct HSLConfig: Codable {
    // 8 色：red orange yellow green aqua blue purple magenta
    var hue: [Float]                  // -1...1，按色相索引
    var saturation: [Float]
    var luminance: [Float]
    static let neutral = HSLConfig(hue: .init(repeating: 0, count: 8),
                                   saturation: .init(repeating: 0, count: 8),
                                   luminance: .init(repeating: 0, count: 8))
}

struct GrainConfig: Codable {
    var intensity: Float
    var size: Float
    var colorVariation: Float         // 0 = 单色颗粒（黑白片）
    var shadowsBias: Float            // 暗部颗粒更重
}

struct VignetteConfig: Codable {
    var amount: Float
    var midpoint: Float
    var feather: Float
}

/// CCT 分桶的零点偏移表 —— 本分析最关键的可移植设计：
/// 每张图先估计色温/色调，再在桶间插值取增量曝光与 WB，保证"任何照片套上都对"。
struct AdaptiveConfig: Codable {
    var autoWB: Bool
    var autoExposure: Bool
    /// cctKey 分桶：按目标色温（如 3000/4300/5500/6500/8000K）给增量
    /// tintKey 分桶：按估计 tint（绿-品红）给增量
    var cctOffsets: [CCTBucket]
    var tintOffsets: [TintBucket]
    var maxExposureCorrection: Float  // 安全钳位
    var maxWBCorrectionK: Float

    struct CCTBucket: Codable { let cctKelvin: Float; let exposureEV: Float; let temperatureK: Float; let tint: Float }
    struct TintBucket: Codable { let tint: Float; let temperatureK: Float; let tintShift: Float }
}

struct LookProfile: Codable {
    enum Input: String, Codable { case `default`, frontCamera, backWide, backMain, telephoto }
    let input: Input
    let parameterPatch: ParameterPatch   // 对 Recipe 基础量的覆盖/微调
}

struct ParameterPatch: Codable {
    var exposure: Float?
    var temperature: Float?
    var contrast: Float?
    var hslOverride: HSLConfig?
}
