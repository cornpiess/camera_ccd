p = 'src/camera/CameraEngine.tsx'
s = open(p, encoding='utf-8').read()

# 1. use requireNativeModule directly (the typed NativeModule instance is created below)
old = """): NativeEventSubscription => CameraEngineModule.addListener('onApertureChanged', cb);"""
new = """): NativeEventSubscription => typed(requireNativeModule('CameraEngine').addListener('onApertureChanged', cb));"""
assert old in s
s = s.replace(old, new, 1)
old = """): NativeEventSubscription => CameraEngineModule.addListener('onZoomChanged', cb);"""
new = """): NativeEventSubscription => typed(requireNativeModule('CameraEngine').addListener('onZoomChanged', cb));"""
assert old in s
s = s.replace(old, new, 1)

# 2. NativeCameraEngine interface: declare the two listener methods
old = """  /** Crop zoom (videoZoomFactor) on the ACTIVE lens; >=1, applies to preview AND capture. */
  setZoomFactor(factor: number): Promise<void>;
};"""
new = """  /** Crop zoom (videoZoomFactor) on the ACTIVE lens; >=1, applies to preview AND capture. */
  setZoomFactor(factor: number): Promise<void>;
  addApertureChangedListener(
    cb: (event: { readonly fNumber: number }) => void,
  ): { readonly remove: () => void };
  addZoomChangedListener(
    cb: (event: { readonly zoom: number }) => void,
  ): { readonly remove: () => void };
};"""
assert old in s
s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
