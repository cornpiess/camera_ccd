import ExpoModulesCore
import AVFoundation
import Photos
import CoreImage
import CoreFoundation
import ImageIO
import CoreMotion
import AudioToolbox
import UIKit
import MetalKit
import ObjectiveC

// MARK: - Shared GPU context (red line: exactly ONE CIContext for the whole engine)
/// One Metal device + one CIContext shared by the WYSIWYG preview and the capture pipeline.
/// Never allocate a CIContext per frame or per shutter press — GPU memory leaks → Jetsam.
enum CameraEngineGPU {
  static let metalDevice: MTLDevice? = MTLCreateSystemDefaultDevice()
  static let ciContext: CIContext = {
    if let device = metalDevice {
      return CIContext(mtlDevice: device, options: [.cacheIntermediates: false])
    }
    // Simulator / exotic fallback: software-backed context.
    return CIContext(options: [.cacheIntermediates: false])
  }()
  static let sRGBColorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
}

// 模块内可见即可。放在 fileprivate 会连带要求所有签名里用到它的方法也降为
// fileprivate（Swift 要求方法可见度不高于签名中类型的可见度），没有收益。
enum CameraEngineError: String, Error {
  case noActiveView = "ERR_NO_ACTIVE_VIEW"
  case permissionDenied = "ERR_PERMISSION_DENIED"
  case photoPermissionDenied = "ERR_PHOTO_PERMISSION_DENIED"
  case cameraUnavailable = "ERR_CAMERA_UNAVAILABLE"
  case configurationFailed = "ERR_CONFIGURATION_FAILED"
  case notRunning = "ERR_NOT_RUNNING"
  case captureFailed = "ERR_CAPTURE_FAILED"
  case captureBusy = "ERR_CAPTURE_BUSY"
  case processingFailed = "ERR_PROCESSING_FAILED"
  case saveFailed = "ERR_SAVE_FAILED"
  case apertureUnsupported = "ERR_APERTURE_UNSUPPORTED"
}

private extension CameraEngineError {
  var message: String {
    switch self {
    case .noActiveView: return "Mount CameraEngineView before calling this method."
    case .permissionDenied: return "Camera permission was denied."
    case .photoPermissionDenied: return "Photo-library add permission was denied."
    case .cameraUnavailable: return "A rear wide-angle camera is unavailable."
    case .configurationFailed: return "The capture session could not be configured."
    case .notRunning: return "The camera is not running."
    case .captureFailed: return "The camera did not produce photo data."
    case .captureBusy: return "Still processing the previous photo — try again in a moment."
    case .processingFailed: return "The image profile could not be rendered."
    case .saveFailed: return "The photo could not be saved to the photo library."
    case .apertureUnsupported: return "Variable aperture is not available through a supported public API on this device."
    }
  }
}

// MARK: - Unified Aperture System (capability-driven, never model-name-driven)
///   variable — the CURRENT lens + activeFormat + system API expose a real variable iris
///   fixed    — the CURRENT lens has a single mechanical aperture; the UI shows it and
///              does not drag; Camera 18 simulates NOTHING (no blur/starburst/exposure)
enum ApertureMode {
  case variable
  case fixed
}

// MARK: - Aperture Controller Abstraction
/// Manages variable aperture runtime discovery and hardware control.
/// Since iOS 27 / iPhone 18 Pro, Apple exposes the physical variable aperture to third
/// parties: `AVCaptureDevice.setExposureModeCustom(lensAperture:duration:iso:)` gives us
/// true aperture-priority (hardware aperture under our control, shutter/ISO stay auto),
/// with the real range in `activeFormat.minLensAperture / maxLensAperture` and the
/// hardware detents in `activeFormat.recommendedLensApertureStops`.
/// Devices WITHOUT a variable aperture report their single real mechanical aperture;
/// the UI shows it fixed and is not draggable. Camera 18 simulates no optics.
final class ApertureController {
  /// Resolved from CAPABILITY (device + activeFormat + API presence), refreshed on every
  /// getCapabilities/setAperture. Defaults to .fixed — the honest default.
  var mode: ApertureMode = .fixed
#if DEBUG || CAMERA18_TESTING
  /// TestFlight Beta / local-dev ONLY: force the aperture mode so the variable/fixed UI
  /// can be tested on any device (e.g. iPhone 14 Plus). When set, capabilityMode returns
  /// it VERBATIM — no real aperture API is called, no exposure is touched, photos are
  /// completely unaffected. Production builds compile this property out entirely.
  var mockOverride: ApertureMode?
#endif

  /// Capability detection — RUNTIME-DISCOVERED API surface (see discoveredApi() below for
  /// why nothing is hardcoded). Variable iff the CURRENT device + activeFormat satisfy ALL of
  /// - non-degenerate variable-aperture range on the active format (min < max),
  /// - the exposure setter exists on this device (discovered selector),
  /// - the live auto sentinels are obtainable (AE must compensate aperture changes),
  /// - when a format-level probe API exists: the probed ACCEPTED aperture subrange spans
  ///   ≥ 0.3 f-number. When NO probe API exists on this OS, the span gate is skipped and
  ///   the nominal range is trusted — the settle path clamps to the end stops and any
  ///   hardware rejection still surfaces honestly (ERR_APERTURE_UNSUPPORTED + JS demotion).
  /// recommendedLensApertureStops is NOT a gate anymore: a format that publishes a range
  /// but no detents is still variable (the JS layer derives a ladder from min/max).
  /// No device names anywhere — a future variable-aperture iPhone needs zero code changes.

  /// Gate-by-gate result of the last capability evaluation, surfaced through
  /// getCapabilities("apertureDiag") so the in-app diag log shows exactly WHY a real
  /// device resolved fixed (the previous session had no iPhone 18 Pro to test against).
  struct CapabilityDiag {
    var autoSentinelsOk = false
    var rangeOk = false
    var setterOk = false
    var probeOk = false
    var probeApiExists = false
    var probeSpan: Double = 0
    var stopsCount = 0
    var minAperture: Double = 0
    var maxAperture: Double = 0
    var variable = false
    var matchedSelectors: [String] = []
    var setterName: String?
    var probeName: String?
    /// Every format's iris range on this device ("min-max WxH"), deduped — diagnoses an
    /// activeFormat that publishes a PARTIAL iris range (e.g. 2.8–4.0) while another
    /// format carries the full one (e.g. 1.48–4.0).
    var formats: [String] = []

    var asDictionary: [String: Any] {
      [
        "autoSentinels": autoSentinelsOk,
        "range": rangeOk,
        "setter": setterOk,
        "probe": probeOk,
        "probeApiExists": probeApiExists,
        "probeSpan": probeSpan,
        "stopsCount": stopsCount,
        "minAperture": minAperture,
        "maxAperture": maxAperture,
        "variable": variable,
        "matchedSelectors": matchedSelectors,
        "setterName": setterName ?? NSNull(),
        "probeName": probeName ?? NSNull(),
        "formats": formats,
      ]
    }
  }

  private let diagLock = NSLock()
  private var lastDiagStorage = CapabilityDiag()

  func lastCapabilityDiag() -> CapabilityDiag {
    diagLock.lock(); defer { diagLock.unlock() }
    return lastDiagStorage
  }

  func evaluateCapability(for device: AVCaptureDevice?) -> CapabilityDiag {
    let api = discoveredApi()
    var d = CapabilityDiag()
    d.matchedSelectors = api.matchedSelectors
    d.setterName = api.setterName
    d.probeName = api.probeName

    // Gate 1: AE-compensation sentinels (without them an aperture change darkens the
    // frame). Class getters OR exported constants (dlsym) — either source counts.
    d.autoSentinelsOk = autoSentinels() != nil

    // Gate 2: non-degenerate variable range on the CURRENT activeFormat.
    if let device, let range = variableApertureRange(device) {
      d.rangeOk = true
      d.minAperture = range.min
      d.maxAperture = range.max
      d.stopsCount = range.stops?.count ?? 0
    }

    // Format inventory (fixed-index loop, 坑 #10): every format's iris range + top photo
    // dimension, deduped — reveals whether the activeFormat carries a PARTIAL range.
    if let device {
      var seen = Set<String>()
      let allFormats = device.formats
      for i in 0..<allFormats.count {
        let f = allFormats[i] as NSObject
        guard let mn = formatFloat(f, "minLensAperture"),
              let mx = formatFloat(f, "maxLensAperture") else { continue }
        var dims = ""
        if #available(iOS 16.0, *), let d0 = allFormats[i].supportedMaxPhotoDimensions.first {
          dims = " \(d0.width)x\(d0.height)"
        }
        seen.insert(String(format: "%.2f-%.2f%@", mn, mx, dims))
      }
      d.formats = seen.sorted()
    }

    // Gate 3: the setter exists on THIS device.
    if let sel = api.setterSelector {
      d.setterOk = device?.responds(to: sel) == true
    }

