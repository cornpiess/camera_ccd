p = 'src/camera/CameraEngine.tsx'
s = open(p, encoding='utf-8').read()
old = """): NativeEventSubscription => typed(requireNativeModule('CameraEngine').addListener('onApertureChanged', cb));"""
new = """): NativeEventSubscription => requireNativeModule('CameraEngine').addListener('onApertureChanged', cb) as { readonly remove: () => void };"""
assert old in s, "a"
s = s.replace(old, new, 1)
old = """): NativeEventSubscription => typed(requireNativeModule('CameraEngine').addListener('onZoomChanged', cb));"""
new = """): NativeEventSubscription => requireNativeModule('CameraEngine').addListener('onZoomChanged', cb) as { readonly remove: () => void };"""
assert old in s, "b"
s = s.replace(old, new, 1)
old = """    setZoomFactor,
  }), []);"""
new = """    setZoomFactor,
    addApertureChangedListener,
    addZoomChangedListener,
  }), []);"""
assert old in s, "c"
s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
