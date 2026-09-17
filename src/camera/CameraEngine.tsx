import React, { forwardRef, useImperativeHandle, type ComponentType } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';
import { recordDiag, registeredExpoModuleNames } from '../utils/diagLog';

export type CameraProfile = Record<string, unknown>;

export type CameraCapabilities = {
  supportsVariableAperture: boolean;
  minAperture: number | null;
  maxAperture: number | null;
  activeAperture: number;
  supportedApertures?: number[] | null;
  deviceModel: string;
  /** Capability-driven aperture mode: variable = real iris; fixed = single mechanical aperture. */
  apertureMode?: 'variable' | 'fixed';
  supportsRAW: boolean;
  supportsProRAW: boolean;
  /** Compatibility alias for activeAperture. */
  activeLensAperture: number;
  /** Compatibility alias for deviceModel. */
  model: string;
};

export type EngineDiagnostics = {
  /** Every .cube name the native side can actually load this build. */
  bundledLuts: string[];
  /** add-only Photos permission: authorized | limited | denied | restricted | notDetermined | unknown */
  photoAddAuthorization: string;
  osVersion: string;
  supportsVariableAperture?: boolean;
  minAperture?: number | null;
  maxAperture?: number | null;
  activeAperture?: number;
  supportedApertures?: number[] | null;
  deviceModel?: string;
  /** Camera Control side button: method names the installed OS actually exposes (runtime enumeration). */
  cameraControlSurface?: string[];
  /** TRUE on local-dev / TestFlight Beta builds: the mock aperture developer menu is available. */
  testingBuild?: boolean;
};

/**
 * Shutter-promise payload (spec §6): the promise settles when APPLE'S CAPTURE is done
 * — BEFORE Camera DNA / HEIF / PhotoKit finish. The heavy-pipeline outcome (final
 * fileUri/thumbnail/errors) arrives later via the onPhotoProcessed event, so almost
 * every field is legitimately absent here.
 */
export type CapturedPhoto = {
  fileUri?: string | null;
  thumbnailUri?: string | null;
  assetLocalIdentifier?: string | null;
  processingFallback?: boolean | null;
  codec?: string | null;
  appliedZoom?: number | null;
  equivalentFocal?: number | null;
};

/** Background pipeline outcome (Camera DNA → HEIF → PhotoKit finished or failed). */
export type PhotoProcessedEvent = {
  ok: boolean;
  fileUri?: string | null;
  thumbnailUri?: string | null;
  assetLocalIdentifier?: string | null;
  errorCode?: string | null;
  detail?: string | null;
  processingFallback?: boolean | null;
  codec?: string | null;
  appliedZoom?: number | null;
  equivalentFocal?: number | null;
};

export type CameraAuthorizationStatus = 'authorized' | 'notDetermined' | 'denied' | 'restricted';

export type CameraEngineErrorCode =
  | 'ERR_NO_ACTIVE_VIEW'
  | 'ERR_PERMISSION_DENIED'
  | 'ERR_PHOTO_PERMISSION_DENIED'
  | 'ERR_CAMERA_UNAVAILABLE'
  | 'ERR_CONFIGURATION_FAILED'
  | 'ERR_NOT_RUNNING'
  | 'ERR_CAPTURE_FAILED'
  | 'ERR_CAPTURE_BUSY'
  | 'ERR_PROCESSING_FAILED'
  | 'ERR_SAVE_FAILED'
  | 'ERR_APERTURE_UNSUPPORTED'
  | 'ERR_NATIVE_FAILURE';

export class CameraEngineError extends Error {
  constructor(public readonly code: CameraEngineErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CameraEngineError';
  }
}