    var variable = d.autoSentinelsOk && d.rangeOk && d.setterOk
    if variable {
      if api.probeSelector != nil {
        d.probeApiExists = true
        if let device, let accepted = acceptedApertureRange(device) {
          d.probeSpan = accepted.max - accepted.min
          d.probeOk = d.probeSpan >= 0.3
          variable = d.probeOk
        } else {
          variable = false
        }
      }
      // else: no probe API on this OS → span gate skipped (see doc comment above).
    }
    d.variable = variable
    diagLock.lock(); lastDiagStorage = d; diagLock.unlock()
    return d
  }

  func capabilityMode(for device: AVCaptureDevice?) -> ApertureMode {
    #if DEBUG || CAMERA18_TESTING
    if let mock = mockOverride { return mock }
    #endif
    return evaluateCapability(for: device).variable ? .variable : .fixed
  }

  // MARK: Runtime API-surface discovery
  //
  // The aperture selectors were authored from memory without any iPhone 18 Pro in the
  // loop (AGENTS 1.5-A trap). TestFlight build 88 — the FIRST run on real hardware —
  // resolved Fixed, meaning at least one responds(to:) gate failed on-device. From now
  // on NOTHING is trusted: the REAL selector surface of AVCaptureDevice /
  // AVCaptureDevice.Format is enumerated once at runtime; the setter / probe /
  // sentinels are resolved from that surface (the spelling candidates below are only
  // first guesses, each answers before use). The result is mirrored into matchedSelectors
  // in the diag payload so the actual on-device API names are readable from the app.
  private struct ApertureApi {
    var setterName: String?
    var setterSelector: Selector?
    var setterArity = 0
    var probeName: String?
    var probeSelector: Selector?
    var probeArity = 0
    var autoDurationSelector: Selector?
    var autoIsoSelector: Selector?
    var apertureCurrentSelector: Selector?
    var matchedSelectors: [String] = []
  }

  private static let apiLock = NSLock()
  private static var cachedApi: ApertureApi?

  private func discoveredApi() -> ApertureApi {
    ApertureController.apiLock.lock()
    if let cached = ApertureController.cachedApi {
      ApertureController.apiLock.unlock()
      return cached
    }
    ApertureController.apiLock.unlock()

    // Enumerate every instance + class method of the two classes that own the iOS 27
    // aperture surface. Fixed-index loop; the buffer MUST be freed (坑 #10 discipline).
    var names = Set<String>()
    func scan(_ cls: AnyClass, classMethods: Bool) {
      guard let target = classMethods ? object_getClass(cls) : cls else { return }
      var count: UInt32 = 0
      if let list = class_copyMethodList(target, &count) {
        for i in 0..<Int(count) {
          let c = sel_getName(method_getName(list[i]))
          names.insert(String(cString: c))
        }
        free(list)
      }
    }
    scan(AVCaptureDevice.self, classMethods: false)
    scan(AVCaptureDevice.self, classMethods: true)
    scan(AVCaptureDevice.Format.self, classMethods: false)

    let keywords = ["aperture", "Aperture", "ExposureModeCustom", "autoISO", "AutoISO", "autoExposure", "AutoExposure"]
    let hits = names.filter { s in keywords.contains { s.contains($0) } }.sorted()

    func arity(_ name: String) -> Int { name.filter { $0 == ":" }.count }

    // Setter: device-level method that sets custom exposure WITH a lens aperture.
    // Candidates first (historical spellings), then anything the surface actually has.
    let setterCandidates = [
      "setExposureModeCustomWithLensAperture:duration:ISO:completionHandler:",
      "setExposureModeCustomWithLensAperture:duration:ISO:",
      "setExposureModeCustomWithLensAperture:duration:iso:completionHandler:",
      "setExposureModeCustomWithLensAperture:duration:iso:",
      "setExposureModeCustomWithISO:lensAperture:duration:",
    ]
    let deviceClass: AnyObject = AVCaptureDevice.self
    // INSTANCE-method probing (build 90 diag lesson): the candidates are instance
    // methods, but AVCaptureDevice.self.responds(to:) only answers CLASS methods —
    // every candidate missed and the alphabetical fallback picked
    // setExposureModeCustomWithDuration:ISO: (NO aperture argument!). Probe the
    // instance method table instead.
    var setterName: String? = setterCandidates.first { class_getInstanceMethod(AVCaptureDevice.self, NSSelectorFromString($0)) != nil }
    if setterName == nil {
      // Only signatures we know how to call (3 or 4 args) — anything else would miscast.
      setterName = hits.first { $0.hasPrefix("set") && $0.contains("ExposureModeCustom") && (arity($0) == 3 || arity($0) == 4) }
    }

    // Probe: format-level "supports…" query with an aperture argument (may not exist at all).
    let probeCandidates = [
      "supportsExposureModeCustomWithLensAperture:duration:ISO:",
      "supportsExposureModeCustomWithLensAperture:duration:iso:",
    ]
    let formatClass: AnyObject = AVCaptureDevice.Format.self
    // Instance-method probe (same build-90 lesson as the setter above).
    var probeName: String? = probeCandidates.first { class_getInstanceMethod(AVCaptureDevice.Format.self, NSSelectorFromString($0)) != nil }
    if probeName == nil {
      // Only signatures we know how to call (1 or 3 args) — anything else would miscast.
      probeName = hits.first { $0.hasPrefix("supports") && $0.contains("ExposureModeCustom") && (arity($0) == 1 || arity($0) == 3) }
    }

    // Auto sentinels: class-level getters.
    let durationCandidates = ["autoExposureDuration", "autoExposureDurationCurrent", "defaultAutoExposureDuration"]
    let isoCandidates = ["autoISO", "autoISOCurrent", "defaultAutoISO"]
    let durationName = durationCandidates.first { deviceClass.responds(to: NSSelectorFromString($0)) }
      ?? hits.first { $0.hasPrefix("autoExposureDuration") || $0.hasPrefix("AutoExposureDuration") }
    let isoName = isoCandidates.first { deviceClass.responds(to: NSSelectorFromString($0)) }
      ?? hits.first { $0.hasPrefix("autoISO") || $0.hasPrefix("AutoISO") }
    // "Current" aperture sentinel (for the documented generic priority-support query).
    let apertureCurrentCandidates = ["currentLensAperture", "lensApertureCurrent"]
    let apertureCurrentName = apertureCurrentCandidates.first { deviceClass.responds(to: NSSelectorFromString($0)) }

    let api = ApertureApi(
      setterName: setterName,
      setterSelector: setterName.map { NSSelectorFromString($0) },
      setterArity: setterName.map(arity) ?? 0,
      probeName: probeName,
      probeSelector: probeName.map { NSSelectorFromString($0) },
      probeArity: probeName.map(arity) ?? 0,
      autoDurationSelector: durationName.map { NSSelectorFromString($0) },
      autoIsoSelector: isoName.map { NSSelectorFromString($0) },
      apertureCurrentSelector: apertureCurrentName.map { NSSelectorFromString($0) },
      matchedSelectors: hits
    )
    ApertureController.apiLock.lock()
    ApertureController.cachedApi = api
    ApertureController.apiLock.unlock()
    let summary = "setter=\(setterName ?? "none") probe=\(probeName ?? "none") autoDur=\(durationName ?? "none") autoISO=\(isoName ?? "none") matched[\(hits.count)]=\(hits.joined(separator: ", "))"
    NSLog("[CameraEngine][ApertureDiag] api discovered: %@", summary as NSString)
    return api
  }

  /// Documented generic aperture-priority query (Apple docs, iOS 27): the intended use
  /// of supportsExposureModeCustom(lensAperture:duration:iso:) is to ask which AUTO
  /// COMBINATIONS are supported — pass the Current aperture sentinel plus the Auto
  /// duration/ISO sentinels for ONE generic "is aperture-priority supported by this
  /// format" answer. Numeric arguments are only range-checked, and NOT all priority
  /// combinations are supported: the previous per-stop numeric grid misread "combination
  /// unsupported" as "every stop unsupported" (build 89: probe span 0 on iPhone 18 Pro).
  /// If the Current-sentinel getter can't be discovered, an in-range numeric aperture is
  /// the fallback (range-check passes; combination answer is what matters).
  private func supportsAperturePriority(_ format: NSObject, nominalMin: Double) -> Bool {
    if #available(iOS 27.0, *) {
      guard let auto = autoSentinels() else { return false }
      let api = discoveredApi()
      guard let sel = api.probeSelector, format.responds(to: sel),
            let method = format.method(for: sel) else { return false }
      var apertureArg = Float(nominalMin)
      if let curSel = api.apertureCurrentSelector,
         AVCaptureDevice.self.responds(to: curSel),
         let imp = class_getMethodImplementation(object_getClass(AVCaptureDevice.self), curSel) as IMP? {
        typealias Getter = @convention(c) (AnyObject, Selector) -> Float
        let v = unsafeBitCast(imp, to: Getter.self)(AVCaptureDevice.self as AnyObject, curSel)
        if v.isFinite && v > 0 { apertureArg = v }
      } else if let v = Self.globalFloat("AVCaptureLensApertureCurrent"), v.isFinite, v > 0 {
        // Exported-constant form (same build-90 lesson as the auto sentinels).
        apertureArg = v
      }
      if api.probeArity == 3 {
        typealias Check = @convention(c) (AnyObject, Selector, Float, CMTime, Float) -> ObjCBool
        let fn = unsafeBitCast(method, to: Check.self)
        return fn(format, sel, apertureArg, auto.duration, auto.iso).boolValue
      }
      guard api.probeArity == 1 else { return false }
      typealias Check1 = @convention(c) (AnyObject, Selector, Float) -> ObjCBool
      let fn = unsafeBitCast(method, to: Check1.self)
      return fn(format, sel, apertureArg).boolValue
    }
    // Pre-iOS 27 systems never publish variable-aperture formats in practice.
    return false
  }

  /// Coalesced application for HIGH-FREQUENCY sources (Camera Control slider): at most
  /// one lockForConfiguration per 0.12s window, trailing value wins. Screen-ring settles
  /// (single events) call setAperture directly.
  private var pendingPhysical: DispatchWorkItem?

  func requestCoalescedPhysicalAperture(_ fStop: Float, on device: AVCaptureDevice?, completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    pendingPhysical?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      mode = .variable
      setPhysicalAperture(Double(fStop), on: device, completion: completion)
    }
    pendingPhysical = work
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.12, execute: work)
  }


  struct Capabilities {
    let supportsVariableAperture: Bool
    let minAperture: Double?
    let maxAperture: Double?
    let activeAperture: Double
    let supportedApertures: [Double]?
    let deviceModel: String

    var asDictionary: [String: Any] {
      var dict: [String: Any] = [
        "supportsVariableAperture": supportsVariableAperture,
        "minAperture": minAperture ?? NSNull(),
        "maxAperture": maxAperture ?? NSNull(),
        "activeAperture": activeAperture,
        "deviceModel": deviceModel,
        // Compatibility aliases
        "activeLensAperture": activeAperture,
        "model": deviceModel
      ]
      if let supportedApertures = supportedApertures {
        dict["supportedApertures"] = supportedApertures
      } else {
        dict["supportedApertures"] = NSNull()
      }
      return dict
    }
  }

  init() {}

  // iOS 27 aperture symbols (minLensAperture / maxLensAperture / recommendedLensApertureStops /
  // currentLensAperture / setExposureModeCustomWithLensAperture:…) are invoked DYNAMICALLY
  // (KVC + ObjC selector) so this file compiles with any Xcode SDK — the feature is gated at
  // runtime by #available(iOS 27.0, *) and responds(to:). All of these are PUBLIC Apple APIs;
  // dynamic dispatch here is purely SDK-version tolerance, never private-API access.
  // autoExposureDuration / autoISO are iOS 27 class properties (the "keep automatic"
  // sentinels) and are fetched through dynamic class-method calls — see setAperture.

  private func formatFloat(_ format: NSObject, _ key: String) -> Double? {
    let sel = NSSelectorFromString(key)
    guard format.responds(to: sel) else { return nil }
    return (format.value(forKey: key) as? NSNumber)?.doubleValue
  }

  private func recommendedStops(_ format: NSObject) -> [Double]? {
    let sel = NSSelectorFromString("recommendedLensApertureStops")
    guard format.responds(to: sel) else { return nil }
    return ((format.value(forKey: "recommendedLensApertureStops") as? [NSNumber]) ?? [])
      .map { $0.doubleValue }
      .sorted()
  }

  /// Non-degenerate variable-aperture range of the active format, nil on fixed lenses
  /// or pre-iOS 27 (honest fixed-aperture path).
  private func variableApertureRange(_ device: AVCaptureDevice) -> (min: Double, max: Double, stops: [Double]?)? {
    if #available(iOS 27.0, *) {
      let format = device.activeFormat as NSObject
      guard let minA = formatFloat(format, "minLensAperture"),
            let maxA = formatFloat(format, "maxLensAperture"),
            minA > 0, maxA > minA else { return nil }
      return (minA, maxA, recommendedStops(format))
    }
    return nil
  }

  // CAPABILITY PROBE: per Apple's iOS 27 docs the numeric arguments of
  // supportsExposureModeCustom(lensAperture:duration:iso:) are only range-checked and
  // "not all priority mode combinations may be supported" — the previous per-stop
  // numeric grid misread "combination unsupported" as "every stop unsupported"
  // (build 89: probe span 0 on real iPhone 18 Pro → wrongly demoted to fixed).

  /// Whether the CURRENT format accepts aperture-priority (aperture locked, shutter and
  /// ISO auto) at all — the documented generic query, format-level only, never touches
  /// hardware state. The nominal iris range [min, max] is then the accepted range; the
  /// settle path clamps to the end stops and any hardware rejection still surfaces
  /// honestly (ERR_APERTURE_UNSUPPORTED + JS demotion).
  private func acceptedApertureRange(_ device: AVCaptureDevice) -> (min: Double, max: Double)? {
    guard let nominal = variableApertureRange(device) else { return nil }
    // No probe API exists on this OS (runtime discovery found none): the nominal iris
    // range IS the accepted range.
    guard discoveredApi().probeSelector != nil else { return (nominal.min, nominal.max) }
    return supportsAperturePriority(device.activeFormat as NSObject, nominalMin: nominal.min)
      ? (nominal.min, nominal.max) : nil
  }

  /// The lens's real mechanical aperture (the only aperture a fixed lens has).
  func currentAperture(_ device: AVCaptureDevice) -> Double {
    if #available(iOS 27.0, *) {
      if device.responds(to: NSSelectorFromString("currentLensAperture")),
         let v = device.value(forKey: "currentLensAperture") as? NSNumber {
        return v.doubleValue
      }
    }
    return Double(device.lensAperture)
  }

  /// Inspect runtime device capabilities. On iOS 27+ the per-format lens aperture range
  /// is authoritative; a degenerate range (min >= max) means this lens has no variable
  /// aperture, so the fixed-aperture honesty path applies per lens.
  func getCapabilities(device: AVCaptureDevice?) -> Capabilities {
    guard let device = device else {
      return Capabilities(
        supportsVariableAperture: false,
        minAperture: nil,
        maxAperture: nil,
        activeAperture: 1.8,
        supportedApertures: nil,
        deviceModel: "Unknown Device"
      )
    }

    let active = currentAperture(device)
    if let accepted = acceptedApertureRange(device) {
      // REPORT THE ACCEPTED RANGE, not the nominal one: min/max is the usable
      // aperture-priority range — the UI scale ends and the settle clamp both key off
      // these fields, so an unreachable nominal max would offer stops the hardware
      // refuses (the ƒ/3.8 bounce-back). Stops outside the accepted subrange are
      // filtered so Camera Control prominent values stay reachable too.
      let stops = variableApertureRange(device)?.stops?
        .filter { $0 >= accepted.min - 1e-9 && $0 <= accepted.max + 1e-9 }
      return Capabilities(
        supportsVariableAperture: true,
        minAperture: accepted.min,
        maxAperture: accepted.max,
        activeAperture: active,
        // Hardware detents inside the accepted range when the format publishes them;
        // otherwise the JS layer derives a 1/3-stop ladder from min/max (deriveVariableApertures).
        supportedApertures: (stops?.isEmpty == false) ? stops : nil,
        deviceModel: device.localizedName
      )
    }
    return Capabilities(
      supportsVariableAperture: false,
      minAperture: nil,
      maxAperture: nil,
      activeAperture: active,
      supportedApertures: nil,
      deviceModel: device.localizedName
    )
  }

  /// UNIFIED ENTRY POINT (the only thing the UI path ever calls). Resolves the mode from
  /// capability, then routes: variable -> real AVFoundation lens control. On a FIXED
  /// lens the UI shows the real mechanical aperture and is not draggable, so this only
  /// ever executes on .variable lenses.
  func setAperture(_ fStop: Float, on device: AVCaptureDevice?, completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    mode = capabilityMode(for: device)
    guard mode == .variable else {
      completion(.failure(.apertureUnsupported))
      return
    }
    setPhysicalAperture(Double(fStop), on: device, completion: completion)
  }

  /// Set the physical lens aperture (aperture-priority: shutter and ISO stay automatic
  /// via the auto sentinels). Apple notes the hardware may settle on the nearest real
  /// physical position, which is why callers re-read currentLensAperture through
  /// getCapabilities for display.
  ///
  /// Real-device hardening (no iPhone 18 Pro in the loop during development):
  ///  - the auto sentinels are resolved through a TWO-TIER fallback (dynamic probe of
  ///    dedicated "auto" class properties → the public AVCaptureDevice
  ///    currentExposureDuration / currentISO sentinels), so the call works regardless
  ///    of which exact form Apple shipped — and on mismatch it degrades to an honest
  ///    `.apertureUnsupported`, never a crash;
  ///  - the hardware acknowledges through the setter's completion handler; a 3s
  ///    watchdog settles success if the ack never arrives, so the JS promise can never
  ///    hang (first settle wins).
  private func setPhysicalAperture(_ fStop: Double, on device: AVCaptureDevice?, completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    guard let device = device else {
      completion(.failure(.cameraUnavailable))
      return
    }

    guard let accepted = acceptedApertureRange(device) else {
      // Capability flipped away from variable between route and call - honest failure.
      mode = .fixed
      DispatchQueue.main.async { completion(.failure(.apertureUnsupported)) }
      return
    }
    // Mechanical END STOPS, not rejections: requests beyond the accepted subrange
    // (nominal max, stale Camera Control echoes) clamp to the nearest reachable stop —
    // what a physical ring does — instead of failing the settle and bouncing the UI
    // ring back to the previous stop. The only remaining failure here is a stale probe
    // (format swapped under us): re-verify the clamped target and drop the cache so the
    // next capability pass re-probes.
    let clampedTarget = Float(min(max(fStop, accepted.min), accepted.max))
    // APERTURE PRIORITY GUARD: the format must accept (aperture locked + auto shutter +
    // auto ISO). Shutter and ISO are NEVER locked — Apple auto exposure compensates the
    // light change, so .quality still gets full multi-frame fusion (user directive).
    if !supportsAperturePriority(device.activeFormat as NSObject, nominalMin: accepted.min) {
      mode = .fixed
      DispatchQueue.main.async { completion(.failure(.apertureUnsupported)) }
      return
    }
    // NO FREEZING FALLBACK: without the system auto sentinels the physical aperture
    // set would freeze shutter/ISO and darken the frame — fail explicitly instead.
    guard let auto = autoSentinels() else {
      print("[CameraEngine] physical aperture unavailable: autoExposureDuration/autoISO sentinels not present on this OS")
      completion(.failure(.apertureUnsupported))
      return
    }
    let target = clampedTarget
    let api = discoveredApi()
    guard let setterSel = api.setterSelector, device.responds(to: setterSel) else {
      completion(.failure(.apertureUnsupported))
      return
    }
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      let imp = device.method(for: setterSel)
      let gate = SettleOnceGate(completion: completion)
      if api.setterArity == 4 {
        // Per Apple docs the completion handler receives a TIMESTAMP (CMTime), not an
        // error — its invocation alone is the ack that the custom exposure was applied.
        typealias ApertureSetter = @convention(c) (NSObject, Selector, Float, CMTime, Float, ((CMTime) -> Void)?) -> Void
        let fn = unsafeBitCast(imp, to: ApertureSetter.self)
        fn(device, setterSel, target, auto.duration, auto.iso) { _ in
          gate.settle(.success(()))
        }
      } else if api.setterArity == 3 {
        // 3-arg variant has no completion handler — the watchdog below settles the
        // promise; the next getCapabilities re-reads the hardware truth for display.
        typealias ApertureSetter = @convention(c) (NSObject, Selector, Float, CMTime, Float) -> Void
        let fn = unsafeBitCast(imp, to: ApertureSetter.self)
        fn(device, setterSel, target, auto.duration, auto.iso)
      } else {
        // Discovered setter with a signature we cannot call safely — honest failure.
        gate.settle(.failure(.apertureUnsupported))
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
        // The optimistic UI already shows the chosen f-stop; getCapabilities re-reads
        // the hardware truth whenever the UI asks. Never leave the promise pending.
        gate.settle(.success(()))
      }
    } catch {
      completion(.failure(.configurationFailed))
    }
  }

  /// Resolve the "keep automatic" sentinels for shutter/ISO. Order:
  ///  1. Forward-compat dynamic probe of `autoExposureDuration` / `autoISO` class
  ///     properties (responds-checked, never referenced at link time — compiles on
  ///     every SDK; if a future iOS ships dedicated "auto" sentinels, they win).
  ///  2. The long-standing "keep current" sentinels. Xcode 26.3 RENAMED the global
  ///     constants AVCaptureExposureDurationCurrent / AVCaptureISOCurrent into these
  ///     AVCaptureDevice class properties (TestFlight run 43 compile errors → per the
  ///     compiler fixit). Semantics: shutter/ISO freeze at the momentary metered
  ///     values — an honest aperture-priority degradation, never a crash.
  /// SYSTEM AUTO SENTINELS ONLY. The previous fallback to
  /// `currentExposureDuration / currentISO` FROZE shutter+ISO at the moment of the
  /// aperture change — stopping down then darkened the frame because AE could not
  /// compensate (user-reported bug). There is deliberately NO fallback: without the
  /// real auto sentinels, physical aperture control FAILS with a clear error instead
  /// of producing dark photos. No software exposure compensation exists anywhere.
  private func autoSentinels() -> (duration: CMTime, iso: Float)? {
    let api = discoveredApi()
    let deviceClass: AnyObject = AVCaptureDevice.self
    var duration: CMTime?
    var iso: Float?
    // Tier 1: dedicated class getters IF a future OS ships them as methods.
    if let durationSel = api.autoDurationSelector, deviceClass.responds(to: durationSel),
       let imp = class_getMethodImplementation(object_getClass(AVCaptureDevice.self), durationSel) as IMP? {
      typealias ClassTimeGetter = @convention(c) (AnyObject, Selector) -> CMTime
      duration = unsafeBitCast(imp, to: ClassTimeGetter.self)(deviceClass, durationSel)
    }
    if let isoSel = api.autoIsoSelector, deviceClass.responds(to: isoSel),
       let imp = class_getMethodImplementation(object_getClass(AVCaptureDevice.self), isoSel) as IMP? {
      typealias ClassFloatGetter = @convention(c) (AnyObject, Selector) -> Float
      iso = unsafeBitCast(imp, to: ClassFloatGetter.self)(deviceClass, isoSel)
    }
    // Tier 2: exported C CONSTANTS. Build 90 real-device diag proved the sentinels
    // are NOT methods at all (no autoISO/autoExposureDuration selector exists) —
    // Apple ships them as global constants AVCaptureExposureDurationAuto /
    // AVCaptureISOAuto (per the iOS 27 setter docs). dlsym reads their storage
    // with zero compile-time symbol references (AGENTS 1.5-A compliant).
    if duration == nil { duration = Self.globalCMTime("AVCaptureExposureDurationAuto") }
    if iso == nil { iso = Self.globalFloat("AVCaptureISOAuto") }
    guard let d = duration, let i = iso, i.isFinite, i != 0 else { return nil }
    // The duration sentinel is a NON-timestamp by design (kCMTimeInvalid-shaped) —
    // never validate it with isValid; only reject all-zero garbage from a miscast.
    if d.value == 0 && d.timescale == 0 && d.flags.rawValue == 0 { return nil }
    return (d, i)
  }

  /// Read an exported global Float constant without any compile-time symbol reference.
  private static func globalFloat(_ name: String) -> Float? {
    guard let p = dlsym(dlopen(nil, RTLD_LAZY), name) else { return nil }
    return p.load(as: Float.self)
  }

  /// Read an exported global CMTime constant (same dlsym strategy as globalFloat).
  private static func globalCMTime(_ name: String) -> CMTime? {
    guard let p = dlsym(dlopen(nil, RTLD_LAZY), name) else { return nil }
    return p.load(as: CMTime.self)
  }
}

/// Settles exactly once: first of (hardware ack, watchdog) wins. The ack may arrive on
/// an AVF-internal queue while the watchdog fires on main — guarded by a lock.
private final class SettleOnceGate {
  private let lock = NSLock()
  private var settled = false
  private let completion: (Result<Void, CameraEngineError>) -> Void

  init(completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    self.completion = completion
  }

  func settle(_ result: Result<Void, CameraEngineError>) {
    lock.lock()
    let first = !settled
    settled = true
    lock.unlock()
    guard first else { return }
    DispatchQueue.main.async { self.completion(result) }
  }
}

// MARK: - Expo Module Definition
public final class CameraEngineModule: Module {
  private weak var activeView: CameraEngineView?
  private let apertureController = ApertureController()

