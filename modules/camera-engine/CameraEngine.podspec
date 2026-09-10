Pod::Spec.new do |s|
  s.name           = 'CameraEngine'
  s.version        = '0.1.0'
  s.summary        = 'Local Expo camera engine module'
  s.description    = 'AVFoundation camera preview, profiled JPEG capture, and Photo Library export.'
  s.author         = 'Local'
  s.homepage       = 'https://localhost'
  s.platforms      = { :ios => '15.0' }
  # The module is consumed as a local development pod; CocoaPods does not fetch this source.
  s.source         = { :git => '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.source_files   = 'ios/**/*.{h,m,mm,swift}'
  s.frameworks     = 'AVFoundation', 'Photos', 'CoreImage', 'ImageIO', 'UIKit'
  s.dependency 'ExpoModulesCore'
end