type NativeCameraEngine = {
  startCamera(): Promise<boolean>;
  stopCamera(): Promise<void>;
  capturePhoto(equivalentMM: number): Promise<CapturedPhoto>;
  setAperture(fStop: number): Promise<void>;
  /** Normalized (0..1) tap position in the video frame; keeps AF/AE continuous around that point. */
  setFocusPoint(x: number, y: number): Promise<void>;
  getCapabilities(): Promise<CameraCapabilities>;
  /** On-device triage: LUT bundle inventory, add-only photo permission, aperture report. */
  getDiagnostics(): Promise<EngineDiagnostics>;
  applyProfile(profile: CameraProfile): Promise<void>;
  /** Read-only authorization probe; the system dialog only fires from startCamera. */
  getCameraAuthorizationStatus(): Promise<CameraAuthorizationStatus>;
  getAvailableLenses(): Promise<{
    kind: string;
    deviceModel: string;
    /** True when the device exposes a real ultra-wide (virtual device). */
    ultraWide?: boolean;
    /** Switchover zoom factor of the telephoto constituent (nil = no tele). */
    teleZoom?: number | null;
  }>;
  setLens(lensId: string): Promise<void>;
  /** Crop zoom (videoZoomFactor) on the ACTIVE lens; ≥1, applies to preview AND capture. */
  setZoomFactor(factor: number, equivalentMM: number): Promise<void>;
  addApertureChangedListener(
    cb: (event: { readonly fNumber: number }) => void,
  ): { readonly remove: () => void };
  /** TESTING BUILDS ONLY: force aperture capability ("real" | "mock-variable" | "mock-fixed"). */
  setMockApertureMode(mode: 'real' | 'mock-variable' | 'mock-fixed'): Promise<void>;
  addZoomChangedListener(
    cb: (event: { readonly zoom: number }) => void,
  ): { readonly remove: () => void };
};

/**
 * Both native entry points (the function module and the preview view manager) are resolved
 * by expo-modules-core at MODULE LOAD time, so an unguarded failure aborts the whole JS
 * bundle before React renders anything — in a production build that is a full black screen
 * (same failure class as the GlassCard guarded glass require: an old/mismatched native side
 * must never cost the app its launch). On resolution failure we keep rendering and surface
 * the reason through the normal CameraErrorView path instead.
 *
 * The two resolutions are guarded SEPARATELY and the underlying error is preserved: the
 * Expo runtime swallows inner failures into a console.warn and only reports "Cannot find
 * native module", so the registered-module list is attached to make the report actionable.
 */
type NativeResolution =
  | {
      readonly ok: true;
      readonly module: NativeCameraEngine;
      readonly preview: ComponentType<CameraEngineViewProps>;
    }
  | { readonly ok: false; readonly stage: 'module' | 'view'; readonly detail: string };

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function resolveNativeParts(): NativeResolution {
  try {
    const mod = requireNativeModule<NativeCameraEngine>('CameraEngine');
    try {
      const preview = requireNativeViewManager<CameraEngineViewProps>('CameraEngine');
      return { ok: true, module: mod, preview };
    } catch (viewError) {
      return { ok: false, stage: 'view', detail: describeError(viewError) };
    }
  } catch (moduleError) {
    return {
      ok: false,
      stage: 'module',
      detail: `${describeError(moduleError)} | registered expo modules: ${registeredExpoModuleNames()}`,
    };
  }
}

const nativeResolution = resolveNativeParts();

if (!nativeResolution.ok) {
  recordDiag('error', `CameraEngine native resolution failed (${nativeResolution.stage}): ${nativeResolution.detail}`);
}

const CAMERA_MODULE_UNAVAILABLE_PREFIX = 'The CameraEngine native side failed to load in this app build';
const CAMERA_MODULE_UNAVAILABLE_SUFFIX =
  'The JS and native sides may come from different commits — rebuild and reinstall the app.';

function unavailableError(): CameraEngineError {
  return new CameraEngineError(
    'ERR_NATIVE_FAILURE',
    nativeResolution.ok
      ? CAMERA_MODULE_UNAVAILABLE_PREFIX
      : `${CAMERA_MODULE_UNAVAILABLE_PREFIX} (${nativeResolution.stage}: ${nativeResolution.detail}). ${CAMERA_MODULE_UNAVAILABLE_SUFFIX}`,
  );
}