  public func definition() -> ModuleDefinition {
    Name("CameraEngine")

    Events("onApertureChanged", "onZoomChanged", "onPhotoProcessed")

    OnCreate {
      CameraEngineView.registrationHandler = { [weak self] view, isActive in
        guard let self = self else { return }
        if isActive {
          self.activeView = view
        } else if self.activeView === view {
          self.activeView = nil
        }
      }
      // ApertureState fan-out channel: native aperture changes reach the JS ring here.
      CameraEngineView.apertureEventSink = { [weak self] fNumber in
        self?.sendEvent("onApertureChanged", ["fNumber": fNumber])
      }
      CameraEngineView.zoomEventSink = { [weak self] zoom in
        self?.sendEvent("onZoomChanged", ["zoom": zoom])
      }
    }

    OnDestroy {
      CameraEngineView.registrationHandler = nil
      CameraEngineView.apertureEventSink = nil
      CameraEngineView.zoomEventSink = nil
    }

    OnDestroy {
      CameraEngineView.registrationHandler = nil
    }

    View(CameraEngineView.self) {
      Prop("profile") { (view: CameraEngineView, profile: [String: Any]?) in
        view.setProfile(profile ?? [:])
      }
      // Rounded-rectangle "viewfinder card" (Dazz-style): the radius is set from JS so
      // the card geometry lives with the rest of the layout system.
      Prop("cornerRadius") { (view: CameraEngineView, radius: Double?) in
        view.setCornerRadius(CGFloat(radius ?? 0))
      }
      Prop("borderColor") { (view: CameraEngineView, color: String?) in
        view.setBorderColor(color)
      }
      OnViewDidUpdateProps { view in
        self.activeView = view
      }
    }

    AsyncFunction("startCamera") { (promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.setApertureController(self.apertureController)
      view.start { result in self.settle(result, promise) }
    }

    AsyncFunction("stopCamera") { (promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.stop { promise.resolve(nil) }
    }

    /// Shutter (spec §6): the promise settles when APPLE'S CAPTURE is done; the
    /// background pipeline (Camera DNA → HEIF → PhotoKit) reports later via the
    /// `onPhotoProcessed` event. equivalentMM = the current FocalStop's real
    /// 35mm-equivalent focal (0 = no ladder info, fall back to the on-device cache).
    AsyncFunction("capturePhoto") { (equivalentMM: Double, promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.capture(
        equivalentFocalMMRequest: Int(equivalentMM),
        onCaptured: { result in
          switch result {
          case .success: self.settle(.success(()), promise)
          case .failure(let error): self.reject(promise, error)
          }
        },
        onProcessed: { result, detail in
          let body: [String: Any]
          switch result {
          case .success(var payload):
            payload["ok"] = true
            body = payload
          case .failure(let error):
            body = ["ok": false, "errorCode": error.rawValue, "detail": detail ?? error.localizedDescription]
          }
          self.sendEvent("onPhotoProcessed", body)
        }
      )
    }

    AsyncFunction("setAperture") { (fStop: Double, promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.setAperture(fStop, controller: self.apertureController) { result in
        self.settle(result, promise)
      }
    }

    AsyncFunction("setApertureCoalesced") { (fStop: Double, promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.setApertureCoalesced(fStop, controller: self.apertureController) { result in
        self.settle(result, promise)
      }
    }

    AsyncFunction("setFocusPoint") { (x: Double, y: Double, promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.setFocusPoint(x: x, y: y) { result in
        DispatchQueue.main.async {
          switch result {
          case .success: promise.resolve(nil)
          case .failure(let error): promise.reject(error.rawValue, error.message)
          }
        }
      }
    }

    AsyncFunction("getCapabilities") { (promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.capabilities(controller: self.apertureController) { result in
        self.settle(result, promise)
      }
    }

    /// Authorization state WITHOUT requesting: lets the JS layer show an App Store-style
    /// explainer first and only trigger the system dialog when the user opts in.
    AsyncFunction("getCameraAuthorizationStatus") { (promise: Promise) in
      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized: promise.resolve("authorized")
      case .notDetermined: promise.resolve("notDetermined")
      case .denied: promise.resolve("denied")
      case .restricted: promise.resolve("restricted")
      @unknown default: promise.resolve("denied")
      }
    }

    /// On-device P0 triage in one round trip: the LUT bundle inventory (a JS/native version
    /// mismatch — camera list updated with the JS bundle while CameraEngineLUTs still holds
    /// the old build's resources — presents as "the LUT has no effect"), the add-only photo
    /// permission state (the top cause of "photos never reach the library"), and the
    /// hardware aperture report as the session currently sees it.
    /// TEST BUILDS ONLY: force the aperture capability for UI testing.
    /// "real" | "mock-variable" | "mock-fixed". No hardware APIs are invoked in mock
    /// modes; photos are completely unaffected. ONE `#if` pair only: the production
    /// `#else` branch must stay REACHABLE so a production build registers an honest
    /// rejection instead of no function at all (a nested outer `#if` here used to
    /// compile the `#else` out entirely).
    #if DEBUG || CAMERA18_TESTING
    AsyncFunction("setMockApertureMode") { (mode: String, promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.setMockApertureMode(mode, controller: self.apertureController)
      self.settle(.success(()), promise)
    }
    #else
    AsyncFunction("setMockApertureMode") { (_ mode: String, promise: Promise) in
      promise.reject("ERR_APERTURE_UNSUPPORTED", "Mock aperture is compiled out of production builds.")
    }
    #endif

    AsyncFunction("getDiagnostics") { (promise: Promise) in
      var bundledLuts: Set<String> = []
      for container in [Bundle(for: CameraEngineView.self), Bundle.main] {
        // pod resource_bundles packaging: CameraEngineLUTs.bundle next to the module…
        if let bundleURL = container.url(forResource: "CameraEngineLUTs", withExtension: "bundle"),
           let contents = try? FileManager.default.contentsOfDirectory(at: bundleURL, includingPropertiesForKeys: nil) {
          for url in contents where url.pathExtension == "cube" {
            bundledLuts.insert(url.deletingPathExtension().lastPathComponent)
          }
        }
        // …or resources landing directly in the module / main bundle.
        if let urls = container.urls(forResourcesWithExtension: "cube", subdirectory: nil) {
          for url in urls { bundledLuts.insert(url.deletingPathExtension().lastPathComponent) }
        }
      }
      let addStatus: String
      switch PHPhotoLibrary.authorizationStatus(for: .addOnly) {
      case .authorized: addStatus = "authorized"
      case .limited: addStatus = "limited"
      case .denied: addStatus = "denied"
      case .restricted: addStatus = "restricted"
      case .notDetermined: addStatus = "notDetermined"
      @unknown default: addStatus = "unknown"
      }
      #if DEBUG || CAMERA18_TESTING
      let testingBuildFlag = true
      #else
      let testingBuildFlag = false
      #endif
      var payload: [String: Any] = [
        "bundledLuts": bundledLuts.sorted(),
        "photoAddAuthorization": addStatus,
        "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
        "cameraControlSurface": CameraControlProbe.exposedMethods(),
        "normalizers": CameraInputNormalizer.resolvedSummary(),
        "rendererVersion": CameraDNARenderer.rendererVersion,
        "identityCheck": CameraDNARenderer.identitySelfCheck(),
        "testingBuild": testingBuildFlag,
      ]
      let finish: (Result<[String: Any], CameraEngineError>) -> Void = { result in
        if case .success(let caps) = result { payload.merge(caps) { _, newest in newest } }
        promise.resolve(payload)
      }
      if let view = self.activeView {
        view.capabilities(controller: self.apertureController, completion: finish)
      } else {
        finish(.success(self.apertureController.getCapabilities(device: AVCaptureDevice.default(for: .video)).asDictionary))
      }
    }

    /// Rear lenses present on this device, in focal-length order (0.5× → 2×).
    AsyncFunction("getAvailableLenses") { (promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.availableLenses { result in self.settle(result, promise) }
    }

    /// Switch the active rear lens (wide / ultraWide / telephoto) without restarting the session.
    AsyncFunction("setLens") { (lensId: String, promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.setLens(lensId) { result in self.settle(result, promise) }
    }

    /// Crop zoom on the ACTIVE physical lens (videoZoomFactor); applies to preview AND
    /// capture. equivalentMM = the FocalStop's real 35mm-equivalent focal (spec §3) —
    /// cached on the view so the EXIF stamp uses the ladder's truth.
    AsyncFunction("setZoomFactor") { (factor: Double, equivalentMM: Double, promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      if equivalentMM > 0 { view.noteEquivalentFocalMM(Int(equivalentMM)) }
      view.setZoomFactor(factor) { result in self.settle(result, promise) }
    }

    AsyncFunction("applyProfile") { (profile: [String: Any], promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.setProfile(profile)
      DispatchQueue.main.async { promise.resolve(nil) }
    }
  }

  private func settle<T>(_ result: Result<T, CameraEngineError>, _ promise: Promise, detail: String? = nil) {
    DispatchQueue.main.async {
      switch result {
      case .success(let value): promise.resolve(value)
      case .failure(let error): promise.reject(error.rawValue, detail ?? error.message)
      }
    }
  }

  private func reject(_ promise: Promise, _ error: CameraEngineError) {
    DispatchQueue.main.async { promise.reject(error.rawValue, error.message) }
  }
}

// MARK: - CameraEngineView
public final class CameraEngineView: ExpoView {
  fileprivate static var registrationHandler: ((CameraEngineView, Bool) -> Void)?

  private let session = AVCaptureSession()
  private let output = AVCapturePhotoOutput()
  private let sessionQueue = DispatchQueue(label: "camera-engine.session")
  private let profileLock = NSLock()
  // Raw profile is retained so compilation happens LAZILY on the consumer queue
  // (render queue for preview, photo-processing queue for capture) — compiling two
  // 33³ cubes synchronously on the RN main thread visibly hitched profile switches.
  private var profile: [String: Any] = [:]
  // ORIG / true passthrough marker (set from the profile JSON's "passthrough": true).
  private var profilePassthrough = false
  // CompiledCameraProfile v2: per-frame rendering consumes ONLY these. The preview and
  // final variants differ ONLY in the fused Input Normalizer (video-frame vs
  // processed-photo); LUT, Fine Color and Tone are identical by contract.
  private var compiledPreview: CameraDNARenderer.CompiledCameraProfile?
  private var compiledFinal: CameraDNARenderer.CompiledCameraProfile?
  private var camera: AVCaptureDevice?
  private var configured = false
  // Session-lifecycle bookkeeping (accessed only on sessionQueue): interruption and
  // runtime errors must self-heal instead of leaving a permanently frozen preview.
  private var sessionShouldRun = false
  private var interruptionObservers: [NSObjectProtocol] = []
  private var captureDelegates: [Int64: PhotoCaptureDelegate] = [:]
  // Active rear lens; confined to sessionQueue (read by configureSession / setLens).
  private var lensType: AVCaptureDevice.DeviceType = .builtInWideAngleCamera

  // Production architecture (converged): preview is DISPLAY ONLY. Every photo comes from
  // AVCapturePhotoOutput's full-resolution Apple-processed photo. No A/B/C/D triage.
  private let previewRenderer = PreviewRenderer()
  private var previewView: MTKView?
  // Fallback display for exotic no-Metal environments only.
  private let renderLayer = CALayer()
  private let videoOutput = AVCaptureVideoDataOutput()
  // Physical-orientation truth for capture rotation: the UI is portrait-locked, so the
  // scene's interface orientation can never report landscape. The gravity vector from
  // CoreMotion is unambiguous and updates regardless of the UI orientation lock.
  private let motionManager = CMMotionManager()
  private var motionOrientation: AVCaptureVideoOrientation?
  private let renderQueue = DispatchQueue(label: "camera-engine.preview-render", qos: .userInteractive)

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    renderLayer.contentsGravity = .resizeAspect
    renderLayer.backgroundColor = UIColor.black.cgColor
    layer.addSublayer(renderLayer)
    if let device = CameraEngineGPU.metalDevice {
      let view = MTKView(frame: bounds, device: device)
      // Core Image writes into the drawable texture, so framebufferOnly must be false.
      view.framebufferOnly = false
      view.isPaused = false
      view.enableSetNeedsDisplay = false
      view.preferredFramesPerSecond = 30
      view.delegate = previewRenderer
      view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      addSubview(view)
      previewView = view
      renderLayer.isHidden = true
    }
    let center = NotificationCenter.default
    interruptionObservers.append(center.addObserver(
      forName: .AVCaptureSessionInterruptionEnded, object: session, queue: nil
    ) { [weak self] _ in self?.resumeIfNeeded() })
    interruptionObservers.append(center.addObserver(
      forName: .AVCaptureSessionRuntimeError, object: session, queue: nil
    ) { [weak self] _ in self?.resumeIfNeeded() })
    // Foreground return self-heal: iOS stops the capture session while backgrounded and
    // does not reliably post InterruptionEnded on the way back — without this observer
    // the first foreground return could leave a black viewfinder until a second
    // background/foreground cycle happened to restart the session from the JS side.
    interruptionObservers.append(center.addObserver(
      forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil
    ) { [weak self] _ in self?.resumeIfNeeded() })
    // Physical rotation must follow through even though the UI is portrait-locked:
    // both the preview feed and the capture connection rotate with the device.
    UIDevice.current.beginGeneratingDeviceOrientationNotifications()
    interruptionObservers.append(center.addObserver(
      forName: UIDevice.orientationDidChangeNotification, object: nil, queue: nil
    ) { [weak self] _ in self?.syncOutputOrientation() })
    attachCameraControlInteraction()
    Self.registrationHandler?(self, true)
  }

  /// Camera Control HARD SHUTTER: AVCaptureEventInteraction (iOS 17.2+, system-delivered
  /// side-button events; we never poll the button). Press-to-the-bottom (.ended) routes
  /// into the ONE capture path — no second shutter flow exists for it.
  private func attachCameraControlInteraction() {
    guard #available(iOS 17.2, *) else { return }
    let interaction = AVCaptureEventInteraction { [weak self] event in
      guard event.phase == .ended else { return }
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        // Same single capture entry as the on-screen shutter and volume buttons.
        self.capture(equivalentFocalMMRequest: 0, onCaptured: { _ in }, onProcessed: { _, _ in })
      }
    }
    self.addInteraction(interaction)
    cameraControlObjects.append(interaction)
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    Self.registrationHandler?(self, window != nil)
  }

  deinit {
    interruptionObservers.forEach(NotificationCenter.default.removeObserver)
    // KVO observers must not outlive the view: AVCaptureDevice is a process-level
    // singleton, so a dangling videoZoomFactor observer fires into a deallocated view
    // on the next zoom change (EXC_BAD_ACCESS). stopCamera's teardown may already have
    // removed these — the nil checks keep removal idempotent.
    if let slider = apertureSliderObservedObject {
      slider.removeObserver(self, forKeyPath: "value")
      apertureSliderObservedObject = nil
    }
    if let observed = zoomKvoObservedDevice {
      observed.removeObserver(self, forKeyPath: "videoZoomFactor")
      zoomKvoObservedDevice = nil
    }
    Self.registrationHandler?(self, false)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    renderLayer.frame = bounds
    previewView?.frame = bounds
    // Re-assert the rounded clip on every layout pass: React Native may reset layer
    // properties during view updates, which previously left the card frame showing
    // rounded corners while the picture itself overflowed as a square rectangle.
    applyCornerRadius()
    // A relayout accompanies interface rotation — re-sync the output connections right
    // here so preview framing follows the rotated UI immediately (no-change guarded).
    syncOutputOrientation()
  }

  fileprivate func setProfile(_ value: [String: Any]) {
    // New color payload → bump the revision so the compiled cube rebuilds. Compilation
    // itself is deferred to the first consumer (see compiledSnapshot) so the RN main
    // thread never pays for a 33³ cube build.
    // ORIG (profile JSON marks "passthrough": true) never compiles — its capture path
    // writes Apple's photo bytes VERBATIM (see PhotoCaptureDelegate.processPassthrough).
    let passthrough = (value["passthrough"] as? Bool) == true
    profileLock.lock()
    profile = passthrough ? [:] : value
    profilePassthrough = passthrough
    compiledFinal = nil
    compiledPreview = nil
    profileLock.unlock()
    if passthrough {
      CameraDNARenderer.invalidateCompiledProfile([:])
    } else {
      CameraDNARenderer.invalidateCompiledProfile(value)
    }
  }

  /// Lazy compile: the FIRST consumer after a profile change pays the 33³ build once,
  /// on its own queue (exactly the old effectiveColorCube timing profile). The cache
  /// inside CameraDNARenderer makes every later consumer a key hit.
  private func compiledSnapshot(_ source: CameraInputNormalizer.Source) -> CameraDNARenderer.CompiledCameraProfile? {
    profileLock.lock()
    // ORIG passthrough: no compiled pipeline exists for it — the capture path writes
    // the Apple photo bytes verbatim and the preview shows the untouched feed.
    if profilePassthrough {
      profileLock.unlock()
      return nil
    }
    let compiledExisting = source == .processedPhoto ? compiledFinal : compiledPreview
    let value = profile
    profileLock.unlock()
    if let compiledExisting { return compiledExisting }

    let compiled = CameraDNARenderer.compile(value, normalizer: CameraInputNormalizer.definition(for: source))
    profileLock.lock()
    // A newer setProfile may have invalidated meanwhile — only cache if still empty.
    if source == .processedPhoto {
      if compiledFinal == nil { compiledFinal = compiled }
    } else {
      if compiledPreview == nil { compiledPreview = compiled }
    }
    let compiledLatest = source == .processedPhoto ? compiledFinal : compiledPreview
    profileLock.unlock()
    return compiledLatest
  }

  // Rounded viewfinder card: clip the preview (and every sublayer) to a continuous-corner
  // rounded rect. Applied to the root layer AND the Metal view so the drawable never
  // pokes past a corner.
  private var cornerRadiusStorage: CGFloat = 0

  fileprivate func setCornerRadius(_ radius: CGFloat) {
    cornerRadiusStorage = max(0, radius)
    applyCornerRadius()
  }

  private var borderColorStorage: UIColor?
  /// Theme-accent hairline around the viewfinder card (质感边框). Nil = no border.
  fileprivate func setBorderColor(_ hex: String?) {
    func applyHex(_ hexString: String) -> UIColor? {
      var value = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
      if value.hasPrefix("#") { value.removeFirst() }
      guard value.count == 6, let rgb = UInt64(value, radix: 16) else { return nil }
      return UIColor(red: CGFloat((rgb >> 16) & 0xFF) / 255.0,
                     green: CGFloat((rgb >> 8) & 0xFF) / 255.0,
                     blue: CGFloat(rgb & 0xFF) / 255.0, alpha: 1)
    }
    borderColorStorage = hex.flatMap(applyHex)
    let color = borderColorStorage
    for target in [layer, previewView?.layer] {
      guard let target = target else { continue }
      if let color {
        target.borderWidth = 1.5
        target.borderColor = color.cgColor
      } else {
        target.borderWidth = 0
        target.borderColor = nil
      }
    }
  }

  private func applyCornerRadius() {
    let radius = cornerRadiusStorage
    // UIView-level clipsToBounds (not just CALayer masks) so the Metal-backed subview
    // is reliably clipped on every iOS version and view configuration.
    self.clipsToBounds = radius > 0
    previewView?.clipsToBounds = radius > 0
    for target in [layer, previewView?.layer] {
      guard let target = target else { continue }
      target.cornerRadius = radius
      if radius > 0 {
        target.cornerCurve = .continuous
        target.masksToBounds = true
      } else {
        target.masksToBounds = false
      }
    }
    renderLayer.cornerRadius = radius
    renderLayer.masksToBounds = radius > 0
  }

  fileprivate func start(completion: @escaping (Result<Bool, CameraEngineError>) -> Void) {
    startMotionOrientationTracking()
    requestCamera { granted in
      guard granted else { completion(.failure(.permissionDenied)); return }
      self.sessionQueue.async {
        do {
          if !self.configured { try self.configureSession() }
          if !self.session.isRunning { self.session.startRunning() }
          self.sessionShouldRun = true
          // (Re)pin the preview to portrait + re-sync capture after ANY start: an
          // iOS-side session/connachment cycle can hand back connections whose rotation
          // was reset (the "landscape picture in the portrait finder" report).
          self.syncOutputOrientation()
          completion(.success(true))
        } catch let error as CameraEngineError { completion(.failure(error)) }
        catch { completion(.failure(.configurationFailed)) }
      }
    }
  }

  fileprivate func stop(completion: @escaping () -> Void) {
    sessionQueue.async {
      self.sessionShouldRun = false
      if self.session.isRunning { self.session.stopRunning() }
      completion()
    }
    motionManager.stopDeviceMotionUpdates()
  }

  /// Tracks the PHYSICAL device orientation from the gravity vector. The portrait-locked
  /// UI means scene interface orientation is always .portrait and orientation-did-change
  /// notifications don't fire for rotations the UI can't adopt — gravity has neither flaw.
  private func startMotionOrientationTracking() {
    guard !motionManager.isDeviceMotionActive, motionManager.isDeviceMotionAvailable else { return }
    motionManager.deviceMotionUpdateInterval = 0.2
    motionManager.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
      guard let self, let gravity = data?.gravity else { return }
      let candidate: AVCaptureVideoOrientation
      if abs(gravity.y) >= abs(gravity.x) {
        candidate = gravity.y < 0 ? .portrait : .portraitUpsideDown
      } else {
        candidate = gravity.x < 0 ? .landscapeLeft : .landscapeRight
      }
      // Commit only confident poses: a flat-held phone (gravity ≈ straight down on z)
      // must not flicker the connections between portrait and landscape.
      let dominance = max(abs(gravity.x), abs(gravity.y))
      if candidate != motionOrientation {
        // HYSTERESIS: a switch re-orients the connections (one visible glitch frame),
        // so demand a clearly dominant axis before flipping. Without this, pivoting the
        // phone near the 45° boundary flip-flopped the feed — the "twitching" in the
        // viewfinder (device report, build 44).
        guard dominance > 0.82 else { return }
      } else {
        guard dominance > 0.65 else { return }
      }
      let changed = motionOrientation != candidate
      motionOrientation = candidate
      if changed { syncOutputOrientation() }
    }
  }

  /// Self-heal after system interruptions / runtime errors: restart the session only
  /// when the app still wants it running (GOAL: never a permanent frozen preview).
  fileprivate func resumeIfNeeded() {
    sessionQueue.async {
      guard self.sessionShouldRun, self.configured, !self.session.isRunning else { return }
      self.session.startRunning()
      // Interruption restarts can hand back REBUILT connections that lost the rotation
      // we pinned at configure time — without this the preview came back landscape
      // inside the portrait finder until the next relaunch.
      self.syncOutputOrientation()
    }
  }

  /// ORIENTATION MODEL (user-confirmed, final): the viewfinder is a WINDOW GLUED TO THE
  /// PHONE — its content must always look identical to portrait, no matter how the phone
  /// is physically held. Only the SAVED PHOTO follows gravity (landscape hold → landscape
  /// photo in the library). So the PREVIEW feed is pinned to portrait forever, and the
  /// gyro drives ONLY the capture connection.
  /// Rotation debouncing still applies: re-orienting the capture connection mid-burst
  /// costs a frame; settling 300ms keeps one clean switch.
  private var lastOrientationSyncAt = TimeInterval(0)

  private func syncOutputOrientation() {
    sessionQueue.async { [self] in
      guard configured, session.isRunning else { return }
      // WINDOW METAPHOR INVARIANT (user-confirmed): the PREVIEW feed is portrait
      // FOREVER. It used to be pinned only at configure time, so any iOS-side
      // connection rebuild (interruption restart, foreground return) silently lost the
      // rotation and the portrait finder showed a landscape picture. Re-pin on EVERY
      // sync pass — applyRotation is no-change guarded, so this costs nothing when the
      // angle is already right. The CAPTURE connection below keeps its debounced
      // physical-orientation logic untouched (landscape hold ⇒ landscape photo).
      _ = applyRotation(.portrait, to: videoOutput.connection(with: .video))
      guard let orientation = currentDeviceOrientation() else { return }
      let now = CACurrentMediaTime()
      guard now - lastOrientationSyncAt > 0.3 else { return }
      if applyRotation(orientation, to: output.connection(with: .video)) {
        lastOrientationSyncAt = now
      }
    }
  }

  private func currentDeviceOrientation() -> AVCaptureVideoOrientation? {
    // The app UI is PORTRAIT-LOCKED, so the window scene's interface orientation is
    // always .portrait here and useless for capture rotation. The gravity vector
    // (CoreMotion, started with the session) is the physical truth; UIDevice's own
    // report is only the fallback before the first gravity sample arrives.
    if let motionOrientation { return motionOrientation }
    let deviceOrientation = UIDevice.current.orientation
    guard deviceOrientation.isValidInterfaceOrientation else { return nil }
    return AVCaptureVideoOrientation(rawValue: deviceOrientation.rawValue)
  }

  /// Pins the PREVIEW feed to portrait forever (window metaphor — see syncOutputOrientation)
  /// and applies the physical orientation to the CAPTURE feed only. Uses the live
  /// `videoRotationAngle` API (iOS 17+): `connection.videoOrientation` is deprecated and on
  /// recent iOS releases silently ignored for video data output. Returns true when the
  /// capture connection actually changed.
  @discardableResult
  private func setOrientation(_ orientation: AVCaptureVideoOrientation) -> Bool {
    _ = applyRotation(.portrait, to: videoOutput.connection(with: .video))
    return applyRotation(orientation, to: output.connection(with: .video))
  }

  private func applyRotation(_ orientation: AVCaptureVideoOrientation, to connection: AVCaptureConnection?) -> Bool {
    guard let connection else { return false }
    if #available(iOS 17.0, *) {
      // Apple's official videoOrientation → videoRotationAngle compatibility mapping
      // (AVFoundation "Choosing a rotation angle" table). The named
      // AVCaptureVideoRotationAngle* constants do NOT exist in the Swift interface of
      // this toolchain (CI build error), so the documented degree values are used
      // directly — they are the API contract, not an implementation detail.
      let angle: CGFloat
      switch orientation {
      case .portrait: angle = 90
      case .portraitUpsideDown: angle = 270
      case .landscapeLeft: angle = 0
      case .landscapeRight: angle = 180
      @unknown default: angle = 90
      }
      if connection.isVideoRotationAngleSupported(angle) {
        if abs(connection.videoRotationAngle - angle) > 0.5 {
          connection.videoRotationAngle = angle
          return true
        }
        return false
      }
    }
    // Pre-iOS 17 fallback.
    if connection.videoOrientation != orientation {
      connection.videoOrientation = orientation
      return true
    }
    return false
  }

  private static func applyAutoModes(to device: AVCaptureDevice) {
    if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
    if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
    if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { device.whiteBalanceMode = .continuousAutoWhiteBalance }
  }

  /// PHYSICAL LENS ROUTING (spec §1): the capture input is ALWAYS a physical camera —
  /// never a virtual triple/dual device. Each focal stop maps to one known lens:
  ///   13mm -> builtInUltraWideCamera · 26/35/52mm -> builtInWideAngleCamera (+crop
  ///   zoom) · tele -> builtInTelephotoCamera. The virtual device is consulted ONLY to
  ///   inventory which lenses a body has (tele equivalent mm), never as capture input.
  fileprivate enum PhysicalLens: String {
    case ultraWide = "ultrawide"
    case wide = "wide"
    case tele = "tele"
  }

  fileprivate static func physicalCaptureDevice(_ lens: PhysicalLens) -> AVCaptureDevice? {
    let type: AVCaptureDevice.DeviceType
    switch lens {
    case .ultraWide: type = .builtInUltraWideCamera
    case .wide: type = .builtInWideAngleCamera
    case .tele: type = .builtInTelephotoCamera
    }
    return AVCaptureDevice.default(type, for: .video, position: .back)
  }

  /// The virtual device (when the body has one) — INVENTORY ONLY: its switchover
  /// factors reveal the telephoto's native multiplier over the 13mm base.
  fileprivate static func inventoryVirtualDevice() -> AVCaptureDevice? {
    let types: [AVCaptureDevice.DeviceType] = [.builtInTripleCamera, .builtInDualCamera, .builtInDualWideCamera]
    for type in types {
      if let device = AVCaptureDevice.default(type, for: .video, position: .back) {
        return device
      }
    }
    return nil
  }

  private func configureSession() throws {
    // PHYSICAL ROUTING (spec §1/§2): the session input is the physical main (wide)
    // camera. 26/35/52mm stay on THIS input via videoZoomFactor crops; only 13mm/Tele
    // ever swap the input (setLens). Fallbacks exist only for exotic single-lens bodies.
    guard let device = CameraEngineView.physicalCaptureDevice(.wide)
      ?? CameraEngineView.physicalCaptureDevice(.ultraWide)
      ?? CameraEngineView.physicalCaptureDevice(.tele) else {
      throw CameraEngineError.cameraUnavailable
    }

    let existingInput = session.inputs.first { ($0 as? AVCaptureDeviceInput)?.device.uniqueID == device.uniqueID }
    let input = try AVCaptureDeviceInput(device: device)
    let needsInput = existingInput == nil
    let needsOutput = !session.outputs.contains { $0 === output }
    guard (!needsInput || session.canAddInput(input)), (!needsOutput || session.canAddOutput(output)) else {
      throw CameraEngineError.configurationFailed
    }

    session.beginConfiguration()
    session.sessionPreset = .photo
    if needsInput { session.addInput(input) }
    if needsOutput { session.addOutput(output) }
    // SHUTTER RESPONSE (spec §6): .balanced — Apple's recommended middle point between
    // multi-frame fusion quality and capture latency. Per-capture settings mirror this
    // (see capture()). AE/AF/AWB stay fully automatic; no self-built exposure logic.
    output.maxPhotoQualityPrioritization = .balanced
    // ProRAW capability stays available in code, but is NOT enabled by default (expert
    // review §3): the current phase targets Preview ≈ Final, and the preview feeds from
    // Apple's live pipeline. Capture through the same Apple-processed photo until a
    // dedicated ProRAW normalizer exists.
    // if #available(iOS 14.3, *), output.isAppleProRAWSupported {
    //   output.isAppleProRAWEnabled = true
    // }

    // WYSIWYG preview feed rendered through the Camera DNA pipeline. NOTE:
    // AVCaptureVideoDataOutput.videoSettings accepts ONLY the pixel-format key — the
    // kCVPixelBufferWidth/Height hints that used to sit here are silently ignored, and
    // with the .photo preset the feed arrives at FULL sensor resolution. The pipeline
    // downscales at its head instead (see captureOutput).
    if !session.outputs.contains(where: { $0 === videoOutput }) {
      videoOutput.videoSettings = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      ]
      videoOutput.alwaysDiscardsLateVideoFrames = true
      videoOutput.setSampleBufferDelegate(self, queue: renderQueue)
      if session.canAddOutput(videoOutput) {
        session.addOutput(videoOutput)
      }
    }

    session.commitConfiguration()
    camera = device
    configured = true
    // EVERYTHING device-scoped lives in ONE function (spec §2) — the same rebuild runs
    // at session configuration AND after every physical input swap (setLens).
    try configureForCurrentPhysicalCamera(device)
    let controlSurface = CameraControlProbe.exposedMethods()
    print("[CameraEngine][Diag] Camera Control public surface (\(controlSurface.count) methods): \(controlSurface.isEmpty ? "none exposed by this OS" : controlSurface.joined(separator: ", "))")
  }

  /// UNIFIED PER-LENS REBUILD (spec §2): after ANY physical input becomes active — first
  /// configuration OR a 13mm/Wide/Tele swap — re-read THIS lens's truth and re-apply every
  /// device-scoped setting. Nothing is carried over from the previous physical lens:
  ///   activeFormat → maxPhotoDimensions (24MP policy re-evaluated on THIS format)
  ///   AF/AE/AWB auto · 30fps stream cap · zoom reset · orientation
  ///   Fast Capture / ZSL / Responsive Capture capability re-check (off when unsupported)
  ///   Camera Control rebuild · aperture capability re-resolve (this lens's own format)
  private func configureForCurrentPhysicalCamera(_ device: AVCaptureDevice) throws {
    // Device-scoped policy for the ACTIVE lens.
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      CameraEngineView.applyAutoModes(to: device)
      // Cap the stream at 30fps to match the viewfinder — min duration 1/30 ⇒ at most
      // 30fps. Device-level API: the connection-level videoMinFrameDuration /
      // isVideoMinFrameDurationSupported are UNAVAILABLE in the current iOS SDK
      // (TestFlight run 43 compile errors).
      device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
      // Every lens starts its life at 1.0 (13mm/Tele have no crop zoom; the wide's
      // 35/52mm stops re-assert their factor right after via setZoomFactor).
      device.videoZoomFactor = 1.0
      currentEquivalentMM = 0
    } catch {
      throw CameraEngineError.configurationFailed
    }

    // PHOTO FORMAT POLICY: the activeFormat must serve THIS device's BEST fully
    // processed photo. Audit-log the facts so any mismatch is visible in the field.
    do {
      let machine = {
        var systemInfo = utsname()
        uname(&systemInfo)
        return withUnsafeBytes(of: &systemInfo.machine) { raw in
          let cchars = raw.bindMemory(to: CChar.self)
          guard let base = cchars.baseAddress else { return "" }
          return String(cString: base)
        }
      }()
      print("[CameraEngine][Diag] lens config device=\(device.deviceType.rawValue) model=\(machine) lens=\(device.localizedName)")
      if #available(iOS 16.0, *) {
        let supported = device.activeFormat.supportedMaxPhotoDimensions
        let dimsText = supported.map { "\($0.width)x\($0.height)" }.joined(separator: ", ")
        let has24MP = supported.contains { $0.width * $0.height >= 23_000_000 && $0.width * $0.height <= 25_000_000 }
        print("[CameraEngine][Diag] activeFormat photo dimensions: [\(dimsText)] exact24MP=\(has24MP)")
      }
      if #available(iOS 27.0, *) {
        // CRASH SAFETY: responds-guarded KVC (see capture() note).
        let format = device.activeFormat as NSObject
        let hasMin = format.responds(to: NSSelectorFromString("minLensAperture"))
        let hasMax = format.responds(to: NSSelectorFromString("maxLensAperture"))
        let minA = hasMin ? (format.value(forKey: "minLensAperture") as? NSNumber)?.doubleValue : nil
        let maxA = hasMax ? (format.value(forKey: "maxLensAperture") as? NSNumber)?.doubleValue : nil
        print("[CameraEngine][Diag] activeFormat lens aperture range: \(minA ?? 0)–\(maxA ?? 0) (variable = \(minA.map { $0 > 0 } ?? false))")
      }
    }

    // PHOTO DIMENSIONS — 24MP policy RE-READ from THIS lens's activeFormat (spec §2):
    // ~24MP supported → use the largest 24MP tier; otherwise THIS format's best
    // supported dimension. The previous lens's dimensions are NEVER carried over.
    if #available(iOS 16.0, *) {
      let supported = device.activeFormat.supportedMaxPhotoDimensions
      if !supported.isEmpty {
        let exact24 = supported.filter { $0.width * $0.height >= 23_000_000 && $0.width * $0.height <= 25_000_000 }
        let chosen: CMVideoDimensions
        if let best24 = exact24.max(by: { $0.width * $0.height < $1.width * $1.height }) {
          chosen = best24
        } else {
          chosen = supported.max(by: { $0.width * $0.height < $1.width * $1.height })!
          print("[CameraEngine][Diag] no ~24MP dimension on this lens — using its best \(chosen.width)x\(chosen.height)")
        }
        output.maxPhotoDimensions = chosen
        print("[CameraEngine][Diag] maxPhotoDimensions = \(chosen.width)x\(chosen.height) (\(chosen.width * chosen.height / 1_000_000)MP)")
      }
    }

    // FAST-CAPTURE TRIO re-check per physical lens (spec §2): capability-driven;
    // supported → on, unsupported → explicitly OFF (never a stale carry-over).
    //  - Zero Shutter Lag + Fast Capture Prioritization: public since iOS 17; both are
    //    effective only when a capture asks for .balanced/.speed — which it does.
    //  - Responsive Capture: iOS 26-era surface, probed DYNAMICALLY (responds + KVC) so
    //    this file still compiles against older SDKs (AGENTS rule A).
    if #available(iOS 17.0, *) {
      if output.isZeroShutterLagSupported {
        output.isZeroShutterLagEnabled = true
        print("[CameraEngine][Diag] zero-shutter-lag enabled")
      } else {
        output.isZeroShutterLagEnabled = false
      }
      if output.isFastCapturePrioritizationSupported {
        output.isFastCapturePrioritizationEnabled = true
        print("[CameraEngine][Diag] fast capture prioritization enabled")
      } else {
        output.isFastCapturePrioritizationEnabled = false
      }
    }
    if output.responds(to: NSSelectorFromString("isResponsiveCaptureSupported")),
       (output.value(forKey: "responsiveCaptureSupported") as? Bool) == true,
       output.responds(to: NSSelectorFromString("setResponsiveCaptureEnabled:")) {
      output.setValue(true, forKey: "responsiveCaptureEnabled")
      print("[CameraEngine][Diag] responsive capture enabled (output-level)")
    }
    // DEFERRED PHOTO DELIVERY STAYS OFF (final-photo spec): Camera 18 must receive the
    // FULLY processed photo synchronously in didFinishProcessingPhoto (full photo →
    // Camera DNA → HEIF → PhotoKit). No deferred proxy / two-phase final photo.

    if let orientation = currentDeviceOrientation() {
      _ = setOrientation(orientation)
    }
    // Camera Control belongs to THIS device — tear down the outgoing lens's sliders
    // and rebuild against the new one.
    teardownCameraControls()
    setupCameraControls(device: device)
    refreshApertureCapabilities()
  }

  /// TWO settle channels (spec §6 — shutter response decoupled from post-processing):
  ///  - onCaptured settles the JS shutter promise at Apple-capture-complete
  ///    (didFinishProcessingPhoto) — Camera DNA / HEIF / PhotoKit never gate the shutter.
  ///  - onProcessed reports the background pipeline outcome as the onPhotoProcessed event.
  /// Gates, in order: session running → Apple captureReadiness (iOS 17+) → in-flight
  /// pipeline cap → physical-lens switch in progress.
  fileprivate func capture(equivalentFocalMMRequest: Int, onCaptured: @escaping (Result<Void, CameraEngineError>) -> Void, onProcessed: @escaping (Result<[String: Any], CameraEngineError>, String?) -> Void) {
    sessionQueue.async {
      guard self.session.isRunning else { onCaptured(.failure(.notRunning)); return }
      CameraTempFiles.removeUntrackedFiles()

      // SHUTTER READINESS (spec §6): Apple's own captureReadiness — the photo pipe's
      // honest "can I take another shot right now", independent of the app pipeline.
      if #available(iOS 17.0, *) {
        if self.output.captureReadiness != .ready {
          onCaptured(.failure(.captureBusy))
          return
        }
      }
      // Background pipelines stay bounded (memory): a small in-flight cap keeps 24MP
      // CIImage + encode pressure flat; the user gets an honest busy signal instead of
      // a crash or silent queue growth.
      guard self.captureDelegates.count < 3 else {
        onCaptured(.failure(.captureBusy))
        return
      }
      // Physical input swap in progress (preview mid-crossfade): refuse honestly.
      guard !self.lensSwitching else {
        onCaptured(.failure(.captureBusy))
        return
      }

      // PRODUCTION PIPELINE: one source, one truth — the full-resolution Apple-processed
      // photo (ORIG bypasses rendering entirely — see PhotoCaptureDelegate.processPassthrough).
      let photoSettings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])

