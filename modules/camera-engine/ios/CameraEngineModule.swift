import ExpoModulesCore
import AVFoundation
import Photos
import CoreImage
import CoreFoundation
import ImageIO
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

// MARK: - Aperture Controller Abstraction
/// Manages variable aperture runtime discovery and hardware control.
/// Since iOS 27 / iPhone 18 Pro, Apple exposes the physical variable aperture to third
/// parties: `AVCaptureDevice.setExposureModeCustom(lensAperture:duration:iso:)` gives us
/// true aperture-priority (hardware aperture under our control, shutter/ISO stay auto),
/// with the real range in `activeFormat.minLensAperture / maxLensAperture` and the
/// hardware detents in `activeFormat.recommendedLensApertureStops`.
/// On older OS versions or lenses without a variable aperture we still honestly report
/// supportsVariableAperture = false and reject setAperture — never fake depth of field.
final class ApertureController {
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

  private func currentAperture(_ device: AVCaptureDevice) -> Double {
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

  /// Set the physical lens aperture (aperture-priority: shutter and ISO stay automatic
  /// via the auto sentinels). Apple notes the hardware may settle on the nearest real
  /// physical position, which is why callers re-read currentLensAperture through
  /// getCapabilities for display.
  func setAperture(_ fStop: Double, on device: AVCaptureDevice?, completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    guard let device = device else {
      completion(.failure(.cameraUnavailable))
      return
    }

    guard let range = variableApertureRange(device) else {
      completion(.failure(.apertureUnsupported))
      return
    }
    let target = Float(min(max(fStop, range.min), range.max))
    let setterSel = NSSelectorFromString("setExposureModeCustomWithLensAperture:duration:ISO:completionHandler:")
    guard device.responds(to: setterSel) else {
      completion(.failure(.apertureUnsupported))
      return
    }
    // The auto sentinels (shutter/ISO stay automatic) are iOS 27 class properties, so they
    // are fetched through dynamic class-method calls too — compiling against an older SDK
    // never references the symbols at link time.
    let deviceClass: AnyObject = AVCaptureDevice.self
    let durationSel = NSSelectorFromString("autoExposureDuration")
    let isoSel = NSSelectorFromString("autoISO")
    guard deviceClass.responds(to: durationSel), deviceClass.responds(to: isoSel),
          let durationImp = class_getMethodImplementation(object_getClass(AVCaptureDevice.self), durationSel) as IMP?,
          let isoImp = class_getMethodImplementation(object_getClass(AVCaptureDevice.self), isoSel) as IMP? else {
      completion(.failure(.apertureUnsupported))
      return
    }
    typealias ClassTimeGetter = @convention(c) (AnyObject, Selector) -> CMTime
    typealias ClassFloatGetter = @convention(c) (AnyObject, Selector) -> Float
    let autoDuration = unsafeBitCast(durationImp, to: ClassTimeGetter.self)(deviceClass, durationSel)
    let autoIso = unsafeBitCast(isoImp, to: ClassFloatGetter.self)(deviceClass, isoSel)
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      let imp = device.method(for: setterSel)
      typealias ApertureSetter = @convention(c) (NSObject, Selector, Float, CMTime, Float, ((Error?) -> Void)?) -> Void
      let fn = unsafeBitCast(imp, to: ApertureSetter.self)
      fn(device, setterSel, target, autoDuration, autoIso, nil)
      completion(.success(()))
    } catch {
      completion(.failure(.configurationFailed))
    }
  }
}

// MARK: - Expo Module Definition
public final class CameraEngineModule: Module {
  private weak var activeView: CameraEngineView?
  private let apertureController = ApertureController()

