import io
p = r'C:\Users\zh95\Desktop\camera18\camera_ccd\modules\camera-engine\ios\CameraEngineModule.swift'
s = io.open(p, encoding='utf-8').read()
n = 0
def rep(old, new, tag):
    global s, n
    assert old in s, tag
    s = s.replace(old, new, 1)
    n += 1

# 1. capabilities: mode strings + remove simulated range block + spec comment
rep("""      // UNIFIED APERTURE: resolve the mode from capability and expose it. In simulated
      // mode the RING still spans f/1.4-f/16 (the simulation grid) so the UI stays a
      // working aperture control; supportsVariableAperture remains the PHYSICAL truth.
      let apertureMode = controller.capabilityMode(for: device)
      controller.mode = apertureMode
      self.apertureMode = apertureMode
      caps["apertureMode"] = apertureMode == .physical ? "physical" : "simulated"
      if apertureMode == .simulated {
        caps["minAperture"] = 1.4
        caps["maxAperture"] = 4.0
        caps["supportedApertures"] = NSNull()
      }""",
"""      // UNIFIED APERTURE: resolve the mode from capability and expose it. .fixed lenses
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
      }""", "capabilities")

# 2. view fields
rep("""  fileprivate var apertureMode: ApertureMode = .simulated
  fileprivate var simulatedFNumber: Float = 1.8""",
"""  fileprivate var apertureMode: ApertureMode = .fixed""", "view fields")

# 3. setAperture sync line
rep("""          self.simulatedFNumber = controller.simulatedFNumber
""", "", "sync line")

# 4. KVO slider branch
rep("""      if let controller = apertureControllerRef {
        if controller.mode == .physical {
          controller.requestCoalescedPhysicalAperture(Float(value), on: camera) { _ in }
        } else {
          controller.setAperture(Float(value), on: camera) { _ in }
        }
      }
      simulatedFNumber = Float(value)""",
"""      if let controller = apertureControllerRef, controller.mode == .variable,
         let device = camera {
        controller.requestCoalescedPhysicalAperture(Float(value), on: device) { _ in }
      }""", "kvo branch")

# 5. refreshApertureCapabilities clamp + print
rep("""      if mode == .simulated {
        self.simulatedFNumber = min(4.0, max(1.4, self.simulatedFNumber))
      }
      print("[CameraEngine][Diag] aperture capability refresh: mode=\\(mode == .physical ? "physical" : "simulated") device=\\(device.localizedName)")""",
"""      print("[CameraEngine][Diag] aperture capability refresh: mode=\\(mode == .variable ? "variable" : "fixed") device=\\(device.localizedName)")""", "refresh")

# 6. preview starburst block
rep("""    // SIMULATED APERTURE (preview): starburst only (no Vision per frame - user spec).
    // Same StarburstProcessor as the final photo, at 1280px.
    if apertureMode == .simulated {
      image = StarburstProcessor.apply(image, fNumber: simulatedFNumber)
    }
""", "", "preview star")

# 7. delegate fields
rep("""  private let compiled: CameraDNARenderer.CompiledCameraProfile?
  // Simulated-aperture inputs (capability-driven; physical mode ignores both).
  private let apertureMode: ApertureMode
  private let simulatedFNumber: Float""",
"""  private let compiled: CameraDNARenderer.CompiledCameraProfile?""", "delegate fields")

# 8. delegate init
rep("""  init(compiled: CameraDNARenderer.CompiledCameraProfile?, appliedZoom: Double, equivalentFocalMM: Int, apertureMode: ApertureMode = .simulated, simulatedFNumber: Float = 1.8, completion: @escaping (Result<[String: Any], CameraEngineError>, String?) -> Void) {
    self.compiled = compiled
    self.apertureMode = apertureMode
    self.simulatedFNumber = simulatedFNumber""",
"""  init(compiled: CameraDNARenderer.CompiledCameraProfile?, appliedZoom: Double, equivalentFocalMM: Int, completion: @escaping (Result<[String: Any], CameraEngineError>, String?) -> Void) {
    self.compiled = compiled""", "delegate init")

# 9. delegate pipeline
rep("""      // PRODUCTION ORDER (user-fixed): simulated aperture FIRST, then Camera DNA / LUT.
      var image = source
      if apertureMode == .simulated {
        image = ApertureSimulationProcessor.apply(image, fNumber: simulatedFNumber)
      }
      // Compiled final pipeline (processed-photo normalizer + LUT + fine color + tone).
      // compiled == nil \u2192 true passthrough (no profile applied yet).
      if let compiled = compiled {
        image = CameraDNARenderer.apply(compiled, to: image)
      }""",
"""      // Compiled final pipeline (processed-photo normalizer + LUT + fine color + tone).
      // compiled == nil \u2192 true passthrough (no profile applied yet).
      var image = source
      if let compiled = compiled {
        image = CameraDNARenderer.apply(compiled, to: image)
      }""", "delegate pipeline")

# 10. delegate construction call
rep("""        appliedZoom: appliedZoom,
        equivalentFocalMM: equivalentFocalMM,
        apertureMode: self.apertureMode,
        simulatedFNumber: self.simulatedFNumber,
      )""",
"""        appliedZoom: appliedZoom,
        equivalentFocalMM: equivalentFocalMM,
      )""", "delegate call")

# 11. Camera Control aperture slider: only on .variable lenses
rep("""      if let controller = apertureControllerRef else {
      print("[CameraEngine][Diag] Camera Control: controller not attached yet")
      return
    }
    guard session.supportsControls else {""",
"""      guard let controller = apertureControllerRef else {
      print("[CameraEngine][Diag] Camera Control: controller not attached yet")
      return
    }
    guard session.supportsControls else {""", "noop keep")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print(f'applied {n}')
