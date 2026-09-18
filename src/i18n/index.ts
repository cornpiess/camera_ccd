import { NativeModules } from 'react-native';

/**
 * Minimal two-language i18n (en-first for the US market, zh secondary).
 *
 * - Language resolves ONCE at module load from the iOS system settings
 *   (SettingsManager.AppleLocale / AppleLanguages); there is deliberately no in-app
 *   switcher — the app follows the system like the built-in Camera.
 * - English is the fallback for every other locale.
 * - `t()` is a plain function (no React context): strings are static per launch and
 *   every surface (components, plain helpers like resolveErrorMessage) can use it.
 * - Developer-only surfaces (⚙ profile settings sheet, three-finger calibration
 *   console, StartupErrorBoundary) stay English-only on purpose — they are test tooling.
 * - Legal pages are served from the project's GitHub Pages; the links themselves are
 *   language-neutral until localized pages exist.
 */
export type Lang = 'en' | 'zh';

function detectLang(): Lang {
  try {
    const settings = NativeModules.SettingsManager?.settings as
      | { AppleLocale?: string; AppleLanguages?: readonly string[] }
      | undefined;
    const raw = settings?.AppleLocale ?? settings?.AppleLanguages?.[0];
    if (raw && /^zh/i.test(raw)) return 'zh';
  } catch {
    // Detection is best-effort; English (the primary market) is the fallback.
  }
  return 'en';
}

export const appLang: Lang = detectLang();

const en = {
  // Shutter / pipeline errors (user language, never AVCapture domains)
  errPhotoPermissionDenied: "Couldn't save the photo — allow photo access in Settings.",
  errCaptureBusy: 'Still processing the previous photo — one moment.',
  errCaptureFailed: "Couldn't capture — try again.",
  errProcessingFailed: "Couldn't process the photo.",
  errSaveFailed: "Couldn't save the photo — check your storage.",
  errNotRunning: 'Camera is restarting — try again.',
  errApertureUnsupported: 'Variable aperture is not available on this device.',
  errPermissionDenied: 'Camera access is required — allow it in Settings.',
  errCameraUnavailable: 'Camera unavailable.',
  errGeneric: 'Something went wrong — try again.',
  initFailed: 'Failed to initialize Camera Engine',
  dnaFallbackSaved: 'Camera DNA processing failed — the original photo was saved.',

  // Permission explainer / startup views
  cameraAccessRequired: 'Camera Access Required',
  cameraEngineError: 'Camera Engine Error',
  permDeniedStatus:
    'Camera access is currently disabled. Enable it in Settings — the camera is only used for the viewfinder and photos.',
  permExplainer:
    'Camera 18 simulates classic film cameras. The camera is used for the live viewfinder; photos are saved with add-only photo access.',
  permDefaultExplainer:
    'Camera 18 simulates classic film cameras. It needs the camera for the viewfinder and photo access (add-only) to save your shots.',
  openSettings: 'Open Settings',
  continueLabel: 'Continue',
  retryCamera: 'Retry Camera',
  preparingCamera: 'Preparing camera...',
  initializingCamera: 'Initializing Camera Engine...',

  // Photo pipeline surface
  photoSaveOff: 'Photo saving is off — tap to open Settings',
  openInPhotos: 'Open in Photos',
  photosRedirectFail:
    "Can't open the Photos app from this iOS version. Your photo is saved in the library — open Photos from the Home Screen.",

  // Aperture strip badge
  badgeRealAperture: 'Real Aperture',
  badgeFixedAperture: 'Fixed Aperture',

  // Camera selector legal footer
  legalTerms: 'Terms',
  legalPrivacy: 'Privacy',
  legalSupport: 'Support',

  // Onboarding (3 pages, first launch only)
  onbApertureTitle: 'Aperture. In Your Hands.',
  onbApertureSubtitle: 'Continuous aperture control, built for iPhone photography.',
  onbCharactersTitle: '8 Cameras.\n8 Characters.',
  onbCharactersSubtitle: 'A different character for every shot.',
  onbTrialTitle: 'Try Every Camera.',
  onbTrialGritYours: 'GRIT N is yours.',
  onbTrialTryOthers: 'Try every other camera with 3 free shots.',
  onbTrialUnlimited: 'UNLIMITED',
  onbTrialFreeShots: '3 FREE SHOTS EACH',
  onbSkip: 'Skip',
  onbContinue: 'Continue',
  onbStartShooting: 'Start Shooting',

  // Paywall
  paywallTitle: 'Unlock Every Camera.',
  paywallSubtitle: 'Unlimited access to all 8 camera characters.',
  paywallYearly: 'YEARLY',
  paywallMonthly: 'MONTHLY',
  paywallFoundingPrice: 'FOUNDING PRICE',
  paywallKeepFounding: 'Keep your founding price while subscribed.',
  paywallUnlockCta: 'Unlock Camera 18 Pro',
  paywallRestore: 'Restore Purchases',
  paywallRetry: 'Retry',
  paywallPending: 'Purchase pending — Pro unlocks once it completes.',
  paywallVerificationFailed: 'Purchase verification failed. Please try again.',
  paywallPurchaseFailed: "Couldn't complete the purchase. Please try again.",
  paywallRestored: 'Purchases restored.',
  paywallNoSubscription: 'No active subscription found.',
  paywallLoading: 'Loading…',
  paywallAutoRenewNote:
    'Auto-renews until cancelled. Manage or cancel anytime in Settings. New camera characters are included while subscribed.',

  // Trial badges & hints
  trialLeftBadge: '{n} LEFT',
  trialProBadge: 'PRO',
  trialUsedHint: 'Free shots used.',
  trialUnlockHint: 'Unlock Pro to keep shooting with this camera.',

  // Camera selector Pro row / footer
  proRowLabel: 'Camera 18 Pro',
  proRowActive: 'Active',
  proRowManage: 'Manage',
};