      photoSettings.photoQualityPrioritization = .balanced
      // Per-capture mirror of output.maxPhotoDimensions (iOS 16+): guarantee the CURRENT
      // lens's dimension target every capture — re-derived per physical input in
      // configureForCurrentPhysicalCamera, never cached across a lens swap.
      if #available(iOS 16.0, *) {
        let maxDims = self.output.maxPhotoDimensions
        if maxDims.width > 0 { photoSettings.maxPhotoDimensions = maxDims }
      }
      // RESPONSIVE CAPTURE (shutter-latency optimization, iOS 26-era public surface):
      // probed DYNAMICALLY so this file compiles against any SDK — what the runtime
      // actually exposes wins, nothing is guessed statically.
      //
      // CRASH SAFETY: NSObject.value(forKey:) is NOT a throwing API — a missing key
      // raises NSUnknownKeyException at the ObjC level, which Swift's try?/catch cannot
      // intercept (hard crash). Every KVC access below is therefore GUARDED by
      // responds(to:) on the exact getter/setter selector first (the same proven pattern
      // as ApertureController) — the key is guaranteed present before KVC ever runs.
      let outputResponds = self.output.responds(to: NSSelectorFromString("responsiveCaptureSupported"))
        || self.output.responds(to: NSSelectorFromString("isResponsiveCaptureSupported"))
      let settingsResponds = photoSettings.responds(to: NSSelectorFromString("setResponsiveCaptureEnabled:"))
      if outputResponds, (self.output.value(forKey: "responsiveCaptureSupported") as? Bool) == true, settingsResponds {
        // Setter existence verified above → KVC set cannot raise an unknown-key exception.
        photoSettings.setValue(true, forKey: "responsiveCaptureEnabled")
        print("[CameraEngine][Diag] responsive capture ENABLED for this shot")
      }
      // DEFERRED PHOTO PROCESSING stays OFF (final-photo spec): Camera 18 must receive
      // the fully processed photo in didFinishProcessingPhoto immediately. Read back the
      // switch (getter-existence guarded, see crash note above) so an OS default flipping
      // it on is caught loudly.
      let deferredResponds = photoSettings.responds(to: NSSelectorFromString("deferredProcessingEnabled"))
        || photoSettings.responds(to: NSSelectorFromString("isDeferredProcessingEnabled"))
      if deferredResponds, let deferred = photoSettings.value(forKey: "deferredProcessingEnabled") as? Bool {
        print("[CameraEngine][Diag] deferred photo processing = \(deferred) (must stay false)")
        assert(!deferred, "deferred photo processing must stay disabled")
      }
      // Landscape-held captures must stay landscape in the photo library: rotate the capture
      // connection to the physical device orientation so buffers arrive already upright and
      // the saved file needs no EXIF rotation fix-up.
      if let orientation = self.currentDeviceOrientation() {
        _ = self.applyRotation(orientation, to: self.output.connection(with: .video))
      }
      // EXIF focal stamp (spec §3): the JS focal ladder OWNS the truth — each FocalStop
      // carries its real 35mm-equivalent mm, pushed here (and cached on the view by
      // setZoomFactor). Legacy base×zoom estimate only survives as a last-resort
      // fallback for captures with no ladder info (e.g. Camera Control hard shutter
      // before any dial touch).
      let appliedZoom = self.camera?.videoZoomFactor ?? 1.0
      let baseEquivalentMM: Double = self.camera?.deviceType == .builtInWideAngleCamera ? 26.0 : 13.0
      let requestedMM = equivalentFocalMMRequest > 0 ? equivalentFocalMMRequest : self.currentEquivalentMM
      let equivalentFocalMM = requestedMM > 0 ? requestedMM : Int((baseEquivalentMM * appliedZoom).rounded())
      // Real iris position at shutter time (variable lens) — stamped over Apple's
      // nominal-lens FNumber in the encoded EXIF. Fixed lenses read their one true stop.
      let apertureAtShutter = self.apertureControllerRef.map { controller -> Double in
        guard let device = self.camera else { return 0 }
        return controller.currentAperture(device)
      } ?? 0
      let id = photoSettings.uniqueID
      let delegate = PhotoCaptureDelegate(
        compiled: self.compiledSnapshot(.processedPhoto),
        appliedZoom: appliedZoom,
        equivalentFocalMM: equivalentFocalMM,
        apertureAtShutter: apertureAtShutter,
        onCaptured: onCaptured,
        onProcessed: { [weak self] result, detail in
          self?.sessionQueue.async { self?.captureDelegates.removeValue(forKey: id) }
          onProcessed(result, detail)
        }
      )
      self.captureDelegates[id] = delegate
      // PIPELINE WATCHDOG: delegates are otherwise only evicted by onProcessed — a stalled
      // permission prompt or a lost PhotoKit callback would burn one of the 3 in-flight
      // seats forever and eventually brick the shutter (ERR_CAPTURE_BUSY). Evict after 60s;
      // the JS 20s shutter timeout already reported the failure to the user long before.
      self.sessionQueue.asyncAfter(deadline: .now() + 60) { [weak self] in
        if self?.captureDelegates.removeValue(forKey: id) != nil {
          print("[CameraEngine][Diag] pipeline watchdog: evicted stalled delegate \(id) after 60s")
        }
      }
      self.output.capturePhoto(with: photoSettings, delegate: delegate)
    }
  }

  // Aperture capability for the CAPTURE path (drives real iris vs fixed UI).
  // Defaults mirror the controller so captures taken before any ring touch are sane
  // (f/1.8 simulated would blur — but the processor skips when no person mask exists,
  // and the DEFAULT aperture state on fixed-lens devices is resolved by capabilities).
  fileprivate var apertureMode: ApertureMode = .fixed
  // Lens-scoped runtime state lock: guards lensSwitching AND currentEquivalentMM,
  // both written from sessionQueue + renderQueue.
  private let lensStateLock = NSLock()
  private var lensSwitchingStorage = false
  fileprivate var lensSwitching: Bool {
    get { lensStateLock.lock(); defer { lensStateLock.unlock() }; return lensSwitchingStorage }
    set { lensStateLock.lock(); lensSwitchingStorage = newValue; lensStateLock.unlock() }
  }
  // 35mm-equivalent focal of the CURRENT FocalStop (spec §3) — pushed by the JS ladder
  // through setZoomFactor; the EXIF stamp prefers it over the legacy base×zoom estimate.
  private var currentEquivalentMMStorage = 0
  private var currentEquivalentMM: Int {
    get { lensStateLock.lock(); defer { lensStateLock.unlock() }; return currentEquivalentMMStorage }
    set { lensStateLock.lock(); currentEquivalentMMStorage = newValue; lensStateLock.unlock() }
  }
  // Camera Control (hardware side button): retained controls + interaction objects.
  private var cameraControlObjects: [AnyObject] = []
  // The aperture slider we observe via KVO (needed for symmetric removal on input swap).
  private var apertureSliderObservedObject: NSObject?
  // The module owns the controller; the view keeps a weak ref for control callbacks.
  fileprivate weak var apertureControllerRef: ApertureController?
  fileprivate func setApertureController(_ controller: ApertureController) {
    apertureControllerRef = controller
  }
  /// JS focal ladder pushes the current FocalStop's real equivalent focal (spec §3).
  fileprivate func noteEquivalentFocalMM(_ mm: Int) {
    currentEquivalentMM = mm
  }
  // JS event sinks (wired by the module so the view can stay module-free).
  fileprivate static var apertureEventSink: ((Double) -> Void)?
  fileprivate static var zoomEventSink: ((Double) -> Void)?
  // KVO contexts (Camera Control value observation — compile-safe alternative to the
  // unavailable addAction API).
  private var apertureSliderKvoContext = 0
  private var zoomKvoContext = 0
  private weak var zoomKvoObservedDevice: AVCaptureDevice?

  /// TEST BUILDS ONLY: force the aperture capability for UI testing.
  /// "mock-variable" / "mock-fixed" / "real". Mock modes touch STATE ONLY — the real
  /// lens aperture API is never called and photos are completely unaffected.
  #if DEBUG || CAMERA18_TESTING
  fileprivate func setMockApertureMode(_ mode: String, controller: ApertureController) {
    sessionQueue.async {
      switch mode {
      case "mock-variable":
        controller.mockOverride = .variable
        controller.mode = .variable
        self.apertureMode = .variable
      case "mock-fixed":
        controller.mockOverride = .fixed
        controller.mode = .fixed
        self.apertureMode = .fixed
      default: // "real"
        controller.mockOverride = nil
        controller.mode = controller.capabilityMode(for: self.camera)
        self.apertureMode = controller.mode
      }
      print("[CameraEngine][Diag] mock aperture mode set: \(mode)")
    }
  }
  #endif

  fileprivate func setAperture(_ fStop: Double, controller: ApertureController, completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    sessionQueue.async {
      // MOCK VARIABLE (testing builds): state + event fan-out ONLY — the real lens
      // aperture API is never invoked, exposure is never touched, photos are unchanged.
      #if DEBUG || CAMERA18_TESTING
      if controller.mockOverride == .variable {
        self.apertureMode = .variable
        Self.apertureEventSink?(Double(fStop))
        DispatchQueue.main.async { completion(.success(())) }
        return
      }
      #endif
      guard let device = self.camera ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
        completion(.failure(.cameraUnavailable))
        return
      }
      controller.setAperture(Float(fStop), on: device) { result in
        if case .success = result {
          self.apertureMode = controller.mode
          // ApertureState fan-out: the screen ring and the Camera Control slider stay
          // numerically in sync through this single channel.
          Self.apertureEventSink?(Double(fStop))
        }
        completion(result)
      }
    }
  }

  /// Drag-PREVIEW aperture (screen ring mid-drag): coalesced to at most one
  /// lockForConfiguration per 0.12s window (trailing value wins) — the exact path the
  /// Camera Control slider uses, so the viewfinder reacts live while dragging without
  /// flooding the session queue. The ring's RELEASE still settles through the
  /// authoritative single-commit setAperture above.
  fileprivate func setApertureCoalesced(_ fStop: Double, controller: ApertureController, completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    sessionQueue.async {
      #if DEBUG || CAMERA18_TESTING
      if controller.mockOverride == .variable {
        Self.apertureEventSink?(Double(fStop))
        DispatchQueue.main.async { completion(.success(())) }
        return
      }
      #endif
      guard let device = self.camera else {
        completion(.failure(.cameraUnavailable))
        return
      }
      controller.requestCoalescedPhysicalAperture(Float(fStop), on: device) { result in
        if case .success = result { self.apertureMode = controller.mode }
        completion(result)
      }
    }
  }

  /// Tap-to-focus: the JS layer sends the tap as a point normalized to the view (0..1).
  /// The preview is our own rendered 4:3 frame letterboxed inside the view (resizeAspect),
  /// so the tap is mapped through the same letterbox math into frame coordinates, then
  /// normalized into the sensor's natural space — continuous AF/AE stay active.
  fileprivate func setFocusPoint(x: Double, y: Double, completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    DispatchQueue.main.async {
      let bounds = self.previewView?.bounds ?? self.renderLayer.bounds
      let extent = self.previewRenderer.currentExtent
      guard bounds.width > 0, bounds.height > 0, extent.width > 0, extent.height > 0 else {
        completion(.failure(.notRunning))
        return
      }
      let scale = min(bounds.width / extent.width, bounds.height / extent.height)
      let offsetX = (bounds.width - extent.width * scale) / 2
      let offsetY = (bounds.height - extent.height * scale) / 2
      let imageX = (CGFloat(x) * bounds.width - offsetX) / scale
      let imageY = (CGFloat(y) * bounds.height - offsetY) / scale
      let nx = min(1, max(0, imageX / extent.width))
      let ny = min(1, max(0, imageY / extent.height))

      // Frames are delivered rotated by connection.videoOrientation, but focus/exposure
      // points of interest expect coordinates in the sensor's natural (portrait) space.
      let orientation = self.videoOutput.connection(with: .video)?.videoOrientation ?? .portrait
      let devicePoint = CameraEngineView.naturalPoint(normalX: nx, normalY: ny, orientation: orientation)

      self.sessionQueue.async {
        guard let device = self.camera, device.isConnected else {
          completion(.failure(.notRunning))
          return
        }
        do {
          try device.lockForConfiguration()
          defer { device.unlockForConfiguration() }
          if device.isFocusPointOfInterestSupported { device.focusPointOfInterest = devicePoint }
          if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
          if device.isExposurePointOfInterestSupported { device.exposurePointOfInterest = devicePoint }
          if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
          completion(.success(()))
        } catch {
          completion(.failure(.configurationFailed))
        }
      }
    }
  }

  /// PHYSICAL lens inventory for the JS focal ladder (spec §1): which physical cameras
  /// exist (ultraWide / tele) plus the tele's native multiplier over the 13mm base.
  /// The JS side builds one stop per EXISTING physical lens — missing lenses hide.
  fileprivate func availableLenses(completion: @escaping (Result<[String: Any], CameraEngineError>) -> Void) {
    sessionQueue.async {
      // PHYSICAL INVENTORY (spec §1): report which PHYSICAL lenses exist. The virtual
      // device is read ONLY for the tele's native multiplier over the 13mm base — it is
      // never a capture input.
      var teleZoom: Double? = nil
      if let virtual = CameraEngineView.inventoryVirtualDevice(),
         virtual.responds(to: NSSelectorFromString("virtualDeviceSwitchOverVideoZoomFactors")),
         let factors = virtual.value(forKey: "virtualDeviceSwitchOverVideoZoomFactors") as? [NSNumber] {
        let sorted = factors.map(\.doubleValue).sorted()
        if sorted.count >= 2, let last = sorted.last, last > 2.0 {
          teleZoom = last
        }
      }
      let hasUltraWide = CameraEngineView.physicalCaptureDevice(.ultraWide) != nil
      let hasTele = CameraEngineView.physicalCaptureDevice(.tele) != nil
      let main = CameraEngineView.physicalCaptureDevice(.wide)
      DispatchQueue.main.async {
        completion(.success([
          "kind": "physical",
          "deviceModel": main?.localizedName ?? "Unknown Device",
          "ultraWide": hasUltraWide,
          "tele": hasTele,
          "teleZoom": teleZoom ?? NSNull(),
        ]))
      }
    }
  }

  /// Apply a crop zoom on the capture device (device.videoZoomFactor). On a virtual
  /// device the system performs the seamless physical-camera crossfade when the factor
  /// crosses lens boundaries — preview feed and AVCapturePhotoOutput see the exact same
  /// framing (WYSIWYG). Ceiling is the hardware's own videoMaxZoomFactor.
  fileprivate func setZoomFactor(_ factor: Double, completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    sessionQueue.async {
      guard let device = self.camera, device.isConnected else {
        completion(.failure(.notRunning)); return
      }
      do {
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        device.videoZoomFactor = min(max(1.0, factor), device.activeFormat.videoMaxZoomFactor)
        completion(.success(()))
      } catch {
        completion(.failure(.configurationFailed))
      }
    }
  }

  /// PHYSICAL INPUT SWAP (spec §1/§3): 13mm / Tele switch the physical camera input
  /// (beginConfiguration → remove old input → add new input → commit); 26/35/52 NEVER
  /// come here — they stay on the physical wide and only move videoZoomFactor
  /// (setZoomFactor), so the main lens's variable iris (when the hardware has one)
  /// serves all three stops without any input churn.
  /// After a swap, everything device-scoped is re-applied against the NEW lens:
  /// applyAutoModes, the 30fps stream cap, zoom=1.0, orientation, Camera Control
  /// rebuild, and the aperture capability re-resolve (13mm/Tele are honest FIXED
  /// lenses; capability is read from THEIR OWN activeFormat, never inferred from a
  /// virtual device).
  fileprivate func setLens(_ lensId: String, completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    sessionQueue.async {
      guard let lens = CameraEngineView.PhysicalLens(rawValue: lensId),
            let target = CameraEngineView.physicalCaptureDevice(lens) else {
        completion(.failure(.cameraUnavailable))
        return
      }
      if let current = self.camera, current.deviceType == target.deviceType {
        // Same physical lens (26↔35↔52 all live on the Wide): NO input swap, NO
        // re-configuration — the user's real aperture and zoom survive untouched.
        completion(.success(()))
        return
      }
      // PREVIEW CROSSFADE (spec §5): freeze on the OLD lens's last frame while the
      // session rewires; capture stays refused until the NEW lens's first frame lands.
      self.lensSwitching = true
      self.previewRenderer.beginHold()
      let input: AVCaptureDeviceInput
      do {
        input = try AVCaptureDeviceInput(device: target)
      } catch {
        self.lensSwitching = false
        self.previewRenderer.endTransition()
        completion(.failure(.cameraUnavailable))
        return
      }
      self.session.beginConfiguration()
      if let old = self.camera {
        for candidate in self.session.inputs
        where (candidate as? AVCaptureDeviceInput)?.device.uniqueID == old.uniqueID {
          self.session.removeInput(candidate)
        }
      }
      guard self.session.canAddInput(input) else {
        self.session.commitConfiguration()
        self.lensSwitching = false
        self.previewRenderer.endTransition()
        completion(.failure(.configurationFailed))
        return
      }
      self.session.addInput(input)
      self.session.commitConfiguration()
      self.camera = target
      self.configured = true
      // UNIFIED per-lens rebuild (spec §2): device auto modes, 30fps cap, zoom reset,
      // maxPhotoDimensions re-read from THIS activeFormat, fast-capture trio re-check,
      // orientation, Camera Control rebuild, aperture capability re-resolve.
      do {
        try self.configureForCurrentPhysicalCamera(target)
      } catch {
        // The input swap is already COMMITTED at this point — it cannot roll back, so
        // keep the new lens and surface the partial configuration loudly (the unified
        // rebuild is idempotent and the next startCamera/lens pass completes it).
        print("[CameraEngine][Diag] lens swap: per-lens rebuild FAILED for \(target.localizedName): continuing with committed input")
        self.lensSwitching = false
        self.previewRenderer.endTransition()
        completion(.failure(.configurationFailed))
        return
      }
      // NEW lens is live: fade the preview from the held old frame to the new feed.
      self.previewRenderer.beginFade()
      // WATCHDOG: the normal unlock is the new lens's first accepted preview frame
      // (captureOutput). If frames somehow never resume, never leave the shutter
      // permanently locked behind the lens-switch embargo.
      self.sessionQueue.asyncAfter(deadline: .now() + 2.5) {
        if self.lensSwitching {
          self.lensSwitching = false
          print("[CameraEngine][Diag] lens-switch watchdog released the capture embargo")
        }
      }
      completion(.success(()))
    }
  }

  /// Remove every Camera Control binding tied to the outgoing physical device:
  /// the aperture slider's KVO observation, all controls, and the zoom-device KVO.
  private func teardownCameraControls() {
    guard #available(iOS 18.0, *) else { return }
    if let slider = apertureSliderObservedObject {
      slider.removeObserver(self, forKeyPath: "value")
      apertureSliderObservedObject = nil
    }
    if let observed = zoomKvoObservedDevice {
      observed.removeObserver(self, forKeyPath: "videoZoomFactor")
      zoomKvoObservedDevice = nil
    }
    for object in cameraControlObjects {
      if let control = object as? AVCaptureControl, session.controls.contains(control) {
        session.removeControl(control)
      }
    }
    cameraControlObjects.removeAll()
    print("[CameraEngine][Diag] Camera Control teardown for input swap")
  }

  override public func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
    if context == &apertureSliderKvoContext {
      guard let slider = object as? NSObject,
            let value = (slider.value(forKey: "value") as? NSNumber)?.doubleValue else { return }
      if let controller = apertureControllerRef, controller.mode == .variable,
         let device = camera {
        controller.requestCoalescedPhysicalAperture(Float(value), on: device) { _ in }
        Self.apertureEventSink?(value)
      }
      return
    }
    if context == &zoomKvoContext {
      if let zoom = (change?[.newKey] as? NSNumber)?.doubleValue {
        Self.zoomEventSink?(zoom)
      }
      // PHYSICAL ROUTING: zoom no longer changes lenses (26/35/52 are crops on the one
      // physical wide). The re-resolve stays as a cheap safety net — it re-reads the
      // CURRENT physical device's own format and is a no-op when nothing changed.
      refreshApertureCapabilities()
      return
    }
    super.observeValue(forKeyPath: keyPath, of: object, change: change, context: context)
  }

  /// Re-resolve the aperture capability against the CURRENT device + activeFormat.
  /// Called on session configuration and whenever the lens could have changed (spec §10).
  fileprivate func refreshApertureCapabilities() {
    sessionQueue.async {
      guard let controller = self.apertureControllerRef, let device = self.camera else { return }
      let mode = controller.capabilityMode(for: device)
      controller.mode = mode
      self.apertureMode = mode
      print("[CameraEngine][Diag] aperture capability refresh: mode=\(mode == .variable ? "variable" : "fixed") device=\(device.localizedName)")
    }
  }

  /// Camera Control SLIDERS (iOS 18 AVCaptureControl — the system owns all side-button
  /// touch/slide/press gesture parsing; we only add controls). Priority: Aperture, Zoom.
  /// The aperture slider binds to the SAME unified setAperture path as the on-screen
  /// ring; the zoom slider is the system one bound to the capture device (no custom zoom).
  private func setupCameraControls(device: AVCaptureDevice) {
    guard #available(iOS 18.0, *) else { return }
    guard let controller = apertureControllerRef else {
      print("[CameraEngine][Diag] Camera Control: controller not attached yet")
      return
    }
    guard session.supportsControls else {
      print("[CameraEngine][Diag] Camera Control: session does not support controls on this device")
      return
    }
    // Aperture slider ONLY when the current lens has a real variable iris (capability);
    // a fixed lens skips it entirely (Camera Control keeps the zoom slider).
    controller.mode = controller.capabilityMode(for: device)
    let variableIris = controller.mode == .variable
    let caps = controller.getCapabilities(device: device).asDictionary
    let minimum = (caps["minAperture"] as? Double) ?? 1.4
    let maximum = (caps["maxAperture"] as? Double) ?? 4.0
    let stops = (caps["supportedApertures"] as? [Double]) ?? []

    // Aperture slider ONLY when the current lens has a real variable iris (capability);
    // a fixed lens skips it entirely (Camera Control keeps the zoom slider).
    guard variableIris else {
      print("[CameraEngine][Diag] Camera Control: fixed lens - aperture slider skipped (zoom only)")
      return
    }
    // The init labels are not visible in the Swift interface (CI-proven), so construct
    // the slider through the ObjC runtime, trying the documented selectors in order.
    // No selector matching -> aperture slider skipped; Camera Control still offers zoom.
    guard let slider = makeApertureSlider(minimum: Float(minimum), maximum: Float(maximum), stops: stops.map { Float($0) }) else {
      print("[CameraEngine][Diag] Camera Control: no compatible AVCaptureSlider initializer — aperture slider skipped")
      return
    }
    slider.addObserver(self, forKeyPath: "value", options: [.new], context: &apertureSliderKvoContext)
    apertureSliderObservedObject = slider
    if let control = slider as? AVCaptureControl {
      if session.canAddControl(control) {
        session.addControl(control)
      }
    }
    cameraControlObjects.append(slider)

    let zoomSlider = AVCaptureSystemZoomSlider(device: device)
    if let zoomControl = zoomSlider as? AVCaptureControl {
      if session.canAddControl(zoomControl) {
        session.addControl(zoomControl)
      }
      cameraControlObjects.append(zoomSlider)
    } else {
      print("[CameraEngine][Diag] Camera Control: zoom slider is not an AVCaptureControl on this OS - skipped")
    }
    // The SYSTEM zoom slider drives videoZoomFactor itself; observe the device to fan
    // the value out to the JS focal dial (compile-safe KVO).
    device.addObserver(self, forKeyPath: "videoZoomFactor", options: [.new], context: &zoomKvoContext)
    zoomKvoObservedDevice = device
    // controlsDelegate property is GET-ONLY in this SDK; the dynamic setter exists.
    if session.responds(to: NSSelectorFromString("setControlsDelegate:")) {
      session.perform(NSSelectorFromString("setControlsDelegate:"), with: self)
    }
    print("[CameraEngine][Diag] Camera Control controls added: aperture slider + system zoom slider")
  }

  /// Constructs the Camera Control aperture slider through the ObjC runtime — the init
  /// labels are not exposed in the Swift interface. Candidates are tried in order and
  /// min/max/prominent values are set via responds-guarded KVC. Returns nil when the
  /// class/initializers are unavailable on this OS (Camera Control keeps zoom only).
  private func makeApertureSlider(minimum: Float, maximum: Float, stops: [Float]) -> NSObject? {
    // alloc goes through the class-method IMP too: `AnyClass` has no statically visible
    // `perform` (run 65: "no exact matches in call to instance method 'perform'").
    guard let cls = NSClassFromString("AVCaptureSlider"),
          let allocMethod = class_getClassMethod(cls, NSSelectorFromString("alloc")) else { return nil }
    typealias AllocFactory = @convention(c) (AnyObject, Selector) -> AnyObject
    let allocFn = unsafeBitCast(method_getImplementation(allocMethod), to: AllocFactory.self)
    let alloced = allocFn(cls, NSSelectorFromString("alloc"))
    let candidates = [
      "initWithMinimumValue:maximumValue:",
      "initWithMin:max:",
    ]
    for name in candidates {
      let sel = NSSelectorFromString(name)
      guard let method = class_getInstanceMethod(cls, sel) else { continue }
      let imp = method_getImplementation(method)
      typealias Factory = @convention(c) (AnyObject, Selector, Float, Float) -> AnyObject
      let fn = unsafeBitCast(imp, to: Factory.self)
      guard let slider = fn(alloced, sel, minimum, maximum) as? NSObject else { continue }
      if slider.responds(to: NSSelectorFromString("setProminentValues:")) {
        slider.setValue(stops, forKey: "prominentValues")
      }
      return slider
    }
    return nil
  }

  fileprivate func capabilities(controller: ApertureController, completion: @escaping (Result<[String: Any], CameraEngineError>) -> Void) {
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      completion(.failure(.permissionDenied))
      return
    }
    sessionQueue.async {
      self.setApertureController(controller)
      guard let device = self.camera ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
        completion(.failure(.cameraUnavailable)); return
      }

      let canQueryOutput = self.configured && self.session.outputs.contains { $0 === self.output }
      var proRaw = false
      if #available(iOS 14.3, *), canQueryOutput { proRaw = self.output.isAppleProRAWSupported }
      let rawSupported = canQueryOutput && !self.output.availableRawPhotoPixelFormatTypes.isEmpty

      var caps = controller.getCapabilities(device: device).asDictionary

      // UNIFIED APERTURE: resolve the mode from capability and expose it. .fixed lenses
      // report their single mechanical aperture in min/max (UI shows it, no drag).
      let apertureMode = controller.capabilityMode(for: device)
      controller.mode = apertureMode
      self.apertureMode = apertureMode
      caps["apertureMode"] = apertureMode == .variable ? "variable" : "fixed"
      // Gate-by-gate capability diagnostics: the in-app diag log (⚙ test panel) and
      // NSLog (Mac Console.app) both carry WHY the device resolved its mode.
      let diag = controller.lastCapabilityDiag()
      caps["apertureDiag"] = diag.asDictionary
      if apertureMode == .fixed {
        let summary = "fixed: sentinels=\(diag.autoSentinelsOk) range=\(diag.rangeOk)(\(diag.minAperture)-\(diag.maxAperture)) setter=\(diag.setterOk) probe=\(diag.probeOk)/\(diag.probeApiExists) span=\(diag.probeSpan) stops=\(diag.stopsCount) matched[\(diag.matchedSelectors.count)] formats=\(diag.formats.joined(separator: " | "))"
        NSLog("[CameraEngine][ApertureDiag] %@", summary as NSString)
      }
      if apertureMode == .fixed {
        let fixedAperture = controller.currentAperture(device)
        caps["minAperture"] = Double(fixedAperture)
        caps["maxAperture"] = Double(fixedAperture)
        caps["supportedApertures"] = NSNull()
      }
      #if DEBUG || CAMERA18_TESTING
      if controller.mockOverride == .variable {
        // Mock Variable uses the PROJECT-DEFINED iPhone 18 Pro range (recorded in this
        // repo: f/1.48-f/4). No hardware APIs are called.
        caps["minAperture"] = 1.48
        caps["maxAperture"] = 4.0
        caps["supportedApertures"] = NSNull()
        print("[CameraEngine][Diag] MOCK variable aperture active: range f/1.48-f/4")
      }
      #endif

      caps["supportsRAW"] = rawSupported
      caps["supportsProRAW"] = proRaw

      completion(.success(caps))
    }
  }

  private func requestCamera(completion: @escaping (Bool) -> Void) {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: completion(true)
    case .notDetermined: AVCaptureDevice.requestAccess(for: .video, completionHandler: completion)
    default: completion(false)
    }
  }

  /// Frames are delivered rotated by connection.videoOrientation, but focus/exposure points
  /// of interest expect coordinates in the sensor's natural (portrait) space — rotate the
  /// orientation-space point back by the inverse of the applied orientation.
  fileprivate static func naturalPoint(normalX x: CGFloat, normalY y: CGFloat, orientation: AVCaptureVideoOrientation) -> CGPoint {
    switch orientation {
    case .portrait: return CGPoint(x: x, y: y)
    case .portraitUpsideDown: return CGPoint(x: 1 - x, y: 1 - y)
    case .landscapeLeft: return CGPoint(x: 1 - y, y: x)
    case .landscapeRight: return CGPoint(x: y, y: 1 - x)
    @unknown default: return CGPoint(x: x, y: y)
    }
  }
}

