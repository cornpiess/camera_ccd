import Foundation
import Metal
import CoreImage
import AVFoundation

// MARK: - 相机模拟渲染引擎（单管线多数据，对齐像素蛋糕"统一引擎 + Look 包"架构）

/// 渲染顺序（对齐逆向还原的管线，去掉我们不需要的 RAW 设备归一层）：
/// Input → 增量 Exposure/WB(自适应) → 3D LUT → ToneCurve → HSL
///        → 肤色回退 → Grain → Vignette → Output
final class CameraLookEngine {

    private let context = CIContext(options: [.cacheIntermediates: false])
    private let lutCache = NSCache<NSString, MetalLUT>()
    private let curveCache = NSCache<NSString, CurveLUT1D>()

    // 每张图计算一次的动态量（对应像素蛋糕 Param CCT/Tint: init/abs/rel）
    struct FrameDynamics {
        var estimatedCCT: Float        // 由缩略图灰色点统计或 AVCaptureWhiteBalance 值
        var estimatedTint: Float
        var meanLuma: Float
    }

    func dynamics(for sampleBuffer: CMSampleBuffer,
                  whiteBalanceGains: AVCaptureWhiteBalanceGains?) -> FrameDynamics {
        // 优先用 AVFoundation 元数据（零成本），否则对 64×64 缩略图做灰色点统计
        // 实现略：grayWorld CCT 估计 + luma 直方图
        FrameDynamics(estimatedCCT: 5500, estimatedTint: 0, meanLuma: 0.45)
    }

    // MARK: 主入口
    func apply(_ recipe: CameraRecipe,
               dynamics: FrameDynamics,
               to input: CIImage,
               profileInput: LookProfile.Input = .backMain,
               intensity: Float = 1.0) -> CIImage {

        let profile = recipe.profiles.first { $0.input == profileInput }
        let patch = profile?.parameterPatch

        var image = input

        // 1. 增量 Exposure/WB —— 在 LUT 之前做（像素蛋糕同序）
        let adaptive = resolveAdaptive(recipe.adaptive, dynamics: dynamics, patch: patch)
        image = image
            .applyingFilter("CITemperatureAndTint", parameters: [
                "inputNeutral": CIVector(x: CGFloat(6500 + adaptive.temperatureK), y: CGFloat(adaptive.tint)),
            ])
            .applyingFilter("CIExposureAdjust", parameters: [
                kCIInputEVKey: adaptive.exposureEV,
            ])

        // 2. 3D LUT（Metal trilinear，64³；intensity 混合对齐其 GLSL）
        let lut = lut(for: recipe.exportLUT)
        image = lut.apply(image, intensity: intensity)

        // 3. ToneCurve → 4. HSL（同一自定义 kernel 链，或合并为单 pass 查表）
        image = image.applyingFilter("CIToneCurve", parameters: [
            "inputPoint0": curveVector(recipe.toneCurve.rgb, at: 0.25),
            "inputPoint1": curveVector(recipe.toneCurve.rgb, at: 0.50),
            "inputPoint2": curveVector(recipe.toneCurve.rgb, at: 0.75),
        ])
        image = applyHSL(image, recipe.hsl)

        // 5. 肤色回退：肤色 mask 区域按 20–30% 回退到 LUT 前（可用 CISkinTone? 自训更稳）
        // 6/7. Grain / Vignette —— 可选，仅特定机型
        if let g = recipe.grain { image = applyGrain(image, g) }
        if let v = recipe.vignette { image = applyVignette(image, v) }

        return image
    }

    // MARK: CCT/tint 分桶插值（对齐 allAILookZeroOffsetGlobalParams by cctKey/tintKey）
    private func resolveAdaptive(_ cfg: AdaptiveConfig,
                                 dynamics: FrameDynamics,
                                 patch: ParameterPatch?) -> (exposureEV: Float, temperatureK: Float, tint: Float) {
        var (ev, tk, tn) = (Float(0), Float(0), Float(0))
        if cfg.autoWB || cfg.autoExposure {
            let b = cfg.cctOffsets
            if let lo = b.last(where: { $0.cctKelvin <= dynamics.estimatedCCT }),
               let hi = b.first(where: { $0.cctKelvin >= dynamics.estimatedCCT }),
               lo.cctKelvin != hi.cctKelvin {
                let t = (dynamics.estimatedCCT - lo.cctKelvin) / (hi.cctKelvin - lo.cctKelvin)
                ev  += lo.exposureEV   + (hi.exposureEV   - lo.exposureEV)   * t
                tk  += lo.temperatureK + (hi.temperatureK - lo.temperatureK) * t
                tn  += lo.tint         + (hi.tint         - lo.tint)         * t
            }
        }
        // tint 桶同理叠加 tintOffsets，此处省略
        // 钳位 + Recipe 静态量 + 设备 Profile patch
        let clampE = min(max(ev, -cfg.maxExposureCorrection), cfg.maxExposureCorrection)
        let clampT = min(max(tk, -cfg.maxWBCorrectionK), cfg.maxWBCorrectionK)
        return (clampE + (patch?.exposure ?? 0),
                clampT + (patch?.temperature ?? 0),
                tn)
    }

    // MARK: 基础件（实现要点，非完整代码）
    private func lut(for cfg: LUTConfig) -> MetalLUT {
        if let hit = lutCache.object(forKey: cfg.resource as NSString) { return hit }
        let l = MetalLUT(resource: cfg.resource, size: cfg.size, is16Bit: cfg.is16Bit)
        lutCache.setObject(l, forKey: cfg.resource as NSString)
        return l
    }
    private func applyHSL(_ i: CIImage, _ c: HSLConfig) -> CIImage { i /* 自定义 kernel: RGB→HSL 查表→RGB */ }
    private func applyGrain(_ i: CIImage, _ g: GrainConfig) -> CIImage { i /* CIRandomGenerator + 亮度加权 mask */ }
    private func applyVignette(_ i: CIImage, _ v: VignetteConfig) -> CIImage {
        i.applyingFilter("CIVignette", parameters: ["inputIntensity": v.amount, "inputRadius": v.midpoint])
    }
    private func curveVector(_ pts: [SIMD2<Float>], at: Float) -> CIVector {
        // 线性插值取 at 处的 y
        CIVector(x: CGFloat(at), y: CGFloat(interpolate(pts, at)))
    }
    private func interpolate(_ pts: [SIMD2<Float>], _ x: Float) -> Float { 0.5 }
}

/// 3D LUT 的 Metal 实现：一次上载 64³ 数据纹理，trilinear 采样，output = mix(input, lut, intensity)
final class MetalLUT {
    init(resource: String, size: Int, is16Bit: Bool) {
        // 预览档 33³ 从 .cube 读；导出档 64³ 16-bit 从双 PNG（低8位+高8位）合成 —— 对齐像素蛋糕 lowbits/highbits
    }
    func apply(_ image: CIImage, intensity: Float) -> CIImage { image }
}

final class CurveLUT1D { init(points: [SIMD2<Float>]) {} }