const zh: Record<keyof typeof en, string> = {
  errPhotoPermissionDenied: '无法保存照片——请在设置中允许照片访问。',
  errCaptureBusy: '上一张还在处理中，请稍候。',
  errCaptureFailed: '拍摄失败，请重试。',
  errProcessingFailed: '照片处理失败。',
  errSaveFailed: '无法保存照片——请检查存储空间。',
  errNotRunning: '相机正在重启，请重试。',
  errApertureUnsupported: '此设备不支持可变光圈。',
  errPermissionDenied: '需要相机权限——请在设置中允许。',
  errCameraUnavailable: '相机不可用。',
  errGeneric: '出了点问题——请重试。',
  initFailed: '相机引擎初始化失败',
  dnaFallbackSaved: '相机 DNA 处理失败——已保存原图。',

  cameraAccessRequired: '需要相机权限',
  cameraEngineError: '相机引擎错误',
  permDeniedStatus: '相机访问已被禁用。请在设置中开启——相机仅用于取景和拍摄照片。',
  permExplainer: 'Camera 18 模拟经典胶片相机。相机仅用于实时取景；保存照片只需“添加照片”权限。',
  permDefaultExplainer: 'Camera 18 模拟经典胶片相机。需要相机用于取景，并使用“添加照片”权限保存拍摄的照片。',
  openSettings: '打开设置',
  continueLabel: '继续',
  retryCamera: '重试相机',
  preparingCamera: '正在准备相机…',
  initializingCamera: '正在初始化相机引擎…',

  photoSaveOff: '照片保存未开启——点按前往设置',
  openInPhotos: '在“照片”中打开',
  photosRedirectFail: '此 iOS 版本无法从应用内跳转“照片”。照片已保存到相册——请从主屏幕打开“照片”查看。',

  badgeRealAperture: '真实光圈',
  badgeFixedAperture: '固定光圈',

  legalTerms: '用户协议',
  legalPrivacy: '隐私政策',
  legalSupport: '支持',

  onbApertureTitle: '光圈，尽在掌握。',
  onbApertureSubtitle: '为 iPhone 摄影打造的连续光圈控制。',
  onbCharactersTitle: '8 台相机。\n8 种性格。',
  onbCharactersSubtitle: '每一次按下快门，都有不同的性格。',
  onbTrialTitle: '试试每一台相机。',
  onbTrialGritYours: 'GRIT N 属于你。',
  onbTrialTryOthers: '其余每台相机各有 3 次免费试拍。',
  onbTrialUnlimited: '无限拍',
  onbTrialFreeShots: '每台 3 次免费试拍',
  onbSkip: '跳过',
  onbContinue: '继续',
  onbStartShooting: '开始拍摄',

  paywallTitle: '解锁全部相机。',
  paywallSubtitle: '无限使用全部 8 个相机性格。',
  paywallYearly: '年付',
  paywallMonthly: '月付',
  paywallFoundingPrice: '首发价',
  paywallKeepFounding: '订阅期间一直保留你的首发价。',
  paywallUnlockCta: '解锁 Camera 18 Pro',
  paywallRestore: '恢复购买',
  paywallRetry: '重试',
  paywallPending: '购买待处理——完成后自动解锁 Pro。',
  paywallVerificationFailed: '购买验证失败，请重试。',
  paywallPurchaseFailed: '无法完成购买，请重试。',
  paywallRestored: '已恢复购买。',
  paywallNoSubscription: '未找到有效订阅。',
  paywallLoading: '加载中…',
  paywallAutoRenewNote: '自动续订，可随时在设置中管理或取消。订阅期间包含新增相机性格。',

  trialLeftBadge: '剩 {n} 张',
  trialProBadge: 'PRO',
  trialUsedHint: '免费试拍已用完。',
  trialUnlockHint: '解锁 Pro，继续用这台相机拍摄。',

  proRowLabel: 'Camera 18 Pro',
  proRowActive: '已开通',
  proRowManage: '管理',
};

const STRINGS: Record<Lang, Record<keyof typeof en, string>> = { en, zh };

export type StringKey = keyof typeof en;

/** Look up one string in the launch-time language (English fallback by construction). */
export function t(key: StringKey): string {
  return STRINGS[appLang][key];
}

/** Look up a string with `{n}`-style numeric substitution (trial badge counts). */
export function tf(key: StringKey, n: number): string {
  return STRINGS[appLang][key].replace('{n}', String(n));
}