// MARK: - AVCaptureSessionControlsDelegate (Camera Control activation)
extension CameraEngineView: AVCaptureSessionControlsDelegate {
  public func sessionControlsDidBecomeActive(_ session: AVCaptureSession) {}
  public func sessionControlsDidBecomeInactive(_ session: AVCaptureSession) {}
  public func sessionControlsWillEnterFullscreenAppearance(_ session: AVCaptureSession) {}
  public func sessionControlsWillExitFullscreenAppearance(_ session: AVCaptureSession) {}
}

// MARK: - WYSIWYG Preview Frame Pipeline
/// AVCaptureVideoDataOutput → CIImage → PreviewNormalizer (compiled) → MTKView.
/// One shared renderer with the capture path; no React Native–side per-frame work.
extension CameraEngineView: AVCaptureVideoDataOutputSampleBufferDelegate {
  public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    var image = CIImage(cvPixelBuffer: pixelBuffer)
    // Cap the preview work at the display's needs: with the .photo preset the feed
    // arrives at full sensor resolution (4032×3024), and every CI stage after this
    // point is priced by the DAG's output bounds — scale at the head, pay preview
    // prices. (The old kCVPixelBufferWidth/Height videoSettings hints never worked.)
    let previewCap: CGFloat = 1280
    let sourceExtent = image.extent
    let longest = max(sourceExtent.width, sourceExtent.height)
    if longest > previewCap {
      let downscale = previewCap / longest
      image = image.transformed(by: CGAffineTransform(scaleX: downscale, y: downscale))
    }
    if let compiled = compiledSnapshot(.videoFrame) {
      image = CameraDNARenderer.apply(compiled, to: image)
    }
    image = image.cropped(to: image.extent.integral)
    guard image.extent.width > 0, image.extent.height > 0 else { return }

