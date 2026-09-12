import React, { forwardRef, useImperativeHandle } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';

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

const NativeModule = requireNativeModule<NativeCameraEngine>('CameraEngine');
const NativePreview = requireNativeViewManager<CameraEngineViewProps>('CameraEngine');

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