const unavailableModule: NativeCameraEngine = {
  startCamera: () => Promise.reject(unavailableError()),
  stopCamera: () => Promise.reject(unavailableError()),
  capturePhoto: () => Promise.reject(unavailableError()),
  setAperture: () => Promise.reject(unavailableError()),
  setFocusPoint: () => Promise.reject(unavailableError()),
  getCapabilities: () => Promise.reject(unavailableError()),
  getDiagnostics: () => Promise.reject(unavailableError()),
  applyProfile: () => Promise.reject(unavailableError()),
  getCameraAuthorizationStatus: () => Promise.reject(unavailableError()),
  getAvailableLenses: () => Promise.reject(unavailableError()),
  setLens: () => Promise.reject(unavailableError()),
  setZoomFactor: () => Promise.reject(unavailableError()),
  setMockApertureMode: () => Promise.reject(unavailableError()),
  addApertureChangedListener: () => ({ remove: () => {} }),
  addZoomChangedListener: () => ({ remove: () => {} }),
};

/** Black stand-in preview so the app still mounts and shows the error view above it. */
const UnavailablePreview: ComponentType<CameraEngineViewProps> = ({ style }) => (
  <View style={[StyleSheet.absoluteFillObject, { backgroundColor: '#000000' }, style]} pointerEvents="none" />
);

const NativeModule: NativeCameraEngine = nativeResolution.ok ? nativeResolution.module : unavailableModule;
const NativePreview: ComponentType<CameraEngineViewProps> = nativeResolution.ok
  ? nativeResolution.preview
  : UnavailablePreview;

function typed<T>(operation: Promise<T>): Promise<T> {
  return operation.catch((cause: unknown) => {
    const native = cause as { code?: string; message?: string } | null;
    const code = native?.code?.startsWith('ERR_') ? native.code as CameraEngineErrorCode : 'ERR_NATIVE_FAILURE';
    throw new CameraEngineError(code, native?.message ?? 'Camera Engine operation failed.', cause);
  });
}

export const startCamera = (): Promise<boolean> => typed(NativeModule.startCamera());
export const stopCamera = (): Promise<void> => typed(NativeModule.stopCamera());
export const capturePhoto = (equivalentMM: number): Promise<CapturedPhoto> => typed(NativeModule.capturePhoto(equivalentMM));
export const setAperture = (fStop: number): Promise<void> => typed(NativeModule.setAperture(fStop));
export const setFocusPoint = (x: number, y: number): Promise<void> => typed(NativeModule.setFocusPoint(x, y));
export const getCapabilities = (): Promise<CameraCapabilities> => typed(NativeModule.getCapabilities());
export const getDiagnostics = (): Promise<EngineDiagnostics> => typed(NativeModule.getDiagnostics());
export const applyProfile = (profile: CameraProfile): Promise<void> => typed(NativeModule.applyProfile(profile));
export const getCameraAuthorizationStatus = (): Promise<CameraAuthorizationStatus> =>
  typed(NativeModule.getCameraAuthorizationStatus());
export type LensInfo = { kind: string; deviceModel: string; ultraWide?: boolean; tele?: boolean; teleZoom?: number | null };
export const getAvailableLenses = (): Promise<LensInfo> =>
  typed(NativeModule.getAvailableLenses());
export const setLens = (lensId: string): Promise<void> => typed(NativeModule.setLens(lensId));
export const setZoomFactor = (factor: number, equivalentMM: number): Promise<void> => typed(NativeModule.setZoomFactor(factor, equivalentMM));
/** TESTING BUILDS ONLY (see CameraEngineModule CAMER18_TESTING gate). */
export const setMockApertureMode = (
  mode: 'real' | 'mock-variable' | 'mock-fixed',
): Promise<void> => typed(NativeModule.setMockApertureMode(mode));