    if previewView != nil {
      // HOLD 期间返回 false（帧被丢弃，旧画面保持）：第一个被接受的新镜头帧 = 输入切换
      // 完成，解除 capture 的切换禁窗（spec §5）。
      let accepted = previewRenderer.enqueue(image)
      if accepted, lensSwitching {
        lensSwitching = false
      }
    } else {
      // No-Metal fallback: push a CGImage into the plain layer.
      guard let cgImage = CameraEngineGPU.ciContext.createCGImage(image, from: image.extent) else { return }
      DispatchQueue.main.async { [self] in
        renderLayer.contents = cgImage
      }
      if lensSwitching {
        lensSwitching = false
      }
    }
  }
}

// MARK: - Color/Tone WYSIWYG Preview Display (MTKView, no custom Metal shader)
// Grain/halation/detail stages apply ONLY to the final photo — the preview is honest
// about sharing the Color/Tone pipeline, not the full pixel pipeline.
/// Core Image renders the latest filtered frame straight into the drawable texture.
private final class PreviewRenderer: NSObject, MTKViewDelegate {
  // MTKView does not expose a command queue; the renderer owns one on the shared device.
  // Optional only because the property initializes before the Metal-availability check —
  // draw() is reached solely through the MTKView path, which implies a device exists.
  private let commandQueue: MTLCommandQueue?
  private let lock = NSLock()
  private var pendingImage: CIImage?
  private var currentExtentStorage = CGRect.zero
  // PHYSICAL LENS CROSSFADE (spec §5): HOLD freezes the last OLD-lens frame (incoming
  // frames are dropped, the drawable simply keeps showing the held image) while the
  // session rewires; FADE blends the new lens's feed over that held frame across
  // ~150ms. Preview-only cosmetics — capture bytes and the photo pipeline are untouched.
  private enum Phase { case idle, hold, fade }
  private var phase: Phase = .idle
  private var heldImage: CIImage?
  // Most recent displayed frame — draw() consumes pendingImage, so hold needs this
  // separate copy to guarantee a real crossfade (nil held = degenerate hard cut).
  private var latestImage: CIImage?
  private var fadeStartStorage: CFTimeInterval?
  private static let fadeDuration: CFTimeInterval = 0.15

  override init() {
    self.commandQueue = CameraEngineGPU.metalDevice?.makeCommandQueue()
    super.init()
  }

  /// Extent of the most recently enqueued frame (letterbox mapping input).
  var currentExtent: CGRect {
    lock.lock(); defer { lock.unlock() }
    return currentExtentStorage
  }

  /// Enqueue a frame. Returns FALSE while HOLDING (frame dropped — the old-lens frame
  /// stays on screen), TRUE when the frame will be displayed. The view uses this to
  /// clear its lens-switch capture embargo on the first NEW-lens frame.
  @discardableResult
  func enqueue(_ image: CIImage) -> Bool {
    lock.lock()
    if phase == .hold {
      lock.unlock()
      return false
    }
    pendingImage = image
    latestImage = image
    currentExtentStorage = image.extent
    lock.unlock()
    return true
  }

  /// Freeze on the most recent frame (call BEFORE the input reconfiguration starts).
  func beginHold() {
    lock.lock()
    heldImage = pendingImage ?? latestImage
    phase = .hold
    fadeStartStorage = nil
    lock.unlock()
  }

  /// The new input is live: on its first drawn frame, start the 150ms crossfade.
  func beginFade() {
    lock.lock()
    phase = .fade
    fadeStartStorage = nil
    lock.unlock()
  }

  /// Abort any transition (input-swap failure paths) — back to the live feed.
  func endTransition() {
    lock.lock()
    phase = .idle
    heldImage = nil
    fadeStartStorage = nil
    lock.unlock()
  }

  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

  func draw(in view: MTKView) {
    lock.lock()
    let image = pendingImage
    pendingImage = nil
    let currentPhase = phase
    if currentPhase == .fade, fadeStartStorage == nil, image != nil {
      fadeStartStorage = CACurrentMediaTime()
    }
    let held = heldImage
    var fadeT: Double = 1
    if currentPhase == .fade {
      let start = fadeStartStorage ?? CACurrentMediaTime()
      fadeT = min(1, (CACurrentMediaTime() - start) / Self.fadeDuration)
      if fadeT >= 1 {
        phase = .idle
        heldImage = nil
        fadeStartStorage = nil
      }
    }
    lock.unlock()

    guard let image = image,
          let drawable = view.currentDrawable,
          let commandBuffer = commandQueue?.makeCommandBuffer() else { return }

    let drawableSize = view.drawableSize
    guard drawableSize.width > 1, drawableSize.height > 1 else { return }

    // Letterbox a frame inside the drawable (aspect-fit), matching the capture.
    func fittedFrame(_ source: CIImage) -> CIImage {
      let extent = source.extent
      let scale = min(drawableSize.width / extent.width, drawableSize.height / extent.height)
      return source
        .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        .transformed(by: CGAffineTransform(
          translationX: (drawableSize.width - extent.width * scale) / 2,
          y: (drawableSize.height - extent.height * scale) / 2))
    }
    let fitted = fittedFrame(image)
    // Repaint EVERY drawable pixel each frame: Core Image writes only where the image
    // lands, so the aspect-fit bars kept the PREVIOUS frame's pixels. After an
    // orientation switch the frame's aspect changes and the viewfinder literally showed
    // the old portrait frame and the new landscape frame superimposed (device report,
    // build 44). Compositing over an opaque black backdrop covers the full drawable —
    // the bars render as honest black, like the system camera.
    let backdrop = CIImage(color: CIColor.black)
      .cropped(to: CGRect(origin: .zero, size: drawableSize))
    var frame = fitted.composited(over: backdrop)
    // CROSSFADE: the new lens's feed fades in OVER the held old-lens frame (alpha
    // modulated via CIColorMatrix's A-vector), so a physical input swap never reads
    // as a black flash or a hard cut.
    if currentPhase == .fade, fadeT < 1, let held {
      let base = fittedFrame(held).composited(over: backdrop)
      let overlay = fitted.applyingFilter("CIColorMatrix", parameters: [
        "inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(fadeT)),
      ])
      frame = overlay.composited(over: base)
    }

    CameraEngineGPU.ciContext.render(
      frame,
      to: drawable.texture,
      commandBuffer: commandBuffer,
      bounds: CGRect(origin: .zero, size: drawableSize),
      colorSpace: CameraEngineGPU.sRGBColorSpace,
    )
    commandBuffer.present(drawable)
    commandBuffer.commit()
  }
}

// MARK: - .cube LUT Loader (Camera18_LUT_V0 pack, bundled as CameraEngineLUTs)
private enum LUTLoader {
  private static let lock = NSLock()
  private static var cache: [String: (dimension: Int, data: Data)] = [:]
  /// LRU order (oldest first). A parsed 33³ cube is ~0.6 MB; the calibration library
  /// ships 57 cubes, so an uncapped cache accumulated ~35 MB of native memory forever
  /// once profiles started referencing more of the library. 8 slots hold every active
  /// profile plus quick switch neighbors with room to spare.
  private static var cacheOrder: [String] = []
  private static let cacheLimit = 8
  private static var loggedMissing: Set<String> = []

  static func load(_ rawName: String?) -> (dimension: Int, data: Data)? {
    guard let name = rawName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
    lock.lock(); defer { lock.unlock() }
    if let hit = cache[name] {
      touch(name)
      return hit
    }
    guard let parsed = parseBundleLUT(named: name) else {
      // 静默跳过 LUT 会让"新相机没有效果"无从排查（典型原因：JS 列表热更新了、原生 LUT bundle 还是旧构建的）。
      // 每个名字只报一次，避免逐帧刷日志。
      if !loggedMissing.contains(name) {
        loggedMissing.insert(name)
        print("[CameraEngine] LUTLoader: missing/unparseable cube '\(name)' — LUT stage skipped (stale native bundle?)")
      }
      return nil
    }
    cache[name] = parsed
    touch(name)
    while cacheOrder.count > cacheLimit, let oldest = cacheOrder.first {
      cacheOrder.removeFirst()
      cache.removeValue(forKey: oldest)
    }
    return parsed
  }

  private static func touch(_ name: String) {
    cacheOrder.removeAll { $0 == name }
    cacheOrder.append(name)
  }

  private static func bundleResourceURL(named name: String) -> URL? {
    let base = name.hasSuffix(".cube") ? String(name.dropLast(5)) : name
    let moduleBundle = Bundle(for: CameraEngineView.self)
    if let url = moduleBundle.url(forResource: base, withExtension: "cube") { return url }
    // resource_bundles packaging: CameraEngineLUTs.bundle next to the module.
    if let subURL = moduleBundle.url(forResource: "CameraEngineLUTs", withExtension: "bundle"),
       let lutBundle = Bundle(url: subURL) {
      return lutBundle.url(forResource: base, withExtension: "cube")
    }
    // Static-framework packaging: resources land in the main app bundle.
    return Bundle.main.url(forResource: base, withExtension: "cube")
  }

  private static func parseBundleLUT(named name: String) -> (dimension: Int, data: Data)? {
    guard let url = bundleResourceURL(named: name),
          let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    var dimension = 0
    var values: [Float] = []
    for rawLine in text.split(whereSeparator: { $0 == "\n" || $0 == "\r\n" }) {
      let line = rawLine.trimmingCharacters(in: .whitespaces)
      if line.isEmpty || line.hasPrefix("#") { continue }
      if line.hasPrefix("LUT_3D_SIZE") {
        dimension = Int(line.dropFirst("LUT_3D_SIZE".count).trimmingCharacters(in: .whitespaces)) ?? 0
        continue
      }
      if line.hasPrefix("TITLE") || line.hasPrefix("DOMAIN_") || line.hasPrefix("LUT_1D_SIZE") { continue }
      let parts = line.split(separator: " ")
      guard parts.count >= 3, let r = Float(parts[0]), let g = Float(parts[1]), let b = Float(parts[2]) else { continue }
      // CIColorCube requires FOUR floats (RGBA, premultiplied) per entry — a 3-float RGB
      // buffer makes the whole LUT stage silently no-op (every camera's LUT dead since
      // v1; hueBandCube already did this correctly). .cube lines are RGB, alpha = 1.
      values.append(contentsOf: [r, g, b, 1])
    }
    guard dimension >= 2, values.count == dimension * dimension * dimension * 4 else { return nil }
    return (dimension, Data(bytes: values, count: values.count * MemoryLayout<Float>.size))
  }
}

// MARK: - Temp File Management
private enum CameraTempFiles {
  private static let lock = NSLock()
  private static var current: Set<URL> = []

  static func makeThumbURL() -> URL {
    return FileManager.default.temporaryDirectory
      .appendingPathComponent("camera-engine-thumb-\(UUID().uuidString).jpg")
  }

  /// Full-resolution final photo; the extension ALWAYS matches the actual codec
  /// (heif | jpg) so PhotoKit never has to sniff.
  static func makeFinalURL(pathExtension: String) -> URL {
    return FileManager.default.temporaryDirectory
      .appendingPathComponent("camera-engine-\(UUID().uuidString).\(pathExtension)")
  }

  /// Track the newest displayed generation and delete only the generation it replaces, so the
  /// thumbnail currently shown in the UI never loses its file while a new capture is in flight.
  static func keep(_ urls: [URL]) {
    lock.lock(); let stale = current; current = Set(urls); lock.unlock()
    remove(Array(stale.subtracting(urls)))
  }
  /// Register files at CREATION time — always before the first byte is written. A capture
  /// that starts while a previous photo is still mid-pipeline runs removeUntrackedFiles(),
  /// which would otherwise delete the in-flight files: their keep() only lands after the
  /// PhotoKit save succeeds, seconds later. Tracked-but-failed URLs are harmless — the
  /// next successful keep() replaces the whole set.
  static func track(_ urls: [URL]) {
    lock.lock(); current.formUnion(urls); lock.unlock()
  }
  static func remove(_ urls: [URL]) { urls.forEach { try? FileManager.default.removeItem(at: $0) } }
  static func removeUntrackedFiles() {
    lock.lock(); let kept = current; lock.unlock()
    let files = (try? FileManager.default.contentsOfDirectory(at: FileManager.default.temporaryDirectory, includingPropertiesForKeys: nil)) ?? []
    remove(files.filter { $0.lastPathComponent.hasPrefix("camera-engine-") && !kept.contains($0) })
  }

  /// Latest-shot thumbnail persistence (user request: the library chip must survive app
  /// restarts). Copies the thumbnail to a STABLE Documents path; temp files die with the
  /// sandbox cache cleaner, which made the chip vanish between launches.
  static func persistedLatestThumbnailPath() -> URL {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    return docs.appendingPathComponent("camera18-latest-thumb.jpg")
  }
  static func persistLatestThumbnail(from url: URL) -> URL? {
    let destination = persistedLatestThumbnailPath()
    try? FileManager.default.removeItem(at: destination)
    do {
      try FileManager.default.copyItem(at: url, to: destination)
      return destination
    } catch {
      return nil
    }
  }
}

// MARK: - Camera Control probe (iPhone side button) — enumerate the REAL public surface
/// The Camera Control integration surface is discovered through the ObjC runtime instead
/// of being statically linked: `class_copyMethodList` enumerates every method the
/// INSTALLED OS actually exposes on the capture classes whose name mentions "camera
/// control" (instance methods AND class methods). No API name is guessed anywhere — what
/// ships on the device is what this reports. The result lands in getDiagnostics, so when
/// an iPhone 18 Pro is in hand the shutter wiring (and, if a custom-control hook exists,
/// the preferred real-aperture control) connects to whatever the runtime truly offers.
private enum CameraControlProbe {
  static func exposedMethods() -> [String] {
    let classes: [AnyClass] = [AVCaptureSession.self, AVCaptureDevice.self, AVCapturePhotoOutput.self, UIApplication.self]
    var found: Set<String> = []
    for cls in classes {
      // Instance methods…
      if let list = methodList(for: cls) { found.formUnion(list) }
      // …and class (metaclass) methods.
      if let meta = object_getClass(cls), let list = methodList(for: meta) {
        found.formUnion(list.map { "+\($0)" })
      }
    }
    return found.sorted()
  }

  private static func methodList(for cls: AnyClass) -> [String]? {
    var count: UInt32 = 0
    guard let methods = class_copyMethodList(cls, &count) else { return nil }
    defer { free(methods) }
    var names: [String] = []
    let className = NSStringFromClass(cls)
    for i in 0..<Int(count) {
      let name = NSStringFromSelector(method_getName(methods[i]))
      if name.lowercased().contains("cameracontrol") {
        names.append("\(className) \(name)")
      }
    }
    return names
  }
}

