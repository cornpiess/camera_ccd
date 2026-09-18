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
};

const STRINGS: Record<Lang, Record<keyof typeof en, string>> = { en, zh };

export type StringKey = keyof typeof en;

/** Look up one string in the launch-time language (English fallback by construction). */
export function t(key: StringKey): string {
  return STRINGS[appLang][key];
}
