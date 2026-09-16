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

  /// Capability detection: physical iff the CURRENT device + activeFormat satisfy ALL of
  /// - non-degenerate variable-aperture range (min < max),
  /// - recommendedLensApertureStops.count > 1 (the system publishes real detents),
  /// - the exposure setter exists on this OS,
  /// - `supportsExposureModeCustom(lensAperture:duration:iso:)` VERIFIES a target
  ///   aperture + auto-exposure combination is supported.
  /// No device names anywhere — a future variable-aperture iPhone needs zero code changes.
  func capabilityMode(for device: AVCaptureDevice?) -> ApertureMode {
    // NECESSARY CONDITION: the real autoExposureDuration/autoISO sentinels must be
    // obtainable — without them AE cannot compensate aperture changes and the frame
    // darkens (frozen shutter/ISO). Capability = range + stops + setter + supports
    // check + live auto sentinels. All of it, or simulated.
    #if DEBUG || CAMERA18_TESTING
    if let mock = mockOverride { return mock }
    #endif
    guard autoSentinels() != nil else { return .fixed }
    guard let device,
          let range = variableApertureRange(device),
          (range.stops?.count ?? 0) > 1,
          device.responds(to: NSSelectorFromString("setExposureModeCustomWithLensAperture:duration:ISO:completionHandler:")),
          supportsExposureModeCustom(device.activeFormat, aperture: Float(range.min))
    else { return .fixed }
    return .variable
  }

  /// Dynamic availability check for the iOS 27 aperture/exposure combination. Compiled
  /// against any SDK (responds + IMP cast); only the CURRENT activeFormat answer counts.
  private func supportsExposureModeCustom(_ format: NSObject, aperture: Float) -> Bool {
    if #available(iOS 27.0, *) {
      let sel = NSSelectorFromString("supportsExposureModeCustomWithLensAperture:duration:ISO:")
      guard let auto = autoSentinels() else { return false }
      guard format.responds(to: sel), let method = format.method(for: sel) else { return false }
      typealias Check = @convention(c) (AnyObject, Selector, Float, CMTime, Float) -> ObjCBool
      let fn = unsafeBitCast(method, to: Check.self)
      return fn(format, sel, aperture, auto.duration, auto.iso).boolValue
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
    if let range = variableApertureRange(device) {
      return Capabilities(
        supportsVariableAperture: true,
        minAperture: range.min,
        maxAperture: range.max,
        activeAperture: active,
        // Hardware detents when the format publishes them; otherwise the JS layer derives
        // a 1/3-stop ladder from min/max (deriveVariableApertures).
        supportedApertures: (range.stops?.isEmpty == false) ? range.stops : nil,
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

    guard let range = variableApertureRange(device) else {
      // Capability flipped away from variable between route and call - honest failure.
      mode = .fixed
      DispatchQueue.main.async { completion(.failure(.apertureUnsupported)) }
      return
    }
    // APERTURE PRIORITY GUARD: the format must accept (target aperture + auto shutter +
    // auto ISO). Shutter and ISO are NEVER locked — Apple auto exposure compensates the
    // light change, so .quality still gets full multi-frame fusion (user directive).
    if !supportsExposureModeCustom(device.activeFormat, aperture: Float(min(max(fStop, range.min), range.max))) {
      // Combination unsupported on this format - honest failure, no simulation.
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
    let target = Float(min(max(fStop, range.min), range.max))
    let setterSel = NSSelectorFromString("setExposureModeCustomWithLensAperture:duration:ISO:completionHandler:")
    guard device.responds(to: setterSel) else {
      completion(.failure(.apertureUnsupported))
      return
    }
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      let imp = device.method(for: setterSel)
      typealias ApertureSetter = @convention(c) (NSObject, Selector, Float, CMTime, Float, ((Error?) -> Void)?) -> Void
      let fn = unsafeBitCast(imp, to: ApertureSetter.self)
      let gate = SettleOnceGate(completion: completion)
      fn(device, setterSel, target, auto.duration, auto.iso) { error in
        if let error = error {
          gate.settle(.failure(.configurationFailed))
          print("[CameraEngine] setExposureModeCustom(lensAperture:) rejected: \(error.localizedDescription)")
        } else {
          gate.settle(.success(()))
        }
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
    let durationSel = NSSelectorFromString("autoExposureDuration")
    let isoSel = NSSelectorFromString("autoISO")
    let deviceClass: AnyObject = AVCaptureDevice.self
    guard deviceClass.responds(to: durationSel), deviceClass.responds(to: isoSel),
          let durationImp = class_getMethodImplementation(object_getClass(AVCaptureDevice.self), durationSel) as IMP?,
          let isoImp = class_getMethodImplementation(object_getClass(AVCaptureDevice.self), isoSel) as IMP?
    else { return nil }
    typealias ClassTimeGetter = @convention(c) (AnyObject, Selector) -> CMTime
    typealias ClassFloatGetter = @convention(c) (AnyObject, Selector) -> Float
    let duration = unsafeBitCast(durationImp, to: ClassTimeGetter.self)(deviceClass, durationSel)
    let iso = unsafeBitCast(isoImp, to: ClassFloatGetter.self)(deviceClass, isoSel)
    guard duration.isValid, iso.isFinite else { return nil }
    return (duration, iso)
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

    Events("onApertureChanged", "onZoomChanged")

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

    AsyncFunction("capturePhoto") { (promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.capture { result, detail in self.settle(result, promise, detail: detail) }
    }

    AsyncFunction("setAperture") { (fStop: Double, promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.setAperture(fStop, controller: self.apertureController) { result in
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
    #if DEBUG || CAMERA18_TESTING
    /// TestFlight Beta only: force aperture capability for UI testing.
    /// "real" | "mock-variable" | "mock-fixed". No hardware APIs are invoked in mock
    /// modes; photos are completely unaffected.
    AsyncFunction("setMockApertureMode") { (mode: String, promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.setMockApertureMode(mode, controller: self.apertureController)
      self.settle(.success(()), promise)
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

    /// Crop zoom on the ACTIVE lens (videoZoomFactor); applies to preview AND capture.
    AsyncFunction("setZoomFactor") { (factor: Double, promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
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
        self.capture { _, _ in }
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
    CameraDNARenderer.invalidateCompiledProfile(value)
    profileLock.lock()
    profile = value
    compiledFinal = nil
    compiledPreview = nil
    profileLock.unlock()
  }

  /// Lazy compile: the FIRST consumer after a profile change pays the 33³ build once,
  /// on its own queue (exactly the old effectiveColorCube timing profile). The cache
  /// inside CameraDNARenderer makes every later consumer a key hit.
  private func compiledSnapshot(_ source: CameraInputNormalizer.Source) -> CameraDNARenderer.CompiledCameraProfile? {
    profileLock.lock()
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
      guard configured, session.isRunning, let orientation = currentDeviceOrientation() else { return }
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

  /// DEVICE SELECTION (user spec): real Ultra Wide / real Tele REQUIRE the virtual
  /// device (system seamless crossfade between constituents). Preference:
  /// triple -> dual -> dual-wide -> physical wide. The JS dial defaults to 26mm
  /// (zoom 2.0 on virtual bodies), so the MAIN lens still owns the default capture.
  /// Aperture capability is re-resolved per active physical lens (see zoom KVO).
  fileprivate static func preferredCaptureDevice() -> AVCaptureDevice? {
    let types: [AVCaptureDevice.DeviceType] = [
      .builtInTripleCamera,
      .builtInDualCamera,
      .builtInDualWideCamera,
      .builtInWideAngleCamera,
    ]
    for type in types {
      if let device = AVCaptureDevice.default(type, for: .video, position: .back) {
        return device
      }
    }
    return nil
  }

  private func configureSession() throws {
    guard let device = CameraEngineView.preferredCaptureDevice() else {
      throw CameraEngineError.cameraUnavailable
    }

    // Configure the device before touching the session so a lock failure leaves no partial graph.
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      CameraEngineView.applyAutoModes(to: device)
      // Cap the stream at 30fps to match the viewfinder — min duration 1/30 ⇒ at most
      // 30fps. Device-level API: the connection-level videoMinFrameDuration /
      // isVideoMinFrameDurationSupported are UNAVAILABLE in the current iOS SDK
      // (TestFlight run 43 compile errors).
      device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
    } catch {
      throw CameraEngineError.configurationFailed
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
    // BASE-QUALITY FIX: .quality — .balanced shortened Apple's multi-frame fusion and
    // NR pipeline (the top cause of "noisy, soft" output). Capture latency is the
    // acceptable price while base image quality is being fixed.
    output.maxPhotoQualityPrioritization = .quality

    // PHOTO FORMAT POLICY (user directive): the activeFormat must serve the device's
    // BEST fully processed photo — never a preview/fps-oriented low-quality format.
    // The session preset is .photo (AVFoundation selects the max-quality photo format);
    // preview comes from a separate VideoDataOutput and is downscaled only AFTER capture
    // (previewCap in captureOutput), never by format choice. This audit logs the facts
    // so any mismatch between device best and activeFormat is visible in the field.
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
      print("[CameraEngine][Diag] device=\(device.deviceType.rawValue) model=\(machine) lens=\(device.localizedName)")
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

    // 24MP TARGET: on iPhone 15+ class devices whose activeFormat explicitly supports a
    // ~24MP photo dimension, request it (Apple multi-frame fused, .quality). On devices
    // without a 24MP option (e.g. iPhone 14 Plus → 12MP ladder) fall back to the device's
    // BEST processed dimension instead of squeezing an interpolation out of nothing.
    if #available(iOS 16.0, *) {
      let supported = device.activeFormat.supportedMaxPhotoDimensions
      if !supported.isEmpty {
        let exact24 = supported.filter { $0.width * $0.height >= 23_000_000 && $0.width * $0.height <= 25_000_000 }
        let chosen: CMVideoDimensions
        if let best24 = exact24.max(by: { $0.width * $0.height < $1.width * $1.height }) {
          chosen = best24
        } else {
          chosen = supported.max(by: { $0.width * $0.height < $1.width * $1.height })!
          print("[CameraEngine][Diag] no ~24MP dimension on this device — using device best \(chosen.width)x\(chosen.height)")
        }
        output.maxPhotoDimensions = chosen
        print("[CameraEngine][Diag] maxPhotoDimensions = \(chosen.width)x\(chosen.height) (\(chosen.width * chosen.height / 1_000_000)MP)")
      }
    }

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
    // The 30fps cap for this stream is set device-wide in configureSession's
    // lockForConfiguration block (activeVideoMinFrameDuration).
    if let orientation = currentDeviceOrientation() {
      _ = setOrientation(orientation)
    }

    session.commitConfiguration()
    camera = device
    configured = true
    refreshApertureCapabilities()
    setupCameraControls(device: device)
    let controlSurface = CameraControlProbe.exposedMethods()
    print("[CameraEngine][Diag] Camera Control public surface (\(controlSurface.count) methods): \(controlSurface.isEmpty ? "none exposed by this OS" : controlSurface.joined(separator: ", "))")
  }

  fileprivate func capture(completion: @escaping (Result<[String: Any], CameraEngineError>, String?) -> Void) {
    sessionQueue.async {
      guard self.session.isRunning else { completion(.failure(.notRunning), nil); return }
      CameraTempFiles.removeUntrackedFiles()

      // Iteration 4: rapid shutter presses must not pile up unbounded ProRAW buffers.
      // A small in-flight cap keeps memory flat; the user gets an honest busy signal
      // instead of a crash or silent queue growth.
      guard self.captureDelegates.count < 3 else {
        completion(.failure(.captureBusy), nil)
        return
      }

      // PRODUCTION PIPELINE: one source, one truth — the full-resolution Apple-processed
      // photo. ProRAW/DNG and dual-format (RAW + processed companion) capture are removed:
      // the final architecture is Apple Processed Photo → LUT → Fine Color → Tone →
      // HEIF/JPEG, one decode → one render → one encode. No in-house multi-frame fusion:
      // the session is pinned to the physical wide camera, which has no virtual-device
      // Fusion path (and preserves real variable-aperture semantics on iPhone 18 Pro).
      let photoSettings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])

      photoSettings.photoQualityPrioritization = .quality
      // Per-capture mirror of output.maxPhotoDimensions (iOS 16+): guarantee the 24MP
      // fused target every capture, independent of any earlier settings object.
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
      } else {
        print("[CameraEngine][Diag] responsive capture not available on this device/OS — standard quality path (supported=\(outputResponds), settable=\(settingsResponds))")
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
      // ENABLE PHOTO DELIVERY IN PREVIEW-RES? No — keep full-res delivery (default).
      // (Companion/preview-sized images are never requested; the main photo is the only
      // consumer of the pipeline.)
      // Landscape-held captures must stay landscape in the photo library: rotate the capture
      // connection to the physical device orientation so buffers arrive already upright and
      // the saved JPEG needs no EXIF rotation fix-up. Same rotation path as the preview
      // (videoRotationAngle on iOS 17+) — preview and photo always agree.
      if let orientation = self.currentDeviceOrientation() {
        _ = self.applyRotation(orientation, to: self.output.connection(with: .video))
      }
      // Shutter fidelity relies on .balanced prioritization + the ProRAW dual-format path.
      // NOTE: AVCapturePhotoSettings exposes no fast-capture toggle in this SDK; do not
      // re-add speculative API names without verifying against the actual headers.
      // EXIF focal stamp: the metadata carries the NATIVE lens focal (e.g. 26mm), so
      // crop-zoomed shots read wrong in the Photos app (device report: 35/52mm shots
      // labeled 26mm). Read the zoom ACTUALLY applied to the device right before the
      // shutter — the same zoom the photo pipeline renders with — and derive the
      // 35mm-equivalent: zoom 1.0 renders 13mm on virtual devices (UW base), 26mm on
      // single-wide bodies (matches focalLadder.ts).
      let appliedZoom = self.camera?.videoZoomFactor ?? 1.0
      let baseEquivalentMM: Double = self.camera?.deviceType == .builtInWideAngleCamera ? 26.0 : 13.0
      let equivalentFocalMM = Int((baseEquivalentMM * appliedZoom).rounded())
      let id = photoSettings.uniqueID
      let delegate = PhotoCaptureDelegate(
        compiled: self.compiledSnapshot(.processedPhoto),
        appliedZoom: appliedZoom,
        equivalentFocalMM: equivalentFocalMM,
      ) { [weak self] result, detail in
        self?.sessionQueue.async { self?.captureDelegates.removeValue(forKey: id) }
        completion(result, detail)
      }
      self.captureDelegates[id] = delegate
      self.output.capturePhoto(with: photoSettings, delegate: delegate)
    }
  }

  // Aperture capability for the CAPTURE path (drives real iris vs fixed UI).
  // Defaults mirror the controller so captures taken before any ring touch are sane
  // (f/1.8 simulated would blur — but the processor skips when no person mask exists,
  // and the DEFAULT aperture state on fixed-lens devices is resolved by capabilities).
  fileprivate var apertureMode: ApertureMode = .fixed
  // Camera Control (hardware side button): retained controls + interaction objects.
  private var cameraControlObjects: [AnyObject] = []
  // The module owns the controller; the view keeps a weak ref for control callbacks.
  fileprivate weak var apertureControllerRef: ApertureController?
  fileprivate func setApertureController(_ controller: ApertureController) {
    apertureControllerRef = controller
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

  /// Focal-ladder info for the JS dial. On a virtual device (triple/dual camera) zoom
  /// factor 1.0 renders the widest constituent camera (ultra-wide, 13mm-equivalent), so
  /// the JS side maps mm → zoom as mm/13; single-wide bodies keep the 26mm main native.
  fileprivate func availableLenses(completion: @escaping (Result<[String: Any], CameraEngineError>) -> Void) {
    sessionQueue.async {
      guard let device = self.camera ?? CameraEngineView.preferredCaptureDevice() else {
        DispatchQueue.main.async { completion(.failure(.cameraUnavailable)) }
        return
      }
      let kind: String
      switch device.deviceType {
      case .builtInTripleCamera: kind = "virtual-triple"
      case .builtInDualCamera: kind = "virtual-dual"
      case .builtInDualWideCamera: kind = "virtual-dual-wide"
      default: kind = "single"
      }
      // CAPABILITY-BASED lens availability (no model names): virtual devices always
      // contain the ultra-wide; a TELE exists only when the system publishes a
      // switchover zoom factor BEYOND the main camera (last switchover = tele).
      // Tele stop mm = 13 (virtual base) * teleZoom.
      let isVirtual = kind.hasPrefix("virtual")
      var teleZoom: Double? = nil
      if isVirtual, device.responds(to: NSSelectorFromString("virtualDeviceSwitchOverVideoZoomFactors")),
         let factors = device.value(forKey: "virtualDeviceSwitchOverVideoZoomFactors") as? [NSNumber] {
        let sorted = factors.map(\.doubleValue).sorted()
        if sorted.count >= 2, let last = sorted.last, last > 2.0 {
          teleZoom = last
        }
      }
      DispatchQueue.main.async {
        completion(.success([
          "kind": kind,
          "deviceModel": device.localizedName,
          "ultraWide": isVirtual,
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

  /// Legacy physical-input swap — superseded by the virtual-device zoom path. On virtual
  /// devices this MUST NOT run (it would break the seamless switch), so it just succeeds.
  fileprivate func setLens(_ lensId: String, completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    sessionQueue.async {
      if let device = self.camera, device.deviceType != .builtInWideAngleCamera {
        completion(.success(()))
        return
      }
      completion(.success(()))
    }
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
      // A zoom switchover means the ACTIVE PHYSICAL LENS changed (wide <-> tele):
      // re-resolve aperture capability per the current lens (spec section 10).
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
      previewRenderer.enqueue(image)
    } else {
      // No-Metal fallback: push a CGImage into the plain layer.
      guard let cgImage = CameraEngineGPU.ciContext.createCGImage(image, from: image.extent) else { return }
      DispatchQueue.main.async { [self] in
        renderLayer.contents = cgImage
      }
    }
  }
}

// MARK: - WYSIWYG Preview Display (MTKView, no custom Metal shader)
/// Core Image renders the latest filtered frame straight into the drawable texture.
private final class PreviewRenderer: NSObject, MTKViewDelegate {
  // MTKView does not expose a command queue; the renderer owns one on the shared device.
  // Optional only because the property initializes before the Metal-availability check —
  // draw() is reached solely through the MTKView path, which implies a device exists.
  private let commandQueue: MTLCommandQueue?
  private let lock = NSLock()
  private var pendingImage: CIImage?
  private var currentExtentStorage = CGRect.zero

  override init() {
    self.commandQueue = CameraEngineGPU.metalDevice?.makeCommandQueue()
    super.init()
  }

  /// Extent of the most recently enqueued frame (letterbox mapping input).
  var currentExtent: CGRect {
    lock.lock(); defer { lock.unlock() }
    return currentExtentStorage
  }

  func enqueue(_ image: CIImage) {
    lock.lock()
    pendingImage = image
    currentExtentStorage = image.extent
    lock.unlock()
  }

  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

  func draw(in view: MTKView) {
    lock.lock()
    let image = pendingImage
    pendingImage = nil
    lock.unlock()

    guard let image = image,
          let drawable = view.currentDrawable,
          let commandBuffer = commandQueue?.makeCommandBuffer() else { return }

    let drawableSize = view.drawableSize
    guard drawableSize.width > 1, drawableSize.height > 1 else { return }

    // Letterbox the 4:3 frame inside the drawable (aspect-fit), matching the capture.
    let extent = image.extent
    let scale = min(drawableSize.width / extent.width, drawableSize.height / extent.height)
    let fitted = image
      .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
      .transformed(by: CGAffineTransform(
        translationX: (drawableSize.width - extent.width * scale) / 2,
        y: (drawableSize.height - extent.height * scale) / 2))
    // Repaint EVERY drawable pixel each frame: Core Image writes only where the image
    // lands, so the aspect-fit bars kept the PREVIOUS frame's pixels. After an
    // orientation switch the frame's aspect changes and the viewfinder literally showed
    // the old portrait frame and the new landscape frame superimposed (device report,
    // build 44). Compositing over an opaque black backdrop covers the full drawable —
    // the bars render as honest black, like the system camera.
    let backdrop = CIImage(color: CIColor.black)
      .cropped(to: CGRect(origin: .zero, size: drawableSize))
    let frame = fitted.composited(over: backdrop)

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

// MARK: - Photo Capture Delegate (Apple Processed Photo → LUT → Tone → JPEG)
private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
  private static let processingQueue = DispatchQueue(label: "camera-engine.photo-processing", qos: .userInitiated)
  // ponytail: static shared CIContext avoids allocating GPU command queue/shader cache per shutter press
  private static let sharedContext = CameraEngineGPU.ciContext
  private let compiled: CameraDNARenderer.CompiledCameraProfile?
  private let completion: (Result<[String: Any], CameraEngineError>, String?) -> Void
  private let completionLock = NSLock()
  private var didComplete = false
  private var generatedURLs: [URL] = []
  /// Zoom ACTUALLY applied to the device at shutter time, and its 35mm-equivalent focal
  /// (base × zoom) — stamped into EXIF so crop-zoomed shots read correctly in Photos.
  private let appliedZoom: Double
  private let equivalentFocalMM: Int
  init(compiled: CameraDNARenderer.CompiledCameraProfile?, appliedZoom: Double, equivalentFocalMM: Int, completion: @escaping (Result<[String: Any], CameraEngineError>, String?) -> Void) {
    self.compiled = compiled
    self.appliedZoom = appliedZoom
    self.equivalentFocalMM = equivalentFocalMM
    self.completion = completion
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
      finish(.failure(.captureFailed))
      return
    }
    processCapturedData(photoData, metadata: photo.metadata)
  }

  /// PRODUCTION PIPELINE — one decode, one render, one encode, full resolution end to end:
  ///   Apple processed photo (Data) → CIImage → LUT cube (LUT + fine color) → Tone → JPEG.
  /// Runs exactly once per capture (guarded by hasCompleted inside finish).
  private func processCapturedData(_ photoData: Data, metadata: [AnyHashable: Any]) {
    Self.processingQueue.async { [self] in
      guard !hasCompleted else { return }

      guard let source = CIImage(data: photoData, options: [.applyOrientationProperty: true]) else {
        finish(.failure(.captureFailed))
        return
      }
      let inputExtent = source.extent.integral
      print("[CameraEngine][Diag] pipeline input extent=\(Int(inputExtent.width))x\(Int(inputExtent.height))")

      // Compiled final pipeline (processed-photo normalizer + LUT + fine color + tone).
      // compiled == nil → true passthrough (no profile applied yet).
      var image = source
      if let compiled = compiled {
        image = CameraDNARenderer.apply(compiled, to: image)
      }
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

      guard !hasCompleted else {
        CameraTempFiles.remove([fileURL, thumbURL])
        return
      }

      // 2. Add to Photos via add-only permission
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
          // The thumbnail the UI displays must survive restarts — serve the Documents
          // copy when persistence succeeds, fall back to the temp file otherwise.
          let thumbnailURI = CameraTempFiles.persistLatestThumbnail(from: thumbURL)?.absoluteString
            ?? thumbURL.absoluteString
          self.finish(.success([
            "fileUri": fileURL.absoluteString,
            "thumbnailUri": thumbnailURI,
            "assetLocalIdentifier": localIdentifier ?? NSNull(),
            "appliedZoom": appliedZoom,
            "equivalentFocal": equivalentFocalMM,
            "codec": codec,
          ]))
        }
      }
    }
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
    // didFinishProcessingPhoto owns the outcome for the single processed photo (finish()
    // is idempotent). This callback only acts as the never-arrived safety net so the JS
    // promise cannot hang forever (shutter stuck disabled).
    if error != nil {
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
  private static func encodedRepresentation(_ image: CIImage, metadata: [AnyHashable: Any]?, colorSpace: CGColorSpace, quality: Double, equivalentFocalMM: Int, type: CFString) -> Data? {
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
    DispatchQueue.main.async { self.completion(result, detail) }
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
///   → Export sRGB. No implicit per-path color-space differences, no redundant
///   conversions. Precision: Core Image processes in its float working space end to
///   end; quantization to 8-bit happens exactly once, inside the final HEIF/JPEG encode.
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
    let profileID: String
    let profileRevision: Int
    let normalizerID: String
    let normalizerRevision: Int
    let rendererVersion: Int
    /// True when NOTHING in this profile can alter pixels (identity normalizer +
    /// neutral color + neutral tone). Guaranteed filter-free by construction.
    let isIdentity: Bool
  }

  private static let bandNames = ["red", "orange", "yellow", "green", "cyan", "blue", "magenta"]
  private static let bandCenters: [Double] = [0, 30, 60, 120, 180, 240, 300]

  /// Unified rendering pipeline — consumes ONLY a compiled profile (no JSON per frame).
  /// Source → effective cube (normalizer + LUT + fine color) → Exposure → Contrast →
  /// Black point → Tone curve. Every stage skips itself when neutral.
  static func apply(_ compiled: CompiledCameraProfile, to source: CIImage) -> CIImage {
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

  /// Bump the revision ONLY when a profile's COLOR payload actually changed. setProfile
  /// runs on every RN prop application AND through applyProfile — historically twice per
  /// aperture-drag tick, which rebuilt this 33³ cube on the render queue each time and
  /// leaked one ~0.5 MB cache entry per rebuild. Tone is compiled once with the cube and
  /// read from the CompiledCameraProfile afterwards — never from JSON per frame.
  static func invalidateCompiledProfile(_ profile: [String: Any]) {
    guard let id = profile["id"] as? String else { return }
    let fingerprint = colorFingerprint(profile["color"])
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
      profileID: id,
      profileRevision: revision,
      normalizerID: normalizer.id,
      normalizerRevision: normalizer.revision,
      rendererVersion: rendererVersion,
      isIdentity: effectiveCube == nil && toneIsNeutral,
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
    // 4. 7-band HSL fine trim.
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