// MARK: - Photo Capture Delegate (Apple Processed Photo → LUT → Tone → HEIF)
/// TWO settle channels (shutter-response decoupling, spec §6):
///  - onCaptured: fires at didFinishProcessingPhoto — Apple's capture is DONE, the full
///    photo exists. The JS shutter promise settles HERE; Camera DNA / HEIF / PhotoKit
///    must never gate the shutter UI.
///  - onProcessed: fires after the background pipeline (+ PhotoKit save) finishes —
///    delivered to JS as the `onPhotoProcessed` event (thumbnail/URI/error reporting).
/// ORIG (compiled == nil) bypasses Camera DNA entirely: fileDataRepresentation bytes
/// are written VERBATIM (metadata/attachments preserved) and saved as-is.
private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
  private static let processingQueue = DispatchQueue(label: "camera-engine.photo-processing", qos: .userInitiated)
  // ponytail: static shared CIContext avoids allocating GPU command queue/shader cache per shutter press
  private static let sharedContext = CameraEngineGPU.ciContext
  private let compiled: CameraDNARenderer.CompiledCameraProfile?
  private let onCaptured: (Result<Void, CameraEngineError>) -> Void
  private let onProcessed: (Result<[String: Any], CameraEngineError>, String?) -> Void
  private let completionLock = NSLock()
  private var didComplete = false
  private var didCaptureSettle = false
  private var generatedURLs: [URL] = []
  /// Zoom ACTUALLY applied to the device at shutter time, and its 35mm-equivalent focal
  /// (from the JS focal ladder's current FocalStop) — stamped into EXIF so crop-zoomed
  /// shots read correctly in Photos.
  private let appliedZoom: Double
  private let equivalentFocalMM: Int
  /// Aperture ACTUALLY engaged at shutter time (variable iris). Apple's photo EXIF
  /// stamps the LENS NOMINAL figure (FNumber = lensAperture = ƒ/1.48) regardless of
  /// setExposureModeCustom(lensAperture:) — no API promise to the contrary (checked
  /// against the iOS 27 AVCapturePhoto/setExposureModeCustom docs). Overwritten with
  /// this reading below so Photos shows the f-stop the photo was really taken at.
  private let apertureAtShutter: Double
  init(compiled: CameraDNARenderer.CompiledCameraProfile?, appliedZoom: Double, equivalentFocalMM: Int, apertureAtShutter: Double, onCaptured: @escaping (Result<Void, CameraEngineError>) -> Void, onProcessed: @escaping (Result<[String: Any], CameraEngineError>, String?) -> Void) {
    self.compiled = compiled
    self.appliedZoom = appliedZoom
    self.equivalentFocalMM = equivalentFocalMM
    self.apertureAtShutter = apertureAtShutter
    self.onCaptured = onCaptured
    self.onProcessed = onProcessed
  }

  /// Settles the CAPTURE half exactly once (didFinishProcessingPhoto / error paths).
  private func settleCaptured(_ result: Result<Void, CameraEngineError>) {
    completionLock.lock()
    guard !didCaptureSettle else { completionLock.unlock(); return }
    didCaptureSettle = true
    completionLock.unlock()
    DispatchQueue.main.async { self.onCaptured(result) }
  }

  func photoOutput(_ output: AVCapturePhotoOutput, willBeginCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings) {
    // Shutter click at the moment of exposure — the SYSTEM camera shutter sound (1108).
    // AudioServices routes it through the system audio path, so it automatically follows
    // the ringer/silent switch and system volume, exactly like the built-in Camera app.
    AudioServicesPlaySystemSound(1108)
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    // BASE-QUALITY DIAG: capture-resolution + exposure truth for the delivered photo.
    // ISO/exposure come from the EXIF block — AVCaptureResolvedPhotoSettings carries no
    // ISO member.
    let exif = photo.metadata["{Exif}"] as? [String: Any]
    let iso = (exif?["ISOSpeedRatings"] as? [NSNumber])?.first?.doubleValue ?? 0
    let exposureSeconds = exif?["ExposureTime"] as? Double ?? 0
    if #available(iOS 16.0, *) {
      let rs = photo.resolvedSettings
      print("[CameraEngine][Diag] photoDimensions=\(rs.photoDimensions.width)x\(rs.photoDimensions.height) previewDimensions=\(rs.previewDimensions.width)x\(rs.previewDimensions.height) ISO=\(Int(iso)) exposure=1/\(Int(1.0 / max(exposureSeconds, 0.0001)))s")
    }

    guard error == nil, let photoData = photo.fileDataRepresentation() else {
      settleCaptured(.failure(.captureFailed))
      finish(.failure(.captureFailed))
      return
    }
    // Apple capture is COMPLETE — free the shutter UI; heavy work continues below.
    settleCaptured(.success(()))
    processCapturedData(photoData, metadata: photo.metadata)
  }

  /// Capture pipeline dispatch. compiled == nil (ORIG passthrough / no profile yet) →
  /// the Apple photo bytes are written VERBATIM; any other profile → Camera DNA.
  private func processCapturedData(_ photoData: Data, metadata: [AnyHashable: Any]) {
    guard let compiled else {
      processPassthrough(photoData)
      return
    }
    processWithCameraDNA(photoData, metadata: metadata, compiled: compiled)
  }

  /// ORIG TRUE PASSTHOUGH (spec §4): AVCapturePhoto → fileDataRepresentation → write
  /// bytes → PhotoKit. NO CIImage decode, NO Camera DNA/tone/grain, NO second encode —
  /// the file on disk IS Apple's processed photo bit-for-bit, with its original
  /// metadata/attachments intact.
  private func processPassthrough(_ photoData: Data) {
    Self.processingQueue.async { [self] in
      guard !hasCompleted else { return }
      let fileURL = CameraTempFiles.makeFinalURL(pathExtension: "jpg")
      CameraTempFiles.track([fileURL])
      completionLock.lock(); generatedURLs = [fileURL]; completionLock.unlock()
      do {
        try photoData.write(to: fileURL, options: .atomic)
      } catch {
        finish(.failure(.processingFailed))
        return
      }
      print("[CameraEngine][Diag] passthrough export bytes=\(photoData.count) (no Camera DNA, no re-encode)")
      // Thumbnail for the in-app chip only — decode-SMALL via ImageIO (never a full
      // 24MP decode), transform-applied so the chip matches the upright bytes.
      let thumbURL = CameraTempFiles.makeThumbURL()
      CameraTempFiles.track([thumbURL])
      var thumbOK = false
      if let source = CGImageSourceCreateWithData(photoData as CFData, nil) {
        let thumbOptions: [CFString: Any] = [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 512,
        ]
        if let thumbCG = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary) {
          let out = NSMutableData()
          if let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) {
            CGImageDestinationAddImage(dest, thumbCG, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
            if CGImageDestinationFinalize(dest) {
              do { try out.write(to: thumbURL, options: .atomic); thumbOK = true } catch { thumbOK = false }
            }
          }
        }
      }
      guard thumbOK else {
        // The chip is cosmetic — a thumbnail failure must not lose the photo.
        print("[CameraEngine][Diag] passthrough thumbnail failed; finishing without chip")
        finish(.success([
          "fileUri": fileURL.absoluteString,
          "thumbnailUri": NSNull(),
          "assetLocalIdentifier": NSNull(),
          "appliedZoom": appliedZoom,
          "equivalentFocal": equivalentFocalMM,
          "codec": "jpeg",
        ]))
        return
      }
      finishAfterPhotoKitSave(fileURL: fileURL, thumbURL: thumbURL, codec: "jpeg")
    }
  }

  /// PRODUCTION PIPELINE — one decode, one render, one encode, full resolution end to end:
  ///   Apple processed photo (Data) → CIImage → LUT cube (LUT + fine color) → Tone → HEIF.
  /// Runs exactly once per capture (guarded by hasCompleted inside finish).
  private func processWithCameraDNA(_ photoData: Data, metadata: [AnyHashable: Any], compiled: CameraDNARenderer.CompiledCameraProfile) {
    Self.processingQueue.async { [self] in
      guard !hasCompleted else { return }

      guard let source = CIImage(data: photoData, options: [.applyOrientationProperty: true]) else {
        finish(.failure(.captureFailed))
        return
      }
      let inputExtent = source.extent.integral
      print("[CameraEngine][Diag] pipeline input extent=\(Int(inputExtent.width))x\(Int(inputExtent.height))")

      // Compiled final pipeline (processed-photo normalizer + LUT + fine color + tone
      // + final-only deharsh). The preview path calls apply() WITHOUT finalPhoto.
      var image = source
      image = CameraDNARenderer.apply(compiled, to: image, finalPhoto: true)
      print("[CameraEngine][Diag] after LUT+color extent=\(Int(image.extent.width))x\(Int(image.extent.height))")

      let extent = image.extent.integral
      guard !extent.isNull, !extent.isInfinite, extent.width > 0, extent.height > 0,
            let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
        finish(.failure(.processingFailed))
        return
      }

      image = image.cropped(to: extent)
      print("[CameraEngine][Diag] after tone/export extent=\(Int(extent.width))x\(Int(extent.height))")

      // RESOLUTION ASSERTION: the final pipeline must never shrink the photo. A mismatch
      // means someone introduced a resize — trap in debug builds, log in release.
      if abs(extent.width - inputExtent.width) >= 2 || abs(extent.height - inputExtent.height) >= 2 {
        print("[CameraEngine][Diag] RESOLUTION REGRESSION: export=\(Int(extent.width))x\(Int(extent.height)) input=\(Int(inputExtent.width))x\(Int(inputExtent.height))")
        assert(false, "Camera18 final pipeline changed resolution")
      }

      let context = Self.sharedContext

      // FINAL ENCODING — HEIF first (user directive): HEIF keeps the same pixels at a
      // much smaller file and avoids re-compressing the Apple photo through a second
      // lossy JPEG generation. JPEG (0.95) remains the fallback if HEIF encoding is
      // unavailable. The saved file extension always matches the actual codec.
      let thumbURL = CameraTempFiles.makeThumbURL()
      let heifData = Self.encodedRepresentation(
        image,
        metadata: metadata,
        colorSpace: colorSpace,
        quality: 0.95,
        equivalentFocalMM: equivalentFocalMM,
        apertureAtShutter: apertureAtShutter,
        type: "public.heif" as CFString,
      )
      let fileURL: URL
      let encoded: Data
      let codec: String
      if let heifData {
        fileURL = CameraTempFiles.makeFinalURL(pathExtension: "heif")
        encoded = heifData
        codec = "heif"
      } else {
        guard let jpeg = Self.encodedRepresentation(
          image,
          metadata: metadata,
          colorSpace: colorSpace,
          quality: 0.95,
          equivalentFocalMM: equivalentFocalMM,
          apertureAtShutter: apertureAtShutter,
          type: "public.jpeg" as CFString,
        ) else {
          finish(.failure(.processingFailed))
          return
        }
        fileURL = CameraTempFiles.makeFinalURL(pathExtension: "jpg")
        encoded = jpeg
        codec = "jpeg"
      }
      completionLock.lock(); generatedURLs = [fileURL, thumbURL]; completionLock.unlock()
      CameraTempFiles.track([fileURL, thumbURL])

      do {
        print("[CameraEngine][Diag] export dims=\(extent.width)x\(extent.height) codec=\(codec) bytes=\(encoded.count) quality=0.95")
        try encoded.write(to: fileURL, options: .atomic)
        let scale = min(CGFloat(1), CGFloat(512) / max(extent.width, extent.height))
        let thumb = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let thumbData = context.jpegRepresentation(of: thumb, colorSpace: colorSpace, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.8]) else {
          throw CameraEngineError.processingFailed
        }
        try thumbData.write(to: thumbURL, options: .atomic)
      } catch {
        finish(.failure(.processingFailed))
        return
      }

      finishAfterPhotoKitSave(fileURL: fileURL, thumbURL: thumbURL, codec: codec)
    }
  }

  /// Shared tail for BOTH pipelines (Camera DNA + passthrough): add-only PhotoKit save,
  /// then finish(success payload). The thumbnail the UI displays must survive restarts —
  /// serve the Documents copy when persistence succeeds, fall back to the temp file.
  private func finishAfterPhotoKitSave(fileURL: URL, thumbURL: URL, codec: String) {
    guard !hasCompleted else {
      CameraTempFiles.remove([fileURL, thumbURL])
      return
    }
    requestPhotoLibraryAddAuthorization { granted, permissionDetail in
      guard granted else {
        self.finish(.failure(.photoPermissionDenied), detail: "photo saving blocked: \(permissionDetail)")
        return
      }
      guard !self.hasCompleted else { return }
      var localIdentifier: String?
      PHPhotoLibrary.shared().performChanges({
        let request = PHAssetCreationRequest.forAsset()
        request.addResource(with: .photo, fileURL: fileURL, options: nil)
        localIdentifier = request.placeholderForCreatedAsset?.localIdentifier
      }) { success, error in
        guard success else {
          // Never swallow the PhotoKit reason — it is the only way to tell quota,
          // permission, and storage failures apart from the diag log.
          self.finish(
            .failure(.saveFailed),
            detail: "PhotoKit save failed: \(error?.localizedDescription ?? "unknown error (no NSError)")"
          )
          return
        }
        CameraTempFiles.keep([fileURL, thumbURL])
        let thumbnailURI = CameraTempFiles.persistLatestThumbnail(from: thumbURL)?.absoluteString
          ?? thumbURL.absoluteString
        self.finish(.success([
          "fileUri": fileURL.absoluteString,
          "thumbnailUri": thumbnailURI,
          "assetLocalIdentifier": localIdentifier ?? NSNull(),
          "appliedZoom": self.appliedZoom,
          "equivalentFocal": self.equivalentFocalMM,
          "codec": codec,
        ]))
      }
    }
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
    // didFinishProcessingPhoto owns both outcomes (settleCaptured for the shutter
    // promise at capture-complete; finish → onProcessed event after the pipeline).
    // This callback only acts as the never-arrived safety net so the JS promise
    // cannot hang forever (shutter stuck disabled).
    if error != nil {
      settleCaptured(.failure(.captureFailed))
      finish(.failure(.captureFailed))
    }
  }

  private var hasCompleted: Bool {
    completionLock.lock(); defer { completionLock.unlock() }; return didComplete
  }

  // Rendered pixels are already upright, so the original orientation tag is replaced with "1"
  // while every other real capture property (EXIF exposure data, timestamps, lens info) is
  // carried over untouched. CIContext.jpegRepresentation would drop all of it. The native
  // lens focal in that metadata ignores crop zoom, so FocalLengthIn35mmFilm is overwritten
  // with base×zoom — what the Photos app displays as the shot's focal length.
  private static func encodedRepresentation(_ image: CIImage, metadata: [AnyHashable: Any]?, colorSpace: CGColorSpace, quality: Double, equivalentFocalMM: Int, apertureAtShutter: Double, type: CFString) -> Data? {
    guard let cgImage = sharedContext.createCGImage(image, from: image.extent, format: CIFormat.RGBA8, colorSpace: colorSpace) else { return nil }
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, type, 1, nil) else { return nil }

    var properties = cfProperties(metadata)
    properties[kCGImageDestinationLossyCompressionQuality] = quality
    properties[kCGImagePropertyOrientation] = 1
    var exif = cfProperties(properties[kCGImagePropertyExifDictionary])
    exif.removeValue(forKey: kCGImagePropertyExifPixelXDimension)
    exif.removeValue(forKey: kCGImagePropertyExifPixelYDimension)
    if equivalentFocalMM > 0 {
      // ImageIO exposes no Swift-importable constant for this EXIF key (same class as the
      // 'Orientation' literal below — run 35): the key literally is "FocalLengthIn35mmFilm".
      exif["FocalLengthIn35mmFilm" as CFString] = equivalentFocalMM
    }
    // FNumber truth: Apple's capture EXIF carries the LENS NOMINAL aperture (always
    // ƒ/1.48 on the iPhone 18 Pro main) and never reflects the variable iris stop the
    // photo was actually taken at — stamp the shutter-time reading instead. Same
    // no-importable-constant class as the focal key; the literal is "FNumber".
    if apertureAtShutter > 0.5 && apertureAtShutter < 32 {
      // Plausibility band (ƒ/0.5–ƒ/32): a sentinel/garbage reading never reaches EXIF.
      exif["FNumber" as CFString] = (apertureAtShutter * 100).rounded() / 100
    }
    // The rendered pixels are ALREADY upright (orientation applied during CIImage decode),
    // but the carried-over EXIF block still says "rotated" — Photos honors that tag and
    // displays landscape shots as portrait. Pin the EXIF orientation to 1. (ImageIO has no
    // named constant for the EXIF-dictionary orientation key; it is literally "Orientation".)
    exif["Orientation" as CFString] = 1
    properties[kCGImagePropertyExifDictionary] = exif
    var tiff = cfProperties(properties[kCGImagePropertyTIFFDictionary])
    tiff[kCGImagePropertyTIFFOrientation] = 1
    properties[kCGImagePropertyTIFFDictionary] = tiff

    CGImageDestinationAddImage(destination, cgImage, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return output as Data
  }

  private static func cfProperties(_ value: Any?) -> [CFString: Any] {
    guard let dict = value as? [AnyHashable: Any] else { return [:] }
    var result: [CFString: Any] = [:]
    for (key, item) in dict {
      // Cast through String: a conditional downcast straight to the CF type is a hard error
      // under Swift 6, and String bridges to CFString unconditionally.
      if let stringKey = key as? String { result[stringKey as CFString] = item }
    }
    return result
  }

  private func requestPhotoLibraryAddAuthorization(completion: @escaping (Bool, String) -> Void) {
    let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
    if status == .notDetermined {
      PHPhotoLibrary.requestAuthorization(for: .addOnly) {
        let granted = $0 == .authorized || $0 == .limited
        completion(granted, "permission requested → \(granted ? "granted" : "denied")")
      }
    } else {
      let granted = status == .authorized || status == .limited
      let why = granted ? "granted" : (status == .restricted ? "restricted" : "denied")
      completion(granted, "add-only photo permission already \(why)")
    }
  }

  private func finish(_ result: Result<[String: Any], CameraEngineError>, detail: String? = nil) {
    completionLock.lock()
    guard !didComplete else { completionLock.unlock(); return }
    didComplete = true
    let urls = generatedURLs
    completionLock.unlock()
    if case .failure = result { CameraTempFiles.remove(urls) }
    DispatchQueue.main.async { self.onProcessed(result, detail) }
  }
}

// MARK: - Input Normalizer Registry (architecture v2)
/// Maps each input family's TECHNICAL deviations (gray level, white point, base
/// saturation/response, light base-tone differences) onto one shared target:
/// `camera18-neutral-v1`. STRICTLY technology-only — no HDR, no local tone mapping,
/// no sharpening, no NR, no scene recognition, no skin detection, no dynamic style.
///
/// Separation of concerns: normalizers live OUTSIDE camera-profiles.json (a device
/// compensation must never leak into a Camera's artistic identity). The registry reads
/// an optional bundled `camera-input-normalizers.json` (schema: id/source/target/
/// revision/correction) and falls back to the built-in IDENTITY v1 entries. Until real
/// calibration data exists (iPhone 18 Pro / reference charts), every entry is Identity —
/// NO invented compensation values.
enum CameraInputNormalizer {
  enum Source: String {
    case processedPhoto = "processed-photo"
    case videoFrame = "video-frame"
  }

  struct Definition {
    let id: String
    let source: Source
    let target: String
    let revision: Int
    /// Only `identity` is supported today. Future calibration adds e.g. a 33³ correction
    /// cube here; the effective-cube compiler already reserves a fusion hook for it.
    let correctionType: String
  }

  static let neutralTarget = "camera18-neutral-v1"

  private static let lock = NSLock()
  private static var cache: [Source: Definition]?
  private static var surface: [String] = []

  /// Registry lookup. Order: bundled camera-input-normalizers.json (if parseable) →
  /// built-in identity v1. Unknown/unsupported correction types fall back to identity
  /// loudly (never a half-applied correction).
  static func definition(for source: Source) -> Definition {
    lock.lock(); defer { lock.unlock() }
    if cache == nil { load() }
    return cache![source] ?? Definition(
      id: "identity-\(source.rawValue)-v1",
      source: source,
      target: neutralTarget,
      revision: 1,
      correctionType: "identity",
    )
  }

  /// Diagnostic surface: what the registry actually resolved, per input family.
  static func resolvedSummary() -> [String] {
    lock.lock(); defer { lock.unlock() }
    if cache == nil { load() }
    return surface
  }

  private static func load() {
    var definitions: [Source: Definition] = [:]
    var notes: [String] = []
    // Optional JSON override — same resource-bundle search as LUTs.
    for container in [Bundle(for: CameraEngineView.self), Bundle.main] {
      if let url = container.url(forResource: "camera-input-normalizers", withExtension: "json"),
         let data = try? Data(contentsOf: url),
         let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
         let entries = root["normalizers"] as? [[String: Any]] {
        for entry in entries {
          guard
            let id = entry["id"] as? String,
            let sourceRaw = entry["source"] as? String,
            let source = Source(rawValue: sourceRaw),
            let target = entry["target"] as? String,
            target == neutralTarget,
            let revision = (entry["revision"] as? NSNumber)?.intValue
          else { continue }
          let correction = (entry["correction"] as? [String: Any])?["type"] as? String ?? "identity"
          // Only identity is wired today; anything else would need cube-fusion support.
          guard correction == "identity" else {
            notes.append("\(id): correction '\(correction)' unsupported → identity")
            continue
          }
          definitions[source] = Definition(id: id, source: source, target: target, revision: revision, correctionType: correction)
          notes.append("\(id): identity (rev \(revision))")
        }
        break
      }
    }
    for source in [Source.processedPhoto, .videoFrame] where definitions[source] == nil {
      definitions[source] = Definition(
        id: "identity-\(source.rawValue)-v1",
        source: source,
        target: neutralTarget,
        revision: 1,
        correctionType: "identity",
      )
      notes.append("identity-\(source.rawValue)-v1: built-in identity (no JSON entry)")
    }
    cache = definitions
    surface = notes
  }
}

// MARK: - Unified Camera DNA Renderer (v2 — CompiledCameraProfile architecture)
/// Production renderer for preview and final output:
///   Input Normalizer (fused into the cube) → ONE effective 33³ cube → Tone stages.
/// Camera 18 does NOT redo Apple's ISP: no noise reduction, no sharpening, no unsharp
/// mask, no local tone mapping, no grain, no halation, no vignette, no starburst.
///
/// COLOR PIPELINE CONTRACT (fixed; do not introduce per-path divergence):
///   Source decode (CIImage float working space) → Normalizer (fused in cube)
///   → CIColorCubeWithColorSpace with inputColorSpace = sRGB (the LUTs are calibrated
///   in sRGB — preview and final MUST keep this identical) → Tone (CI working space)
///   → FINAL PHOTO ONLY: Deharsh (highlight chroma relief, texture.deharsh; the preview
///   never runs it — Color/Tone WYSIWYG covers the shared stages) → Export sRGB. No
///   implicit per-path color-space differences, no redundant conversions. Precision:
///   Core Image processes in its float working space end to end; quantization to 8-bit
///   happens exactly once, inside the final HEIF/JPEG encode.
private enum CameraDNARenderer {
  /// Bump on ANY change to cube compilation or tone application so stale cached cubes
  /// can never survive a renderer change (cache key includes this).
  static let rendererVersion = 2

  /// Per-frame render state: everything expensive (cube, tone interpretation) is
  /// resolved ONCE at compile time; the frame loop consumes only this struct.
  struct CompiledCameraProfile {
    let effectiveCube: (dimension: Int, data: Data)?
    let exposureEV: Double
    let contrast: Double
    let blackPoint: Double
    let toneCurve: [CIVector]?
    /// FINAL-PHOTO-ONLY highlight chroma relief strength (texture.deharsh, 0..1). The
    /// preview never runs it — Color/Tone WYSIWYG keeps to the shared stages.
    let deharshAmount: Double
    let profileID: String
    let profileRevision: Int
    let normalizerID: String
    let normalizerRevision: Int
    let rendererVersion: Int
    /// True when NOTHING in this profile can alter pixels (identity normalizer +
    /// neutral color + neutral tone). Guaranteed filter-free by construction.
    let isIdentity: Bool
  }

  // ⚠️ TWO hue-band center tables exist DELIBERATELY — do NOT "unify" them:
  //  - bandCenters below (nominal 0/30/60/120/180/240/300): used ONLY by hueBandCube,
  //    the no-LUT fallback cube.
  //  - buildEffectiveCube's local REFINED centers (0/30/57/117/182/230/302): the
  //    LUT-fusion path every shipped profile actually renders through.
  // The values drifted apart during calibration. Merging either into the other CHANGES
  // that path's rendered color — only do it alongside a fresh tone-audit round.
  private static let bandNames = ["red", "orange", "yellow", "green", "cyan", "blue", "magenta"]
  private static let bandCenters: [Double] = [0, 30, 60, 120, 180, 240, 300]