  public func definition() -> ModuleDefinition {
    Name("CameraEngine")

    OnCreate {
      CameraEngineView.registrationHandler = { [weak self] view, isActive in
        guard let self = self else { return }
        if isActive {
          self.activeView = view
        } else if self.activeView === view {
          self.activeView = nil
        }
      }
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
      OnViewDidUpdateProps { view in
        self.activeView = view
      }
    }

    AsyncFunction("startCamera") { (promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.start { result in self.settle(result, promise) }
    }

    AsyncFunction("stopCamera") { (promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.stop { promise.resolve(nil) }
    }

    AsyncFunction("capturePhoto") { (promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.capture { result in self.settle(result, promise) }
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

  private func settle<T>(_ result: Result<T, CameraEngineError>, _ promise: Promise) {
    DispatchQueue.main.async {
      switch result {
      case .success(let value): promise.resolve(value)
      case .failure(let error): promise.reject(error.rawValue, error.message)
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
  private var profile: [String: Any] = [:]
  private var camera: AVCaptureDevice?
  private var configured = false
  // Session-lifecycle bookkeeping (accessed only on sessionQueue): interruption and
  // runtime errors must self-heal instead of leaving a permanently frozen preview.
  private var sessionShouldRun = false
  private var interruptionObservers: [NSObjectProtocol] = []
  private var captureDelegates: [Int64: PhotoCaptureDelegate] = [:]
  // Active rear lens; confined to sessionQueue (read by configureSession / setLens).
  private var lensType: AVCaptureDevice.DeviceType = .builtInWideAngleCamera

  // WYSIWYG viewfinder: session frames are pushed through the SAME Camera DNA renderer as
  // captures (mode .preview), so the preview shows exactly what the photo will look like.
  // Architecture: AVCaptureVideoDataOutput → CIImage → CameraDNARenderer(.preview) → MTKView.
  private let previewRenderer = PreviewRenderer()
  private var previewView: MTKView?
  // Fallback display for exotic no-Metal environments only.
  private let renderLayer = CALayer()
  private let videoOutput = AVCaptureVideoDataOutput()
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
    Self.registrationHandler?(self, true)
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
    profileLock.lock(); profile = value; profileLock.unlock()
  }

  // Rounded viewfinder card: clip the preview (and every sublayer) to a continuous-corner
  // rounded rect. Applied to the root layer AND the Metal view so the drawable never
  // pokes past a corner.
  private var cornerRadiusStorage: CGFloat = 0

  fileprivate func setCornerRadius(_ radius: CGFloat) {
    cornerRadiusStorage = max(0, radius)
    applyCornerRadius()
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

  private func profileSnapshot() -> [String: Any] {
    profileLock.lock(); defer { profileLock.unlock() }; return profile
  }

  fileprivate func start(completion: @escaping (Result<Bool, CameraEngineError>) -> Void) {
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
  }

  /// Self-heal after system interruptions / runtime errors: restart the session only
  /// when the app still wants it running (GOAL: never a permanent frozen preview).
  fileprivate func resumeIfNeeded() {
    sessionQueue.async {
      guard self.sessionShouldRun, self.configured, !self.session.isRunning else { return }
      self.session.startRunning()
    }
  }

  /// Keep preview + capture connections in step with the physical device orientation.
  // Rotation debouncing: orientationDidChange fires in bursts while the device pivots.
  // Re-orienting mid-burst reconfigures the connections several times per rotation and
  // shows up as an occasional viewfinder stutter; settling 300ms keeps one clean switch.
  private var lastOrientationSyncAt = TimeInterval(0)

  private func syncOutputOrientation() {
    sessionQueue.async { [self] in
      guard configured, session.isRunning else { return }
      let now = CACurrentMediaTime()
      guard now - lastOrientationSyncAt > 0.3 else { return }
      // Only commit the timestamp when an actual re-orientation happened (setOrientation
      // no-ops when the connection already matches), so unchanged states never throttle.
      let before = videoOutput.connection(with: .video)?.videoOrientation
      CameraEngineView.setOrientation(on: videoOutput, photoOutput: output)
      if videoOutput.connection(with: .video)?.videoOrientation != before {
        lastOrientationSyncAt = now
      }
    }
  }

  private static func currentDeviceOrientation() -> AVCaptureVideoOrientation? {
    // The UI itself rotates (canonical camera interaction), so the WINDOW SCENE's
    // interface orientation is the authoritative source — it reflects what the user
    // actually sees. Device orientation is only the fallback (e.g. scene not yet ready).
    if let scene = UIApplication.shared.connectedScenes
      .compactMap({ $0 as? UIWindowScene })
      .first(where: { $0.activationState == .foregroundActive }) {
      switch scene.interfaceOrientation {
      case .portrait: return .portrait
      case .portraitUpsideDown: return .portraitUpsideDown
      case .landscapeLeft: return .landscapeLeft
      case .landscapeRight: return .landscapeRight
      case .unknown: break
      @unknown default: break
      }
    }
    let deviceOrientation = UIDevice.current.orientation
    // During a physical rotation the OS briefly reports faceUp / unknown. Returning a
    // fallback here made the connection orientation oscillate portrait ↔ landscape and
    // the viewfinder twitch — invalid orientations must be IGNORED, keeping the last
    // stable one until the rotation settles.
    guard deviceOrientation.isValidInterfaceOrientation else { return nil }
    // AVCaptureVideoOrientation shares its raw values with UIDeviceOrientation.
    return AVCaptureVideoOrientation(rawValue: deviceOrientation.rawValue)
  }

  private static func setOrientation(on videoOutput: AVCaptureVideoDataOutput, photoOutput: AVCapturePhotoOutput) {
    guard let orientation = currentDeviceOrientation() else { return }
    // Only touch the connection when the orientation actually changed — every
    // re-assignment causes a visible glitch in the preview feed.
    if let current = videoOutput.connection(with: .video)?.videoOrientation, current != orientation {
      videoOutput.connection(with: .video)?.videoOrientation = orientation
    }
    if let current = photoOutput.connection(with: .video)?.videoOrientation, current != orientation {
      photoOutput.connection(with: .video)?.videoOrientation = orientation
    }
  }

  private static func applyAutoModes(to device: AVCaptureDevice) {
    if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
    if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
    if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { device.whiteBalanceMode = .continuousAutoWhiteBalance }
  }

  /// Apple's canonical smooth-focal solution (AVCam / WWDC guidance): prefer a VIRTUAL
  /// device (triple/dual camera). One input covers every rear lens and the system performs
  /// the seamless crossfade between physical cameras when videoZoomFactor crosses their
  /// boundaries — no manual input swaps, no preview flicker.
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
    // GOAL 16: V1 prioritizes .balanced — Camera 18 is an everyday camera and the shutter must
    // give quick, clear feedback. Move back to .quality only if real-device testing shows the
    // extra capture latency is acceptable. Never flip this per-capture at runtime.
    output.maxPhotoQualityPrioritization = .balanced

    // Enable Apple ProRAW capability on session output if supported on this hardware & OS
    if #available(iOS 14.3, *), output.isAppleProRAWSupported {
      output.isAppleProRAWEnabled = true
    }

    // WYSIWYG preview feed: capped 4:3 buffers rendered through the Camera DNA pipeline.
    if !session.outputs.contains(where: { $0 === videoOutput }) {
      videoOutput.videoSettings = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: 1280,
        kCVPixelBufferHeightKey as String: 960,
      ]
      videoOutput.alwaysDiscardsLateVideoFrames = true
      videoOutput.setSampleBufferDelegate(self, queue: renderQueue)
      if session.canAddOutput(videoOutput) {
        session.addOutput(videoOutput)
      }
    }
    CameraEngineView.setOrientation(on: videoOutput, photoOutput: output)

    session.commitConfiguration()
    camera = device
    configured = true
  }

  fileprivate func capture(completion: @escaping (Result<[String: Any], CameraEngineError>) -> Void) {
    sessionQueue.async {
      guard self.session.isRunning else { completion(.failure(.notRunning)); return }
      CameraTempFiles.removeUntrackedFiles()

      // Iteration 4: rapid shutter presses must not pile up unbounded ProRAW buffers.
      // A small in-flight cap keeps memory flat; the user gets an honest busy signal
      // instead of a crash or silent queue growth.
      guard self.captureDelegates.count < 3 else {
        completion(.failure(.captureBusy))
        return
      }

      // ProRAW is the preferred internal negative: request DNG only when the output truly
      // supports and has Apple ProRAW enabled. Devices without ProRAW must NOT be forced onto
      // plain Bayer RAW — they fall through to Apple's processed JPEG so the automatic
      // photography pipeline stays intact.
      var settings: AVCapturePhotoSettings?

      if #available(iOS 14.3, *), self.output.isAppleProRAWSupported && self.output.isAppleProRAWEnabled {
        let rawTypes = self.output.availableRawPhotoPixelFormatTypes
        if let firstRawType = rawTypes.first {
          // Request Apple ProRAW (DNG) alongside a companion processed representation
          settings = AVCapturePhotoSettings(rawPixelFormatType: firstRawType, processedFormat: [AVVideoCodecKey: AVVideoCodecType.jpeg])
        }
      }

      // Fallback: standard processed JPEG
      if settings == nil {
        settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
      }

      guard let photoSettings = settings else {
        completion(.failure(.captureFailed))
        return
      }

      photoSettings.photoQualityPrioritization = .balanced
      // Landscape-held captures must stay landscape in the photo library: rotate the capture
      // connection to the physical device orientation so buffers arrive already upright and
      // the saved JPEG needs no EXIF rotation fix-up.
      if let videoConnection = self.output.connection(with: .video) {
        if let orientation = CameraEngineView.currentDeviceOrientation() {
          videoConnection.videoOrientation = orientation
        }
      }
      // Shutter fidelity relies on .balanced prioritization + the ProRAW dual-format path.
      // NOTE: AVCapturePhotoSettings exposes no fast-capture toggle in this SDK; do not
      // re-add speculative API names without verifying against the actual headers.
      let id = photoSettings.uniqueID
      let delegate = PhotoCaptureDelegate(profile: self.profileSnapshot()) { [weak self] result in
        self?.sessionQueue.async { self?.captureDelegates.removeValue(forKey: id) }
        completion(result)
      }
      self.captureDelegates[id] = delegate
      self.output.capturePhoto(with: photoSettings, delegate: delegate)
    }
  }

  fileprivate func setAperture(_ fStop: Double, controller: ApertureController, completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    sessionQueue.async {
      guard let device = self.camera ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
        completion(.failure(.cameraUnavailable))
        return
      }
      controller.setAperture(fStop, on: device, completion: completion)
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
      DispatchQueue.main.async {
        completion(.success(["kind": kind, "deviceModel": device.localizedName]))
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

  fileprivate func capabilities(controller: ApertureController, completion: @escaping (Result<[String: Any], CameraEngineError>) -> Void) {
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      completion(.failure(.permissionDenied))
      return
    }
    sessionQueue.async {
      guard let device = self.camera ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
        completion(.failure(.cameraUnavailable)); return
      }

      let canQueryOutput = self.configured && self.session.outputs.contains { $0 === self.output }
      var proRaw = false
      if #available(iOS 14.3, *), canQueryOutput { proRaw = self.output.isAppleProRAWSupported }
      let rawSupported = canQueryOutput && !self.output.availableRawPhotoPixelFormatTypes.isEmpty

      var caps = controller.getCapabilities(device: device).asDictionary
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

// MARK: - WYSIWYG Preview Frame Pipeline
/// AVCaptureVideoDataOutput → CIImage → CameraDNARenderer(.preview) → MTKView.
/// One shared renderer with the capture path; no React Native–side per-frame work.
extension CameraEngineView: AVCaptureVideoDataOutputSampleBufferDelegate {
  public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    var image = CIImage(cvPixelBuffer: pixelBuffer)
    let profile = profileSnapshot()
    if !profile.isEmpty {
      image = CameraDNARenderer.apply(profile, to: image, mode: .preview)
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

    CameraEngineGPU.ciContext.render(
      fitted,
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

  static func load(_ rawName: String?) -> (dimension: Int, data: Data)? {
    guard let name = rawName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
    lock.lock(); defer { lock.unlock() }
    if let hit = cache[name] { return hit }
    guard let parsed = parseBundleLUT(named: name) else { return nil }
    cache[name] = parsed
    return parsed
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
      values.append(contentsOf: [r, g, b])
    }
    guard dimension >= 2, values.count == dimension * dimension * dimension * 3 else { return nil }
    return (dimension, Data(bytes: values, count: values.count * MemoryLayout<Float>.size))
  }
}

// MARK: - Temp File Management
private enum CameraTempFiles {
  private static let lock = NSLock()
  private static var current: Set<URL> = []

  static func makeURLs() -> (URL, URL) {
    let directory = FileManager.default.temporaryDirectory
    return (directory.appendingPathComponent("camera-engine-\(UUID().uuidString).jpg"),
            directory.appendingPathComponent("camera-engine-thumb-\(UUID().uuidString).jpg"))
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

// MARK: - Photo Capture Delegate (RAW / ProRAW + Processed Fallback)
private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
  private static let processingQueue = DispatchQueue(label: "camera-engine.photo-processing", qos: .userInitiated)
  // ponytail: static shared CIContext avoids allocating GPU command queue/shader cache per shutter press
  private static let sharedContext = CameraEngineGPU.ciContext
  private let profile: [String: Any]
  private let completion: (Result<[String: Any], CameraEngineError>) -> Void
  private let completionLock = NSLock()
  private var didComplete = false
  private var didAcceptPhoto = false
  private var generatedURLs: [URL] = []
  private var expectedPhotoCount = 1
  // Safety net (Iteration 4): in dual-format captures the companion Apple-processed photo is
  // retained so a Camera DNA / RAW pipeline failure can still save the capture. Photos must
  // never silently disappear. Guarded by completionLock.
  private var companionData: Data?

  init(profile: [String: Any], completion: @escaping (Result<[String: Any], CameraEngineError>) -> Void) {
    self.profile = profile
    self.completion = completion
  }

  func photoOutput(_ output: AVCapturePhotoOutput, willBeginCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings) {
    expectedPhotoCount = resolvedSettings.expectedPhotoCount
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    // Dual-format (RAW + processed) captures deliver two callbacks. Decide which one
    // we care about BEFORE inspecting its error, otherwise a failed companion
    // processed photo would abort an otherwise healthy RAW capture.
    let isRaw = photo.isRawPhoto
    if expectedPhotoCount > 1 && !isRaw {
      // Previously this callback was dropped entirely, so a failed RAW render lost the
      // whole capture even though a healthy processed photo existed. Keep it as fallback.
      if error == nil, let data = photo.fileDataRepresentation() {
        completionLock.lock(); companionData = data; completionLock.unlock()
      }
      return
    }

    // Never-lose-the-photo rule: if the RAW part failed at the source but this is a
    // dual-format capture, defer the decision — the companion processed photo may still
    // arrive and didFinishCaptureFor is guaranteed to run and deliver it.
    guard error == nil, let photoData = photo.fileDataRepresentation() else {
      if expectedPhotoCount > 1 {
        return
      }
      finish(.failure(.captureFailed))
      return
    }

    // A usable photo reached the pipeline. Record it so the didFinishCapture fallback
    // cannot race the asynchronous render started below.
    completionLock.lock(); didAcceptPhoto = true; completionLock.unlock()

    processCapturedData(photoData, metadata: photo.metadata, isRaw: isRaw, initialFallback: false)
  }

  /// Full-quality Camera DNA pipeline: render → EXIF-preserving JPEG → Photos.
  /// Runs exactly once per capture (guarded by hasCompleted inside finish).
  private func processCapturedData(_ photoData: Data, metadata: [AnyHashable: Any], isRaw: Bool, initialFallback: Bool) {
    Self.processingQueue.async { [self] in
      guard !hasCompleted else { return }

      // 1. RAW / ProRAW First vs Processed Fallback
      var renderedCIImage: CIImage?
      var usedFallback = initialFallback

      if isRaw {
        // Core Image official RAW rendering pipeline via CIRAWFilter
        renderedCIImage = CameraDNARenderer.renderRaw(data: photoData, profile: profile)
      }

      // Trust rule: if the Camera DNA / RAW pipeline failed but a companion processed
      // photo exists, save it untouched and report the fallback to the caller.
      if renderedCIImage == nil {
        completionLock.lock(); let companion = companionData; completionLock.unlock()
        if let companion = companion {
          renderedCIImage = CIImage(data: companion, options: [.applyOrientationProperty: true])
          usedFallback = renderedCIImage != nil
        }
      }

      // Fallback: if not RAW or CIRAWFilter fails to initialize from data, load standard processed CIImage
      if renderedCIImage == nil {
        guard let source = CIImage(data: photoData, options: [.applyOrientationProperty: true]) else {
          finish(.failure(.captureFailed))
          return
        }
        renderedCIImage = CameraDNARenderer.apply(profile, to: source, mode: .final)
      }

      guard var image = renderedCIImage else {
        finish(.failure(.processingFailed))
        return
      }

      let extent = image.extent.integral
      guard !extent.isNull, !extent.isInfinite, extent.width > 0, extent.height > 0,
            let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
        finish(.failure(.processingFailed))
        return
      }

      image = image.cropped(to: extent)
      let context = Self.sharedContext

      let (fileURL, thumbURL) = CameraTempFiles.makeURLs()
      completionLock.lock(); generatedURLs = [fileURL, thumbURL]; completionLock.unlock()

      do {
        guard let jpeg = Self.jpegRepresentation(image, metadata: metadata, colorSpace: colorSpace, quality: 0.95) else {
          throw CameraEngineError.processingFailed
        }
        try jpeg.write(to: fileURL, options: .atomic)
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
      requestPhotoLibraryAddAuthorization { granted in
        guard granted else { self.finish(.failure(.photoPermissionDenied)); return }
        guard !self.hasCompleted else { return }
        var localIdentifier: String?
        PHPhotoLibrary.shared().performChanges({
          let request = PHAssetCreationRequest.forAsset()
          request.addResource(with: .photo, fileURL: fileURL, options: nil)
          localIdentifier = request.placeholderForCreatedAsset?.localIdentifier
        }) { success, _ in
          guard success else { self.finish(.failure(.saveFailed)); return }
          CameraTempFiles.keep([fileURL, thumbURL])
          // The thumbnail the UI displays must survive restarts — serve the Documents
          // copy when persistence succeeds, fall back to the temp file otherwise.
          let thumbnailURI = CameraTempFiles.persistLatestThumbnail(from: thumbURL)?.absoluteString
            ?? thumbURL.absoluteString
          self.finish(.success([
            "fileUri": fileURL.absoluteString,
            "thumbnailUri": thumbnailURI,
            "assetLocalIdentifier": localIdentifier ?? NSNull(),
            "processingFallback": usedFallback
          ]))
        }
      }
    }
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
    completionLock.lock()
    let accepted = didAcceptPhoto
    let companion = companionData
    completionLock.unlock()

    // A photo already reached the render pipeline — its own path owns the outcome,
    // including the companion fallback inside the render stage. Never kill it here:
    // finishing with a failure while processing is in flight would silently drop a
    // photo that is about to be saved.
    if accepted { return }

    // RAW never delivered a usable photo, but the companion Apple-processed photo
    // did: save it untouched (marked as fallback) instead of losing the capture.
    if error == nil, let companion = companion {
      processCapturedData(companion, metadata: [:], isRaw: false, initialFallback: true)
      return
    }

    // Safety net: nothing usable ever arrived. Finish so the JS promise cannot hang
    // forever (shutter stuck disabled).
    finish(.failure(.captureFailed))
  }

  private var hasCompleted: Bool {
    completionLock.lock(); defer { completionLock.unlock() }; return didComplete
  }

  // Rendered pixels are already upright, so the original orientation tag is replaced with "1"
  // while every other real capture property (EXIF exposure data, timestamps, lens info) is
  // carried over untouched. CIContext.jpegRepresentation would drop all of it.
  private static func jpegRepresentation(_ image: CIImage, metadata: [AnyHashable: Any]?, colorSpace: CGColorSpace, quality: Double) -> Data? {
    guard let cgImage = sharedContext.createCGImage(image, from: image.extent, format: CIFormat.RGBA8, colorSpace: colorSpace) else { return nil }
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, "public.jpeg" as CFString, 1, nil) else { return nil }

    var properties = cfProperties(metadata)
    properties[kCGImageDestinationLossyCompressionQuality] = quality
    properties[kCGImagePropertyOrientation] = 1
    var exif = cfProperties(properties[kCGImagePropertyExifDictionary])
    exif.removeValue(forKey: kCGImagePropertyExifPixelXDimension)
    exif.removeValue(forKey: kCGImagePropertyExifPixelYDimension)
    properties[kCGImagePropertyExifDictionary] = exif
    var tiff = cfProperties(properties[kCGImagePropertyTIFFDictionary])
    tiff.removeValue(forKey: kCGImagePropertyTIFFOrientation)
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

  private func requestPhotoLibraryAddAuthorization(completion: @escaping (Bool) -> Void) {
    let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
    if status == .notDetermined {
      PHPhotoLibrary.requestAuthorization(for: .addOnly) { completion($0 == .authorized || $0 == .limited) }
    } else {
      completion(status == .authorized || status == .limited)
    }
  }

  private func finish(_ result: Result<[String: Any], CameraEngineError>) {
    completionLock.lock()
    guard !didComplete else { completionLock.unlock(); return }
    didComplete = true
    let urls = generatedURLs
    completionLock.unlock()
    if case .failure = result { CameraTempFiles.remove(urls) }
    DispatchQueue.main.async { self.completion(result) }
  }
}

// MARK: - Unified Camera DNA Renderer
/// ONE renderer for preview and final output (WYSIWYG contract):
///   shared stages:  LUT, exposure, tone curve/black point, color, hue bands, vignette
///   final-only:     detail/deharsh, full grain, halation
private enum CameraDNARenderer {
  enum RenderMode {
    /// Live viewfinder frames: shared color stages only.
    case preview
    /// Captured photos: everything, including the heavier texture stages.
    case final
  }

  private static let bandNames = ["red", "orange", "yellow", "green", "cyan", "blue", "magenta"]
  private static let bandCenters: [Double] = [0, 30, 60, 120, 180, 240, 300]

  /// CIRAWFilter based RAW / ProRAW development.
  /// Maps Camera DNA raw parameters (sharpness, detail, localToneMap, NR) directly to CIRAWFilter properties.
  static func renderRaw(data: Data, profile: [String: Any]) -> CIImage? {
    let rawDict = dictionary(profile["raw"])

    var rawFilter: CIFilter?
    if #available(iOS 15.0, *) {
      rawFilter = CIRAWFilter(imageData: data, identifierHint: nil)
    }
    if rawFilter == nil {
      // Fallback to CIRAWFilter factory using data
      rawFilter = CIFilter(name: "CIRAWFilter", parameters: ["inputImageData": data])
    }

    guard let filter = rawFilter else { return nil }

    let sharpness = number(rawDict, "sharpness", 0.3, 0...1)
    let detail = number(rawDict, "detail", 0.4, 0...1)
    let localTone = number(rawDict, "localToneMap", 0.2, 0...1)
    let lumNR = number(rawDict, "luminanceNoiseReduction", 0.2, 0...1)
    let colNR = number(rawDict, "colorNoiseReduction", 0.3, 0...1)

    // Apply official CIRAWFilter keys where supported by the underlying camera RAW decoder
    let supportedKeys = Set(filter.inputKeys)

    // 1. Sharpness & Detail: low artificial edge sharpening + preserving fine texture
    if supportedKeys.contains("inputSharpness") {
      filter.setValue(sharpness, forKey: "inputSharpness")
    }
    if supportedKeys.contains("inputDetailAmount") {
      filter.setValue(detail, forKey: "inputDetailAmount")
    }

    // 2. Local Tone Mapping
    if supportedKeys.contains("inputLocalToneMapAmount") {
      filter.setValue(localTone, forKey: "inputLocalToneMapAmount")
    }

    // 3. Noise Reduction (Luminance & Color)
    if supportedKeys.contains("inputLuminanceNoiseReductionAmount") {
      filter.setValue(lumNR, forKey: "inputLuminanceNoiseReductionAmount")
    }
    if supportedKeys.contains("inputColorNoiseReductionAmount") {
      filter.setValue(colNR, forKey: "inputColorNoiseReductionAmount")
    }

    // 4. Boost amount: keep natural linear baseline
    if supportedKeys.contains("inputBoostAmount") {
      filter.setValue(0.0, forKey: "inputBoostAmount")
    }

    guard let rawOutput = filter.outputImage else { return nil }

    // Run remaining unified Camera DNA stages: Tone, Color, Hue Bands, Texture
    return CameraDNARenderer.apply(profile, to: rawOutput, mode: .final, isRawSource: true)
  }

  /// Unified rendering pipeline for all cameras.
  /// Source → [final: detail] → Exposure → Tone → Color → Hue Bands → LUT → Vignette → [final: texture]
  static func apply(_ profile: [String: Any], to source: CIImage, mode: RenderMode = .final, isRawSource: Bool = false) -> CIImage {
    let raw = dictionary(profile["raw"])
    let tone = dictionary(profile["tone"])
    let color = dictionary(profile["color"])
    let texture = dictionary(profile["texture"])
    let grain = dictionary(texture["grain"])
    let vignette = dictionary(texture["vignette"])
    let halation = dictionary(texture["halation"])
    var image = source

    // Detail & Deharsh (FINAL-ONLY): softened sharpening / local tone. The live preview
    // skips these — per-frame convolution is wasted at preview resolution and the film
    // character lives in the shared color stages.
    if mode == .final && !isRawSource {
      let luminanceNR = number(raw, "luminanceNoiseReduction", 0, 0...1)
      let colorNR = number(raw, "colorNoiseReduction", 0, 0...1)
      if luminanceNR > 0 || colorNR > 0 {
        image = filter("CINoiseReduction", image, [
          "inputNoiseLevel": 0.005 + (luminanceNR * 0.08) + (colorNR * 0.025),
          "inputSharpness": max(0, 0.4 - luminanceNR * 0.3)
        ])
      }
      let sharpness = number(raw, "sharpness", 0, 0...1)
      if sharpness > 0 {
        image = filter("CISharpenLuminance", image, [kCIInputSharpnessKey: sharpness * 1.2])
      }
      let detail = number(raw, "detail", 0, 0...1)
      if detail > 0 {
        image = filter("CIUnsharpMask", image, [kCIInputRadiusKey: 1.0 + detail * 2.0, kCIInputIntensityKey: detail * 0.8])
      }
      let localTone = number(raw, "localToneMap", 0, 0...1)
      if localTone > 0 {
        image = filter("CIHighlightShadowAdjust", image, ["inputHighlightAmount": 1.0 - localTone * 0.35, "inputShadowAmount": localTone * 0.55])
      }
    }

    // Tone: exposure, contrast, black point, five-point tone curve
    image = filter("CIExposureAdjust", image, [kCIInputEVKey: number(tone, "exposure", 0, -5...5)])
    image = filter("CIColorControls", image, [kCIInputSaturationKey: 1.0, kCIInputContrastKey: number(tone, "contrast", 1, 0...4), kCIInputBrightnessKey: 0.0])
    let blackPoint = number(tone, "blackPoint", 0, 0...0.95)
    if blackPoint > 0 {
      let scale = 1.0 / (1.0 - blackPoint)
      image = filter("CIColorMatrix", image, [
        "inputRVector": CIVector(x: CGFloat(scale), y: 0, z: 0, w: 0),
        "inputGVector": CIVector(x: 0, y: CGFloat(scale), z: 0, w: 0),
        "inputBVector": CIVector(x: 0, y: 0, z: CGFloat(scale), w: 0),
        "inputBiasVector": CIVector(x: CGFloat(-blackPoint * scale), y: CGFloat(-blackPoint * scale), z: CGFloat(-blackPoint * scale), w: 0)
      ])
    }
    if let points = toneCurve(tone["curve"]) {
      image = filter("CIToneCurve", image, Dictionary(uniqueKeysWithValues: points.enumerated().map { ("inputPoint\($0.offset)", $0.element) }))
    }

    // Global color. Temperature is offset from 6500 K neutral
    image = filter("CIColorControls", image, [kCIInputSaturationKey: number(color, "saturation", 1, 0...4), kCIInputContrastKey: 1.0, kCIInputBrightnessKey: 0.0])
    let targetTemperature = min(12_000, max(2_000, 6_500 + number(color, "temperature", 0, -4_500...5_500)))
    let tint = number(color, "tint", 0, -200...200)
    if targetTemperature != 6_500 || tint != 0 {
      image = filter("CITemperatureAndTint", image, [
        "inputNeutral": CIVector(x: 6500, y: 0),
        "inputTargetNeutral": CIVector(x: CGFloat(targetTemperature), y: CGFloat(tint))
      ])
    }

    // 7-Band Hue adjustments through color cube
    if let cube = hueBandCube(dictionary(color["hueBands"])) {
      image = filter("CIColorCube", image, ["inputCubeDimension": cube.dimension, "inputCubeData": cube.data])
    }

    // SHARED: camera-character LUT (.cube, Camera18_LUT_V0 pack) — applied identically in
    // preview and final so both outputs share the same color DNA. `lutIntensity` (0..1,
    // default 1) holds a calibrated look back over the tone-mapped base so characters
    // layer without a cheap full-strength filter feel.
    if let lutName = color["lut"] as? String, let cube = LUTLoader.load(lutName) {
      let luted = filter("CIColorCubeWithColorSpace", image, [
        "inputCubeDimension": cube.dimension,
        "inputCubeData": cube.data,
        "inputColorSpace": CameraEngineGPU.sRGBColorSpace,
      ])
      let intensity = number(color, "lutIntensity", 1, 0...1)
      if intensity < 0.999 {
        let faded = filter("CIColorMatrix", luted, ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(intensity))])
        image = filter("CISourceOverCompositing", faded, [kCIInputBackgroundImageKey: image])
      } else {
        image = luted
      }
    }

    // SHARED: vignette
    let vignetteAmount = number(vignette, "amount", 0, 0...1)
    if vignetteAmount > 0 {
      // CIVignette's inputRadius is a normalized scale (~0.5–2 useful); the JSON value is a 0–1
      // fraction where larger = falloff starts farther from the center = weaker vignette.
      let radius = 0.5 + number(vignette, "radius", 0.75, 0...1)
      image = filter("CIVignette", image, [kCIInputIntensityKey: vignetteAmount * 2.0, kCIInputRadiusKey: radius])
    }

    // FINAL-ONLY texture: full-strength grain and halation. The preview skips them (they are
    // heavy per-frame convolutions); the saved photo carries the complete film texture.
    if mode == .final {
      let grainAmount = number(grain, "amount", 0, 0...1)
      if grainAmount > 0, var noise = CIFilter(name: "CIRandomGenerator")?.outputImage {
        let grainSize = number(grain, "size", 0.25, 0...1)
        let scale = CGFloat(0.5 + grainSize * 3.5)
        noise = noise.transformed(by: CGAffineTransform(scaleX: scale, y: scale)).cropped(to: image.extent)
        let mono = filter("CIColorControls", noise, [kCIInputSaturationKey: 0.0, kCIInputContrastKey: 1.0 + grainAmount * 2.0, kCIInputBrightnessKey: 0.0])
        let faded = filter("CIColorMatrix", mono, ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(grainAmount * 0.35))])
        image = filter("CISoftLightBlendMode", faded, [kCIInputBackgroundImageKey: image]).cropped(to: image.extent)
      }
      let halationAmount = number(halation, "amount", 0, 0...1)
      if halationAmount > 0 {
        let highlights = filter("CIColorControls", image, [kCIInputSaturationKey: 0.0, kCIInputContrastKey: 3.0, kCIInputBrightnessKey: -0.5])
        let warm = filter("CIColorMatrix", highlights, [
          "inputRVector": CIVector(x: 1.0, y: 0, z: 0, w: 0),
          "inputGVector": CIVector(x: 0, y: 0.35, z: 0, w: 0),
          "inputBVector": CIVector(x: 0, y: 0, z: 0.12, w: 0),
          "inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(halationAmount * 0.65))
        ])
        let radius = 2.0 + number(halation, "radius", 0.2, 0...1) * 38.0
        let glow = filter("CIGaussianBlur", warm, [kCIInputRadiusKey: radius]).cropped(to: image.extent)
        image = filter("CIScreenBlendMode", glow, [kCIInputBackgroundImageKey: image]).cropped(to: image.extent)
      }

      // Starburst (FINAL-ONLY): point lights only. Highlight cut-in → multi-direction
      // motion blur → screen back. Plain walls/skin/sky stay below the threshold and
      // never streak. Strength is aperture-linked from the JS layer (ApertureVisualProfile):
      // near-absent wide open, strongest stopped down.
      let starburst = dictionary(texture["starburst"])
      let starStrength = number(starburst, "strength", 0, 0...1)
      if starStrength > 0.001 {
        let threshold = number(starburst, "threshold", 0.78, 0...1)
        if threshold < 0.995 {
          let cutScale = CGFloat(1.0 / max(0.05, 1.0 - threshold))
          let cutBias = CGFloat(-threshold * cutScale)
          var cut = filter("CIColorMatrix", image, [
            "inputRVector": CIVector(x: cutScale, y: 0, z: 0, w: 0),
            "inputGVector": CIVector(x: 0, y: cutScale, z: 0, w: 0),
            "inputBVector": CIVector(x: 0, y: 0, z: cutScale, w: 0),
            "inputBiasVector": CIVector(x: cutBias, y: cutBias, z: cutBias, w: 0)
          ])
          cut = filter("CIColorClamp", cut, [
            "inputMinComponents": CIVector(x: 0, y: 0, z: 0, w: 0),
            "inputMaxComponents": CIVector(x: 1, y: 1, z: 1, w: 1)
          ])
          // Visible ray points = 2 per blur direction (4-ray = cross, 6, 8 …).
          let directions = max(2, min(4, Int(number(starburst, "rays", 4, 4...8)) / 2))
          let streakRadius = CGFloat(6.0 + number(starburst, "length", 0.3, 0...1) * 55.0)
          var streaks: CIImage? = nil
          for i in 0..<directions {
            let angle = CGFloat(Double(i) * Double.pi / Double(directions))
            let ray = filter("CIMotionBlur", cut, [kCIInputAngleKey: angle, kCIInputRadiusKey: streakRadius]).cropped(to: image.extent)
            streaks = streaks.map { filter("CIScreenBlendMode", ray, [kCIInputBackgroundImageKey: $0]) } ?? ray
          }
          if let streaks = streaks {
            let faded = filter("CIColorMatrix", streaks, ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(starStrength * 0.85))])
            image = filter("CIScreenBlendMode", faded, [kCIInputBackgroundImageKey: image]).cropped(to: image.extent)
          }
        }
      }
    }

    return image.cropped(to: source.extent)
  }

  private static func dictionary(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }

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
