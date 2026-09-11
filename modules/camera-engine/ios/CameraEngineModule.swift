import ExpoModulesCore
import AVFoundation
import Photos
import CoreImage
import CoreFoundation
import ImageIO
import UIKit

fileprivate enum CameraEngineError: String, Error {
  case noActiveView = "ERR_NO_ACTIVE_VIEW"
  case permissionDenied = "ERR_PERMISSION_DENIED"
  case photoPermissionDenied = "ERR_PHOTO_PERMISSION_DENIED"
  case cameraUnavailable = "ERR_CAMERA_UNAVAILABLE"
  case configurationFailed = "ERR_CONFIGURATION_FAILED"
  case notRunning = "ERR_NOT_RUNNING"
  case captureFailed = "ERR_CAPTURE_FAILED"
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
    case .processingFailed: return "The image profile could not be rendered."
    case .saveFailed: return "The photo could not be saved to the photo library."
    case .apertureUnsupported: return "Variable aperture is not available through a supported public API on this device."
    }
  }
}

// MARK: - Aperture Controller Abstraction
/// Manages variable aperture runtime discovery and hardware control via official public APIs only.
/// On devices without variable aperture support (or until future SDKs expose Apple public APIs),
/// it safely and honestly reports supportsVariableAperture = false and rejects setAperture calls.
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

  /// Inspect runtime device capabilities using official public AVFoundation properties.
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

    let activeLensAperture = Double(device.lensAperture)

    // TODO: Verify on iPhone 18 Pro once official Apple public API is available in future iOS SDK.
    // We intentionally never use private APIs, KVC, or guess undocumented selectors.
    // For now, honestly report supportsVariableAperture = false.
    return Capabilities(
      supportsVariableAperture: false,
      minAperture: nil,
      maxAperture: nil,
      activeAperture: activeLensAperture,
      supportedApertures: nil,
      deviceModel: device.localizedName
    )
  }

  /// Attempts to set hardware variable aperture on the active device.
  /// Rejects on unsupported devices or until verified public API exists.
  func setAperture(_ fStop: Double, on device: AVCaptureDevice?, completion: @escaping (Result<Void, CameraEngineError>) -> Void) {
    guard let _ = device else {
      completion(.failure(.cameraUnavailable))
      return
    }

    // TODO: Connect to official Apple public API for iPhone 18 Pro variable aperture.
    // Do not fake success; reject with apertureUnsupported so UI/caller can fallback gracefully.
    completion(.failure(.apertureUnsupported))
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

    AsyncFunction("getCapabilities") { (promise: Promise) in
      guard let view = self.activeView else { self.reject(promise, .noActiveView); return }
      view.capabilities(controller: self.apertureController) { result in
        self.settle(result, promise)
      }
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
  private var captureDelegates: [Int64: PhotoCaptureDelegate] = [:]
  private lazy var previewLayer: AVCaptureVideoPreviewLayer = {
    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    return layer
  }()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    layer.addSublayer(previewLayer)
    Self.registrationHandler?(self, true)
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    Self.registrationHandler?(self, window != nil)
  }

  deinit {
    Self.registrationHandler?(self, false)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
  }

  fileprivate func setProfile(_ value: [String: Any]) {
    profileLock.lock(); profile = value; profileLock.unlock()
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
          completion(.success(true))
        } catch let error as CameraEngineError { completion(.failure(error)) }
        catch { completion(.failure(.configurationFailed)) }
      }
    }
  }

  fileprivate func stop(completion: @escaping () -> Void) {
    sessionQueue.async {
      if self.session.isRunning { self.session.stopRunning() }
      completion()
    }
  }

  private func configureSession() throws {
    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
      throw CameraEngineError.cameraUnavailable
    }

    // Configure the device before touching the session so a lock failure leaves no partial graph.
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
      if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
      if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { device.whiteBalanceMode = .continuousAutoWhiteBalance }
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

    var addedInput: AVCaptureInput?
    var addedOutput = false
    session.beginConfiguration()
    session.sessionPreset = .photo
    if needsInput { session.addInput(input); addedInput = input }
    if needsOutput { session.addOutput(output); addedOutput = true }
    output.maxPhotoQualityPrioritization = .quality

    // Enable Apple ProRAW capability on session output if supported on this hardware & OS
    if #available(iOS 14.3, *), output.isAppleProRAWSupported {
      output.isAppleProRAWEnabled = true
    }

    session.commitConfiguration()
    camera = device
    configured = true
  }

  fileprivate func capture(completion: @escaping (Result<[String: Any], CameraEngineError>) -> Void) {
    sessionQueue.async {
      guard self.session.isRunning else { completion(.failure(.notRunning)); return }
      CameraTempFiles.removeOlderFiles()

      // RAW / ProRAW priority:
      // Check whether Apple ProRAW or a RAW pixel format is available on this AVCapturePhotoOutput.
      var settings: AVCapturePhotoSettings?

      if #available(iOS 14.3, *), self.output.isAppleProRAWSupported && self.output.isAppleProRAWEnabled {
        let rawTypes = self.output.availableRawPhotoPixelFormatTypes
        if let firstRawType = rawTypes.first {
          // Request Apple ProRAW (DNG) alongside an embedded/processed thumbnail representation
          settings = AVCapturePhotoSettings(rawPixelFormatType: firstRawType, processedFormat: [AVVideoCodecKey: AVVideoCodecType.jpeg])
        }
      }

      // If ProRAW is not supported or not enabled, try standard Bayer RAW if available
      if settings == nil {
        let rawTypes = self.output.availableRawPhotoPixelFormatTypes
        if let firstRawType = rawTypes.first {
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

      photoSettings.photoQualityPrioritization = .quality
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

  static func keep(_ urls: [URL]) { lock.lock(); current = Set(urls); lock.unlock() }
  static func remove(_ urls: [URL]) { urls.forEach { try? FileManager.default.removeItem(at: $0) } }
  static func removeOlderFiles() {
    lock.lock(); let kept = current; current.removeAll(); lock.unlock()
    let files = (try? FileManager.default.contentsOfDirectory(at: FileManager.default.temporaryDirectory, includingPropertiesForKeys: nil)) ?? []
    remove(files.filter { $0.lastPathComponent.hasPrefix("camera-engine-") && !kept.contains($0) })
    remove(Array(kept))
  }
}

// MARK: - Photo Capture Delegate (RAW / ProRAW + Processed Fallback)
private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
  private static let processingQueue = DispatchQueue(label: "camera-engine.photo-processing", qos: .userInitiated)
  // ponytail: static shared CIContext avoids allocating GPU command queue/shader cache per shutter press
  private static let sharedContext = CIContext(options: [.cacheIntermediates: false])
  private let profile: [String: Any]
  private let completion: (Result<[String: Any], CameraEngineError>) -> Void
  private let completionLock = NSLock()
  private var didComplete = false
  private var didAcceptPhoto = false
  private var generatedURLs: [URL] = []
  private var expectedPhotoCount = 1

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
    if expectedPhotoCount > 1 && !isRaw { return }

    // ponytail: a RAW failure still aborts the capture instead of falling back to the
    // companion processed JPEG; that fallback is a product decision, not implemented.
    guard error == nil, let photoData = photo.fileDataRepresentation() else {
      finish(.failure(.captureFailed))
      return
    }

    // A usable photo reached the pipeline. Record it so the didFinishCapture fallback
    // cannot race the asynchronous render started below.
    completionLock.lock(); didAcceptPhoto = true; completionLock.unlock()

    Self.processingQueue.async { [self] in
      guard !hasCompleted else { return }

      // 1. RAW / ProRAW First vs Processed Fallback
      var renderedCIImage: CIImage?

      if isRaw {
        // Core Image official RAW rendering pipeline via CIRAWFilter
        renderedCIImage = ProfileRenderer.renderRaw(data: photoData, profile: profile)
      }

      // Fallback: if not RAW or CIRAWFilter fails to initialize from data, load standard processed CIImage
      if renderedCIImage == nil {
        guard let source = CIImage(data: photoData, options: [.applyOrientationProperty: true]) else {
          finish(.failure(.captureFailed))
          return
        }
        renderedCIImage = ProfileRenderer.apply(profile, to: source)
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
      guard let jpeg = context.jpegRepresentation(of: image, colorSpace: colorSpace, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.95]) else {
        finish(.failure(.processingFailed))
        return
      }

      let (fileURL, thumbURL) = CameraTempFiles.makeURLs()
      completionLock.lock(); generatedURLs = [fileURL, thumbURL]; completionLock.unlock()

      do {
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
          self.finish(.success([
            "fileUri": fileURL.absoluteString,
            "thumbnailUri": thumbURL.absoluteString,
            "assetLocalIdentifier": localIdentifier ?? NSNull()
          ]))
        }
      }
    }
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
    if error != nil { finish(.failure(.captureFailed)); return }
    // Safety net: when no usable photo ever reached the pipeline, nothing else will
    // call finish and the JS promise would hang forever (shutter stuck disabled).
    guard !didAcceptAnyPhoto else { return }
    finish(.failure(.captureFailed))
  }

  private var hasCompleted: Bool {
    completionLock.lock(); defer { completionLock.unlock() }; return didComplete
  }

  private var didAcceptAnyPhoto: Bool {
    completionLock.lock(); defer { completionLock.unlock() }; return didAcceptPhoto
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

// MARK: - Unified Camera DNA Profile Renderer
private enum ProfileRenderer {
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
    return apply(profile, to: rawOutput, isRawSource: true)
  }

  /// Unified rendering pipeline for all cameras.
  /// RAW / Source -> Tone / Detail -> Tone Curve -> Color -> Hue Bands -> Texture -> Output
  static func apply(_ profile: [String: Any], to source: CIImage, isRawSource: Bool = false) -> CIImage {
    let raw = dictionary(profile["raw"])
    let tone = dictionary(profile["tone"])
    let color = dictionary(profile["color"])
    let texture = dictionary(profile["texture"])
    let grain = dictionary(texture["grain"])
    let vignette = dictionary(texture["vignette"])
    let halation = dictionary(texture["halation"])
    var image = source

    // Detail & Noise Handling:
    // If not already developed via CIRAWFilter, apply conservative Core Image filters
    if !isRawSource {
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

    // Texture: Grain, Vignette, Halation
    let grainAmount = number(grain, "amount", 0, 0...1)
    if grainAmount > 0, var noise = CIFilter(name: "CIRandomGenerator")?.outputImage {
      let grainSize = number(grain, "size", 0.25, 0...1)
      let scale = CGFloat(0.5 + grainSize * 3.5)
      noise = noise.transformed(by: CGAffineTransform(scaleX: scale, y: scale)).cropped(to: image.extent)
      let mono = filter("CIColorControls", noise, [kCIInputSaturationKey: 0.0, kCIInputContrastKey: 1.0 + grainAmount * 2.0, kCIInputBrightnessKey: 0.0])
      let faded = filter("CIColorMatrix", mono, ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(grainAmount * 0.35))])
      image = filter("CISoftLightBlendMode", faded, [kCIInputBackgroundImageKey: image]).cropped(to: image.extent)
    }
    let vignetteAmount = number(vignette, "amount", 0, 0...1)
    if vignetteAmount > 0 {
      let radius = number(vignette, "radius", 0.75, 0...1) * Double(min(image.extent.width, image.extent.height)) * 0.5
      image = filter("CIVignette", image, [kCIInputIntensityKey: vignetteAmount * 2.0, kCIInputRadiusKey: radius])
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