  /// Unified rendering pipeline — consumes ONLY a compiled profile (no JSON per frame).
  /// Source → effective cube (normalizer + LUT + fine color) → Exposure → Contrast →
  /// Black point → Tone curve → [final photo only: Deharsh]. Every stage skips itself
  /// when neutral.
  static func apply(_ compiled: CompiledCameraProfile, to source: CIImage, finalPhoto: Bool = false) -> CIImage {
    var image = source

    if let effective = compiled.effectiveCube {
      image = filter("CIColorCubeWithColorSpace", image, [
        "inputCubeDimension": effective.dimension,
        "inputCubeData": effective.data,
        "inputColorSpace": CameraEngineGPU.sRGBColorSpace,
      ])
    }

    if abs(compiled.exposureEV) > 0.001 {
      image = filter("CIExposureAdjust", image, [kCIInputEVKey: compiled.exposureEV])
    }
    if abs(compiled.contrast - 1.0) > 0.001 {
      image = filter("CIColorControls", image, [kCIInputSaturationKey: 1.0, kCIInputContrastKey: compiled.contrast, kCIInputBrightnessKey: 0.0])
    }
    if compiled.blackPoint > 0 {
      let scale = 1.0 / (1.0 - compiled.blackPoint)
      image = filter("CIColorMatrix", image, [
        "inputRVector": CIVector(x: CGFloat(scale), y: 0, z: 0, w: 0),
        "inputGVector": CIVector(x: 0, y: CGFloat(scale), z: 0, w: 0),
        "inputBVector": CIVector(x: 0, y: 0, z: CGFloat(scale), w: 0),
        "inputBiasVector": CIVector(x: CGFloat(-compiled.blackPoint * scale), y: CGFloat(-compiled.blackPoint * scale), z: CGFloat(-compiled.blackPoint * scale), w: 0)
      ])
    }
    if let points = compiled.toneCurve {
      image = filter("CIToneCurve", image, Dictionary(uniqueKeysWithValues: points.enumerated().map { ("inputPoint\($0.offset)", $0.element) }))
    }

    // DEHARSH (仅成片 stage): highlight chroma relief after the tone curve — the last
    // color-touching stage before export. Sensors clip channel-wise, and the resulting
    // saturation blowout near white is the "harsh" digital look this stage removes:
    // as luma approaches clipping the pixel is pulled toward its own luma. LUMA IS
    // UNTOUCHED (the profile's tone curve owns luminance — no highlight darkening);
    // only chroma eases, weighted by a ramp that stays at 0 through the mids and rises
    // over the highlight shoulder. Stock filters only (AGENTS.md: no custom Metal), and
    // the whole chain self-skips at amount 0 — the deharsh=0 profiles render identically.
    if finalPhoto, compiled.deharshAmount > 0.0005 {
      let amount = compiled.deharshAmount
      let lumaWeights = CIVector(x: 0.2126, y: 0.7152, z: 0.0722, w: 0)
      let luma = filter("CIColorMatrix", image, [
        "inputRVector": lumaWeights, "inputGVector": lumaWeights, "inputBVector": lumaWeights,
      ])
      let mask = filter("CIToneCurve", luma, [
        "inputPoint0": CIVector(x: 0, y: 0),
        "inputPoint1": CIVector(x: 0.30, y: 0),
        "inputPoint2": CIVector(x: 0.55, y: 0.02),
        "inputPoint3": CIVector(x: 0.75, y: 0.45),
        "inputPoint4": CIVector(x: 1, y: 1),
      ])
      let desaturated = filter("CIColorControls", image, [
        kCIInputSaturationKey: CGFloat(max(0.0, 1.0 - amount * 4.0)),
        kCIInputContrastKey: CGFloat(1.0),
        kCIInputBrightnessKey: CGFloat(0.0),
      ])
      // Mask 1 = take the desaturated pixel (highlights), 0 = keep the original.
      image = filter("CIBlendWithMask", desaturated, [
        "inputBackgroundImage": image,
        "inputMaskImage": mask,
      ])
    }

    return image.cropped(to: source.extent)
  }

  /// Identity contract self-check: an identity normalizer on a neutral profile must
  /// compile to cube == nil and tone == skipped (zero filters). Runs in getDiagnostics.
  static func identitySelfCheck() -> String {
    let normalizer = CameraInputNormalizer.definition(for: .processedPhoto)
    let compiled = compile([:], normalizer: normalizer)
    if compiled.effectiveCube != nil { return "FAIL: identity compile produced a color cube" }
    if !compiled.isIdentity { return "FAIL: identity compile is not flagged identity" }
    return "pass"
  }

  private static func dictionary(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }

  // ── Compile + cache (v2) ───────────────────────────────────────────────────────
  // The effective cube fuses, per profile: Input Normalizer → base LUT × lutIntensity →
  // temperature/tint → saturation → 7-band HSL fine trim — into ONE 33³ cube. The cache
  // key is the FULL identity: profile.id + profile.revision + normalizer.id +
  // normalizer.revision + rendererVersion, so any algorithm/normalizer change invalidates
  // stale cubes by construction.
  private struct CompiledKey: Hashable {
    let profileID: String
    let profileRevision: Int
    let normalizerID: String
    let normalizerRevision: Int
    let rendererVersion: Int
  }
  private static var compiledCache: [CompiledKey: CompiledCameraProfile] = [:]
  private static var profileRevisions: [String: Int] = [:]
  /// Last-seen color payload fingerprint per profile id: lets repeated setProfile calls
  /// with an UNCHANGED profile keep the current revision (no rebuild, no cache growth).
  private static var profileColorFingerprints: [String: Int] = [:]
  private static let cubeLock = NSLock()

  /// Bump the revision ONLY when a profile's RENDERED payload actually changed. setProfile
  /// runs on every RN prop application AND through applyProfile — historically twice per
  /// aperture-drag tick, which rebuilt this 33³ cube on the render queue each time and
  /// leaked one ~0.5 MB cache entry per rebuild. Tone is compiled once with the cube and
  /// read from the CompiledCameraProfile afterwards — never from JSON per frame.
  static func invalidateCompiledProfile(_ profile: [String: Any]) {
    guard let id = profile["id"] as? String else { return }
    // Color + tone + texture: the compiled profile carries ALL three (cube, tone stages,
    // final-only deharsh) — a texture-only or tone-only edit (ProfileConfigModal imports)
    // must bump the revision too, or the cache serves the stale compiled stages.
    let fingerprint = colorFingerprint([
      "color": profile["color"] ?? NSNull(),
      "tone": profile["tone"] ?? NSNull(),
      "texture": profile["texture"] ?? NSNull(),
    ])
    cubeLock.lock(); defer { cubeLock.unlock() }
    if let seen = profileColorFingerprints[id], seen == fingerprint { return }
    profileColorFingerprints[id] = fingerprint
    profileRevisions[id, default: 0] += 1
  }

  private static func colorFingerprint(_ color: Any?) -> Int {
    guard let color else { return 0 }
    var hasher = Hasher()
    if let data = try? JSONSerialization.data(withJSONObject: color, options: [.sortedKeys]) {
      hasher.combine(data)
    } else {
      // Unserializable payload: never match a previous fingerprint (forces a rebuild).
      hasher.combine(UUID().uuidString)
    }
    return hasher.finalize()
  }

  /// Compiles (or cache-hits) the per-frame render state for one profile + normalizer.
  static func compile(_ profile: [String: Any], normalizer: CameraInputNormalizer.Definition) -> CompiledCameraProfile {
    let id = (profile["id"] as? String) ?? "anonymous"
    let tone = dictionary(profile["tone"])
    let color = dictionary(profile["color"])

    // Tone interpretation happens HERE, once — never per frame.
    let exposureEV = number(tone, "exposure", 0, -5...5)
    let contrast = number(tone, "contrast", 1, 0...4)
    let blackPoint = number(tone, "blackPoint", 0, 0...0.95)
    let rawCurve = toneCurve(tone["curve"])
    let curve = (rawCurve != nil && !isIdentityToneCurve(rawCurve!)) ? rawCurve : nil
    let toneIsNeutral = abs(exposureEV) <= 0.001 && abs(contrast - 1.0) <= 0.001 && blackPoint <= 0 && curve == nil
    // FINAL-PHOTO-ONLY stage strength (texture.deharsh, 0..1). Absent = 0 = skipped.
    let deharshAmount = number(dictionary(profile["texture"]), "deharsh", 0, 0...1)

    let revision: Int = {
      cubeLock.lock(); defer { cubeLock.unlock() }
      return profileRevisions[id] ?? 0
    }()

    let key = CompiledKey(
      profileID: id,
      profileRevision: revision,
      normalizerID: normalizer.id,
      normalizerRevision: normalizer.revision,
      rendererVersion: rendererVersion,
    )
    cubeLock.lock()
    if let hit = compiledCache[key] { cubeLock.unlock(); return hit }
    cubeLock.unlock()

    // Effective cube: normalizer (identity today) fused ahead of the base LUT inside
    // the SAME single 33³ cube — never a second per-frame cube pass. A profile without
    // a LUT but with non-neutral HSL still compiles via the legacy hue-band cube.
    let effectiveCube: (dimension: Int, data: Data)?
    if let lutName = color["lut"] as? String, let baseLUT = LUTLoader.load(lutName) {
      effectiveCube = buildEffectiveCube(profile: profile, base: baseLUT, normalizer: normalizer)
    } else {
      effectiveCube = hueBandCube(dictionary(color["hueBands"]))
    }

    let compiled = CompiledCameraProfile(
      effectiveCube: effectiveCube,
      exposureEV: exposureEV,
      contrast: contrast,
      blackPoint: blackPoint,
      toneCurve: curve,
      deharshAmount: deharshAmount,
      profileID: id,
      profileRevision: revision,
      normalizerID: normalizer.id,
      normalizerRevision: normalizer.revision,
      rendererVersion: rendererVersion,
      isIdentity: effectiveCube == nil && toneIsNeutral && deharshAmount <= 0.0005
    )

    cubeLock.lock()
    compiledCache[key] = compiled
    // Drop superseded entries: per profile keep only the newest revision (both live
    // normalizer variants of it — preview + final); older revisions are unreachable.
    compiledCache = compiledCache.filter { $0.key.profileID != id || $0.key.profileRevision == revision }
    cubeLock.unlock()
    return compiled
  }

  private static func buildEffectiveCube(profile: [String: Any], base: (dimension: Int, data: Data), normalizer: CameraInputNormalizer.Definition) -> (dimension: Int, data: Data) {
    let color = dictionary(profile["color"])
    let dim = base.dimension
    var values = floatArray(base.data)
    let count = dim * dim * dim

    // 0. INPUT NORMALIZER fusion hook (architecture v2). The normalizer maps the input
    // family's technical deviations onto camera18-neutral-v1 BEFORE the LUT — fused
    // into this same cube (per grid entry: output = profileChain(normalizer(coord))).
    // Identity correction (the only wired type today) is a mathematical no-op here:
    // the compiled cube must be bit-identical to the pre-normalizer architecture, so
    // the six cameras' current visuals are untouched.
    assert(normalizer.correctionType == "identity", "non-identity normalizer corrections need cube-fusion support first")

    // 1. lutIntensity: blend each entry toward its own grid coordinate (the identity
    // mapping), i.e. out = intensity·LUT(coord) + (1−intensity)·coord — the cube form of
    // the pre-refactor alpha-fade blend over the un-luted image, which is what the
    // calibrated 0.5–0.6 values were tuned against.
    //
    // BUILD 42 CRASH ROOT CAUSE: the previous loop advanced ONE index by 4+4+4+1 per
    // entry (values[i], then values[i+4], then values[i+8] — not R/G/B of the entry),
    // both scraping the wrong channels and running off the end of the array: with a
    // 33³ cube (143,748 floats) the last group read index 143,749 → Swift
    // index-out-of-range trap → the app died on the FIRST preview frame on device,
    // exactly "crash right after granting camera permission". Fixed indices per entry
    // (o, o+1, o+2; alpha untouched) are mandatory in this loop.
    let intensity = Float(number(color, "lutIntensity", 1, 0...1))
    if intensity < 0.999 {
      let denominator = Float(dim - 1)
      // CIColorCube/.cube order: RED varies fastest, then green, then blue.
      for index in 0..<count {
        let o = index * 4
        values[o] = intensity * values[o]
          + (1 - intensity) * Float(index % dim) / denominator
        values[o + 1] = intensity * values[o + 1]
          + (1 - intensity) * Float((index / dim) % dim) / denominator
        values[o + 2] = intensity * values[o + 2]
          + (1 - intensity) * Float(index / (dim * dim)) / denominator
      }
    }

    // 2. Temperature/tint (offset from 6500 K neutral, like the old CITemperatureAndTint).
    let kelvin = min(12_000.0, max(2_000.0, 6_500.0 + number(color, "temperature", 0, -4_500...5_500)))
    let tint = number(color, "tint", 0, -200...200)
    let tempGain: (Double, Double, Double) = {
      // Approximate CITemperatureAndTint's neutral→target ramp by RGB gain ratios.
      let t = kelvin / 6_500.0
      return (min(2.0, pow(t, 0.22)), 1.0, min(2.0, pow(1.0 / t, 0.22)))
    }()
    let tintGainG = 1.0 - tint * 0.0006
    let tintGainRB = 1.0 + tint * 0.0003
    let needsTemp = abs(kelvin - 6_500.0) > 0.5 || abs(tint) > 0.01
    // 3. Saturation (luma-preserving, same Rec.709 weights as CIColorControls).
    let sat = Float(number(color, "saturation", 1, 0...4))
    // 4. 7-band HSL fine trim. REFINED centers — differs from hueBandCube's nominal
    // bandCenters on purpose (see the ⚠️ note there before touching either table).
    let bandNames = ["red", "orange", "yellow", "green", "cyan", "blue", "magenta"]
    let bandCenters: [Double] = [0, 30, 57, 117, 182, 230, 302]
    let adjustments = zip(bandNames, bandCenters).map { name, center -> (Double, Double, Double, Double) in
      let band = dictionary(color["hueBands"])
      return (center, number(band, "hue", 0, -180...180), number(band, "saturation", 1, 0...4), number(band, "luminance", 1, 0...4))
    }
    let needsHSL = adjustments.contains { abs($0.1) > 0.0001 || abs($0.2 - 1) > 0.0001 || abs($0.3 - 1) > 0.0001 }

    if needsTemp || sat != 1.0 || needsHSL {
      for index in 0..<count {
        let o = index * 4
        var r = Double(values[o]), g = Double(values[o + 1]), b = Double(values[o + 2])
        if needsTemp {
          r *= tempGain.0; b *= tempGain.2
          g *= tintGainG; r *= tintGainRB; b *= tintGainRB
        }
        if sat != 1.0 {
          let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
          r = luma + (r - luma) * Double(sat)
          g = luma + (g - luma) * Double(sat)
          b = luma + (b - luma) * Double(sat)
        }
        if needsHSL {
          var hsl = rgbToHSL(min(1, max(0, r)), min(1, max(0, g)), min(1, max(0, b)))
          var hueShift = 0.0, saturation = 1.0, luminance = 1.0, weightSum = 0.0
          for item in adjustments {
            let distance = circularDistance(hsl.h, item.0)
            let weight = max(0.0, 1.0 - (distance / 42.0))
            if weight > 0 {
              let smooth = weight * weight * (3.0 - 2.0 * weight)
              hueShift += item.1 * smooth
              saturation += (item.2 - 1.0) * smooth
              luminance += (item.3 - 1.0) * smooth
              weightSum += smooth
            }
          }
          if weightSum > 0 {
            hsl.h = fmod(hsl.h + (hueShift / weightSum) + 360.0, 360.0)
            hsl.s = min(1.0, max(0.0, hsl.s * max(0.0, saturation)))
            hsl.l = min(1.0, max(0.0, hsl.l * max(0.0, luminance)))
          }
          let rgb = hslToRGB(hsl.h, hsl.s, hsl.l)
          r = rgb.0; g = rgb.1; b = rgb.2
        }
        values[o] = Float(min(1.0, max(0.0, r)))
        values[o + 1] = Float(min(1.0, max(0.0, g)))
        values[o + 2] = Float(min(1.0, max(0.0, b)))
      }
    }
    return (dim, dataFromFloats(values))
  }

  /// Data ↔ [Float] conversions that compile on every Swift 5/6 toolchain (the naive
  /// `[Float](data)` and `Data(buffer: [Float]` forms do not).
  private static func floatArray(_ data: Data) -> [Float] {
    var result = [Float](repeating: 0, count: data.count / MemoryLayout<Float>.size)
    result.withUnsafeMutableBytes { data.copyBytes(to: $0) }
    return result
  }
  private static func dataFromFloats(_ floats: [Float]) -> Data {
    var copy = floats
    return copy.withUnsafeBytes { Data($0) }
  }

  private static func number(_ values: [String: Any], _ key: String, _ fallback: Double, _ range: ClosedRange<Double>) -> Double {
    guard let boxed = values[key] as? NSNumber, CFGetTypeID(boxed) != CFBooleanGetTypeID() else { return fallback }
    let value = boxed.doubleValue
    guard value.isFinite else { return fallback }
    return min(range.upperBound, max(range.lowerBound, value))
  }

  private static func toneCurve(_ value: Any?) -> [CIVector]? {
    guard let values = value as? [Any], values.count == 5 else { return nil }
    var result: [CIVector] = []
    for value in values {
      guard let pair = value as? [Any], pair.count == 2,
            let x = (pair[0] as? NSNumber)?.doubleValue, let y = (pair[1] as? NSNumber)?.doubleValue,
            x.isFinite, y.isFinite else { return nil }
      result.append(CIVector(x: CGFloat(min(1, max(0, x))), y: CGFloat(min(1, max(0, y)))))
    }
    return result
  }

  /// NEUTRAL PASSTHROUGH: an identity curve (y == x everywhere) must not run through
  /// CIToneCurve (a needless filter pass on a full-res image).
  private static func isIdentityToneCurve(_ points: [CIVector]) -> Bool {
    points.allSatisfy { abs($0.x - $0.y) < 0.0001 }
  }

  private static func hueBandCube(_ bands: [String: Any]) -> (dimension: Int, data: Data)? {
    let adjustments = zip(bandNames, bandCenters).map { name, center -> (Double, Double, Double, Double) in
      let band = dictionary(bands[name])
      return (center, number(band, "hue", 0, -180...180), number(band, "saturation", 1, 0...4), number(band, "luminance", 1, 0...4))
    }
    guard adjustments.contains(where: { abs($0.1) > 0.0001 || abs($0.2 - 1) > 0.0001 || abs($0.3 - 1) > 0.0001 }) else { return nil }
    let dimension = 16
    var pixels = [Float]()
    pixels.reserveCapacity(dimension * dimension * dimension * 4)
    for blue in 0..<dimension { for green in 0..<dimension { for red in 0..<dimension {
      var hsl = rgbToHSL(Double(red) / Double(dimension - 1), Double(green) / Double(dimension - 1), Double(blue) / Double(dimension - 1))
      var hueShift = 0.0, saturation = 1.0, luminance = 1.0, weightSum = 0.0
      for item in adjustments {
        let distance = circularDistance(hsl.h, item.0)
        let weight = max(0.0, 1.0 - (distance / 42.0))
        if weight > 0 {
          let smooth = weight * weight * (3.0 - 2.0 * weight)
          hueShift += item.1 * smooth
          saturation += (item.2 - 1.0) * smooth
          luminance += (item.3 - 1.0) * smooth
          weightSum += smooth
        }
      }
      if weightSum > 0 {
        hsl.h = fmod(hsl.h + (hueShift / weightSum) + 360.0, 360.0)
        hsl.s = min(1.0, max(0.0, hsl.s * max(0.0, saturation)))
        hsl.l = min(1.0, max(0.0, hsl.l * max(0.0, luminance)))
      }
      let rgb = hslToRGB(hsl.h, hsl.s, hsl.l)
      pixels.append(contentsOf: [Float(rgb.0), Float(rgb.1), Float(rgb.2), 1.0])
    } } }
    return (dimension, Data(bytes: pixels, count: pixels.count * MemoryLayout<Float>.size))
  }

  private static func circularDistance(_ a: Double, _ b: Double) -> Double {
    let diff = fmod(abs(a - b), 360.0)
    return diff > 180.0 ? 360.0 - diff : diff
  }

  private static func rgbToHSL(_ r: Double, _ g: Double, _ b: Double) -> (h: Double, s: Double, l: Double) {
    let maxV = max(r, max(g, b)), minV = min(r, min(g, b)), delta = maxV - minV
    var h = 0.0, s = 0.0, l = (maxV + minV) / 2.0
    if delta > 0.00001 {
      s = l > 0.5 ? delta / (2.0 - maxV - minV) : delta / (maxV + minV)
      if maxV == r { h = ((g - b) / delta) + (g < b ? 6.0 : 0.0) }
      else if maxV == g { h = ((b - r) / delta) + 2.0 }
      else { h = ((r - g) / delta) + 4.0 }
      h *= 60.0
    }
    return (h, s, l)
  }

  private static func hslToRGB(_ h: Double, _ s: Double, _ l: Double) -> (Double, Double, Double) {
    guard s > 0.00001 else { return (l, l, l) }
    let q = l < 0.5 ? l * (1.0 + s) : l + s - (l * s)
    let p = (2.0 * l) - q
    let hk = h / 360.0
    return (hueToRGB(p, q, hk + (1.0 / 3.0)), hueToRGB(p, q, hk), hueToRGB(p, q, hk - (1.0 / 3.0)))
  }

  private static func hueToRGB(_ p: Double, _ q: Double, _ t: Double) -> Double {
    var tc = t
    if tc < 0 { tc += 1.0 }
    if tc > 1 { tc -= 1.0 }
    if tc < 1.0 / 6.0 { return p + ((q - p) * 6.0 * tc) }
    if tc < 1.0 / 2.0 { return q }
    if tc < 2.0 / 3.0 { return p + ((q - p) * ((2.0 / 3.0) - tc) * 6.0) }
    return p
  }

  private static func filter(_ name: String, _ input: CIImage, _ parameters: [String: Any]) -> CIImage {
    guard let filter = CIFilter(name: name) else { return input }
    filter.setValue(input, forKey: kCIInputImageKey)
    let keys = Set(filter.inputKeys)
    for (key, value) in parameters where keys.contains(key) {
      filter.setValue(value, forKey: key)
    }
    return filter.outputImage ?? input
  }
}
