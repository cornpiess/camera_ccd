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
  supportsRAW: boolean;
  supportsProRAW: boolean;
  /** Compatibility alias for activeAperture. */
  activeLensAperture: number;
  /** Compatibility alias for deviceModel. */
  model: string;
};

export type CapturedPhoto = {
  /** Temporary processed JPEG. Copy it if it must outlive the current app cache lifecycle. */
  fileUri: string;
  /** Temporary preview JPEG, scaled to at most 512 px on its longest edge. */
  thumbnailUri: string;
  /** Photos asset identifier when supplied by PhotoKit. */
  assetLocalIdentifier: string | null;
  /** True when Camera DNA processing failed and the untouched Apple-processed photo was saved instead. */
  processingFallback?: boolean | null;
};

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
  capturePhoto(): Promise<CapturedPhoto>;
  setAperture(fStop: number): Promise<void>;
  /** Normalized (0..1) tap position in the video frame; keeps AF/AE continuous around that point. */
  setFocusPoint(x: number, y: number): Promise<void>;
  getCapabilities(): Promise<CameraCapabilities>;
  applyProfile(profile: CameraProfile): Promise<void>;
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
  applyProfile: () => Promise.reject(unavailableError()),
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
export const capturePhoto = (): Promise<CapturedPhoto> => typed(NativeModule.capturePhoto());
export const setAperture = (fStop: number): Promise<void> => typed(NativeModule.setAperture(fStop));
export const setFocusPoint = (x: number, y: number): Promise<void> => typed(NativeModule.setFocusPoint(x, y));
export const getCapabilities = (): Promise<CameraCapabilities> => typed(NativeModule.getCapabilities());
export const applyProfile = (profile: CameraProfile): Promise<void> => typed(NativeModule.applyProfile(profile));

/** Functional native API; also convenient for call sites that prefer a namespace object. */
export const CameraEngine = {
  startCamera,
  stopCamera,
  capturePhoto,
  setAperture,
  setFocusPoint,
  getCapabilities,
  applyProfile,
} as const;

export type CameraEngineHandle = {
  startCamera: typeof startCamera;
  stopCamera: typeof stopCamera;
  capturePhoto: typeof capturePhoto;
  setAperture: typeof setAperture;
  setFocusPoint: typeof setFocusPoint;
  getCapabilities: typeof getCapabilities;
  applyProfile: typeof applyProfile;
};

export type CameraEngineViewProps = {
  style?: StyleProp<ViewStyle>;
  profile?: CameraProfile;
  /** Reserved display value. Setting hardware aperture is unsupported. */
  aperture?: number;
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
    applyProfile,
  }), []);
  return <NativePreview {...nativeProps} />;
});

export default CameraEngineView;
