Pod::Spec.new do |s|
  s.name           = 'Monetization'
  s.version        = '0.1.0'
  s.summary        = 'Local Expo monetization module'
  s.description    = 'StoreKit 2 subscriptions (Camera 18 Pro) and the Keychain-backed premium-camera trial shot store.'
  s.author         = 'Local'
  s.homepage       = 'https://localhost'
  s.platforms      = { :ios => '15.0' }
  # The module is consumed as a local development pod; CocoaPods does not fetch this source.
  s.source         = { :git => '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.source_files   = 'ios/**/*.{h,m,mm,swift}'
  s.frameworks     = 'StoreKit', 'Security', 'UIKit'
  s.dependency 'ExpoModulesCore'
end