/** Native aperture change (Camera Control slider / any native source) -> ApertureState sync. */
export type ApertureChangedEvent = { readonly fNumber: number };
/** Native zoom change (Camera Control system zoom slider) -> focal dial sync. */
export type ZoomChangedEvent = { readonly zoom: number };
export type NativeEventSubscription = { readonly remove: () => void };

/**
 * Event subscription through the SAME guarded resolution as the functions above: a
 * missing native side must degrade to a no-op subscription, never a synchronous throw
 * inside a caller's useEffect (which would crash the launch the guarded require above
 * just worked to protect).
 */
function addEngineListener<T>(event: string, cb: (event: T) => void): NativeEventSubscription {
  if (!nativeResolution.ok) return { remove: () => {} };
  return requireNativeModule('CameraEngine').addListener(event, cb) as { readonly remove: () => void };
}

export const addApertureChangedListener = (
  cb: (event: ApertureChangedEvent) => void,
): NativeEventSubscription => addEngineListener('onApertureChanged', cb);
export const addZoomChangedListener = (
  cb: (event: ZoomChangedEvent) => void,
): NativeEventSubscription => addEngineListener('onZoomChanged', cb);
/** Background pipeline outcome for a shutter press (fires AFTER the promise settled). */
export const addPhotoProcessedListener = (
  cb: (event: PhotoProcessedEvent) => void,
): NativeEventSubscription => addEngineListener('onPhotoProcessed', cb);

/** Functional native API; also convenient for call sites that prefer a namespace object. */
export const CameraEngine = {
  startCamera,
  stopCamera,
  capturePhoto,
  setAperture,
  setFocusPoint,
  getCapabilities,
  getDiagnostics,
  applyProfile,
  getCameraAuthorizationStatus,
  getAvailableLenses,
  setLens,
  setZoomFactor,
  addApertureChangedListener,
  addZoomChangedListener,
  addPhotoProcessedListener,
} as const;

export type CameraEngineHandle = {
  startCamera: typeof startCamera;
  stopCamera: typeof stopCamera;
  capturePhoto: typeof capturePhoto;
  setAperture: typeof setAperture;
  setFocusPoint: typeof setFocusPoint;
  getCapabilities: typeof getCapabilities;
  getDiagnostics: typeof getDiagnostics;
  applyProfile: typeof applyProfile;
  getCameraAuthorizationStatus: typeof getCameraAuthorizationStatus;
  getAvailableLenses: typeof getAvailableLenses;
  setLens: typeof setLens;
  setZoomFactor: typeof setZoomFactor;
  setMockApertureMode: typeof setMockApertureMode;
  addApertureChangedListener: typeof addApertureChangedListener;
  addZoomChangedListener: typeof addZoomChangedListener;
};

export type CameraEngineViewProps = {
  style?: StyleProp<ViewStyle>;
  profile?: CameraProfile;
  /** Reserved display value. Setting hardware aperture is unsupported. */
  aperture?: number;
  /** Rounded-rect viewfinder card radius (pt); 0 = square corners. */
  cornerRadius?: number;
  onError?: (error: CameraEngineError) => void;
};

/**
 * Native AVFoundation preview. Mount one instance before invoking any method.
 * The native module intentionally manages one active view/session.
 */
export const CameraEngineView = forwardRef<CameraEngineHandle, CameraEngineViewProps>(function CameraEngineView(
  { aperture: _aperture, onError: _onError, ...nativeProps },
  ref,
) {
  useImperativeHandle(ref, () => ({
    startCamera,
    stopCamera,
    capturePhoto,
    setAperture,
    setFocusPoint,
    getCapabilities,
    getDiagnostics,
    applyProfile,
    getCameraAuthorizationStatus,
    getAvailableLenses,
    setLens,
    setZoomFactor,
    setMockApertureMode,
    addApertureChangedListener,
    addZoomChangedListener,
    }), []);
  return <NativePreview {...nativeProps} />;
});

export default CameraEngineView;
