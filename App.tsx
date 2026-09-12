// diagLog must be imported first: it self-installs on import so that any module-evaluation
// error from the imports below (native module resolution included) is already captured.
import { installDiagLog, recordDiag } from './src/utils/diagLog';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  StatusBar,
  Animated,
  Dimensions,
  AppState,
  Linking,
  Platform,
  PanResponder,
  Text,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from 'react-native';
import * as Haptics from 'expo-haptics';

// Native camera module wrapper & native APIs
import {
  CameraEngine,
  CameraEngineError,
  CameraEngineView,
  type CapturedPhoto,
  type CameraCapabilities,
  type CameraAuthorizationStatus,
} from './src/camera/CameraEngine';
// LoadCameraState, focal model, aperture visual linkage
import { loadCameraState, rememberAperture, saveCameraState, type CameraState } from './src/camera/cameraStateStore';
import { buildFocalStops, defaultFocalStop, type FocalStop } from './src/camera/focalLadder';
import { apertureVisualFactors, applyApertureVisual } from './src/camera/apertureVisualProfile';

// Profile management provider
import { ProfileProvider, useProfiles } from './src/profiles/ProfileProvider';
import type { CameraProfile } from './src/profiles/types';

// Hardware / Lens Calibration Modal
import { CalibrationModal } from './src/calibration/CalibrationModal';

// UI components & Types
import {
  TopBar,
  ShutterButton,
  ThumbnailPreview,
  FocalApertureDial,
  RadialProfileSelector,
  CameraSelector,
  FocusIndicator,
  StartupErrorBoundary,
  ThreeFingerGestureDetector,
  type FocusPoint,
  PermissionRequestView,
  CameraLoadingView,
  CameraErrorView,
  getClampedCenter,
  computeRadialSector,
  type Point,
} from './src/components';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

installDiagLog();

/**
 * Viewfinder geometry, matched to the iOS system camera: a full-width 4:3 frame whose
 * top edge sits right below the top control bar (the native preview is a 4:3 image
 * letterboxed inside the view, so this rect is an exact fit — no letterbox, no crop).
 * Tap-to-focus coordinates are normalized against THIS rect (the native side converts
 * with the actual view bounds, which is always correct under any aspect math).
 */
const VIEWFINDER_TOP = 60;
const VIEWFINDER_HEIGHT = Math.round(SCREEN_WIDTH * (4 / 3));
const VIEWFINDER_BOTTOM = VIEWFINDER_TOP + VIEWFINDER_HEIGHT;

/**
 * Capture lifecycle the UI can distinguish without a native event channel:
 * idle → capturing (press → native promise settles) → idle | failed.
 * Processing/Save phases still live inside 'capturing' on purpose — splitting them
 * further would require a native event bridge, deliberately not added yet.
 */
type CapturePhase = 'idle' | 'capturing' | 'failed';

/**
 * User-language error messages (Iteration 4: never expose AVCapture error domains).
 */
const FRIENDLY_ERROR_MESSAGES: Record<string, string> = {
  ERR_PHOTO_PERMISSION_DENIED: "Couldn't save the photo — allow photo access in Settings.",
  ERR_CAPTURE_BUSY: 'Still processing the previous photo — one moment.',
  ERR_CAPTURE_FAILED: "Couldn't capture — try again.",
  ERR_PROCESSING_FAILED: "Couldn't process the photo.",
  ERR_SAVE_FAILED: "Couldn't save the photo — check your storage.",
  ERR_NOT_RUNNING: 'Camera is restarting — try again.',
  ERR_APERTURE_UNSUPPORTED: 'Variable aperture is not available on this device.',
  ERR_PERMISSION_DENIED: 'Camera access is required — allow it in Settings.',
  ERR_CAMERA_UNAVAILABLE: 'Camera unavailable.',
};

function resolveErrorMessage(err: unknown): string {
  if (err instanceof CameraEngineError) {
    return FRIENDLY_ERROR_MESSAGES[err.code] ?? err.message;
  }
  const record = err as { code?: string; message?: string } | null;
  const mapped = record?.code ? FRIENDLY_ERROR_MESSAGES[record.code] : undefined;
  if (mapped) return mapped;
  return err instanceof Error ? err.message : 'Something went wrong — try again.';
}

/**
 * Hard ceiling for a single capture round-trip. ProRAW development plus JPEG
 * encoding is slow, but a capture that never comes back at all would otherwise
 * leave the shutter permanently disabled.
 */
const CAPTURE_TIMEOUT_MS = 20_000;

/**
 * Derive discrete 1/3-stop variable aperture values from capability min/max.
 * Formula: N = 2^(k/6), with k integer.
 */
function deriveVariableApertures(minAperture: number, maxAperture: number): number[] {
  const min = Math.min(minAperture, maxAperture);
  const max = Math.max(minAperture, maxAperture);
  // Keep two decimals so real hardware stops like ƒ/1.48 are never rewritten into
  // fabricated values (ƒ/1.5 exists only in rounding, not in the lens).
  if (min >= max) {
    return [Number(min.toFixed(2))];
  }

  const stops = new Set<number>();
  stops.add(Number(min.toFixed(2)));

  const kStart = Math.ceil(6 * Math.log2(min));
  const kEnd = Math.floor(6 * Math.log2(max));

  for (let k = kStart; k <= kEnd; k++) {
    const val = Math.pow(2, k / 6);
    const rounded = Math.round(val * 10) / 10;
    if (rounded > min + 0.05 && rounded < max - 0.05) {
      stops.add(rounded);
    }
  }

  stops.add(Number(max.toFixed(2)));
  return Array.from(stops).sort((a, b) => a - b);
}

/**
 * Check whether an error is a permission denied failure.
 */
function isPermissionDeniedError(err: unknown): boolean {
  if (err instanceof CameraEngineError && err.code === 'ERR_PERMISSION_DENIED') {
    return true;
  }
  if (err && typeof err === 'object') {
    const record = err as { code?: string; message?: string };
    if (record.code === 'ERR_PERMISSION_DENIED') return true;
    if (typeof record.message === 'string' && record.message.toLowerCase().includes('permission')) {
      return true;
    }
  }
  return false;
}

/**
 * Internal Camera App Screen Component (within ProfileProvider context)
 */
function CameraAppScreen(): React.JSX.Element {
  // -------------------------------------------------------------
  // 1. Profile State exclusively via useProfiles() JSON state
  // -------------------------------------------------------------
  const { profiles, currentProfile, currentProfileId, selectProfile, errors: profileErrors } = useProfiles();
  const activeProfile = currentProfile ?? profiles[0] ?? null;

  // -------------------------------------------------------------
  // 2. Camera Engine Hardware State
  // -------------------------------------------------------------
  // App Store-style permission flow: probe WITHOUT triggering the system dialog, show an
  // explainer first, and only start the session (which may request access) on user action.
  const [permissionState, setPermissionState] = useState<CameraAuthorizationStatus | 'checking'>('checking');
  const [cameraInitError, setCameraInitError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isCameraRunning, setIsCameraRunning] = useState<boolean>(false);

  // Aperture hardware capability states
  const [supportsVariableAperture, setSupportsVariableAperture] = useState<boolean>(false);
  const [activeAperture, setActiveAperture] = useState<number>(1.8);
  const [currentAperture, setCurrentAperture] = useState<number>(1.8);
  const [availableApertures, setAvailableApertures] = useState<number[]>([]);
  const capabilitiesRef = useRef<CameraCapabilities | null>(null);

  // Rear lens inventory → derived focal stops for the dial (13/26/35/52 on dual, 13…192 on Pro).
  const [currentLensId, setCurrentLensId] = useState<string>('wide');
  const [focalStops, setFocalStops] = useState<FocalStop[]>([]);
  const [currentFocalMm, setCurrentFocalMm] = useState<number | null>(null);

  // Photo Capture & Preview states
  const [capturePhase, setCapturePhase] = useState<CapturePhase>('idle');
  const [latestThumbnail, setLatestThumbnail] = useState<string | null>(null);

  // Tracks whether the native session started successfully (used by the AppState recovery path)
  const cameraRunningRef = useRef<boolean>(false);

  // Persisted camera memory: last profile + per-profile last user-chosen aperture.
  // Loaded async once on mount; restore happens after both profiles and state are ready.
  const cameraStateRef = useRef<CameraState>({ lastProfileId: null, lastApertures: {} });
  const [cameraStateLoaded, setCameraStateLoaded] = useState(false);
  const restoreAttemptedRef = useRef(false);
  useEffect(() => {
    let mounted = true;
    loadCameraState().then((state) => {
      if (!mounted) return;
      cameraStateRef.current = state;
      setCameraStateLoaded(true);
    }).catch(() => setCameraStateLoaded(true));
    return () => {
      mounted = false;
    };
  }, []);

  // Flash curtain effect
  const shutterFlashAnim = useRef(new Animated.Value(0)).current;

  // -------------------------------------------------------------
  // 3. Transient Error Overlay (Running Errors: profile/apply/aperture/capture/save)
  // -------------------------------------------------------------
  const [transientError, setTransientError] = useState<string | null>(null);
  const transientErrorTimerRef = useRef<NodeJS.Timeout | null>(null);

  const showTransientError = useCallback((message: string) => {
    recordDiag('error', `transient: ${message}`);
    if (transientErrorTimerRef.current) {
      clearTimeout(transientErrorTimerRef.current);
    }
    setTransientError(message);
    transientErrorTimerRef.current = setTimeout(() => {
      setTransientError(null);
      transientErrorTimerRef.current = null;
    }, 4000);
  }, []);

  // -------------------------------------------------------------
  // 4. Calibration Modal State (3-finger ~2 sec gesture)
  // -------------------------------------------------------------
  const [isCalibrationOpen, setIsCalibrationOpen] = useState<boolean>(false);

  // -------------------------------------------------------------
  // 4b. Formal Camera Selector (top-badge entry) & Tap-to-Focus states
  // -------------------------------------------------------------
  const [isSelectorOpen, setIsSelectorOpen] = useState<boolean>(false);
  const [focusIndicator, setFocusIndicator] = useState<FocusPoint | null>(null);

  // -------------------------------------------------------------
  // 5. Radial Profile Selector State (Long-press on empty preview)
  // -------------------------------------------------------------
  const [isRadialOpen, setIsRadialOpen] = useState<boolean>(false);
  const [radialOrigin, setRadialOrigin] = useState<Point>({ x: SCREEN_WIDTH / 2, y: SCREEN_HEIGHT / 2 });
  const [currentTouchPoint, setCurrentTouchPoint] = useState<Point | null>(null);

  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const touchStartPosRef = useRef<Point | null>(null);
  const touchStartTimeRef = useRef<number>(0);
  const isRadialOpenRef = useRef<boolean>(false);
  const currentTouchRef = useRef<Point | null>(null);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  // -------------------------------------------------------------
  // 6. Camera Lifecycle: Initialize ONLY ONCE after view mount
  // -------------------------------------------------------------
  const initializeCameraSession = useCallback(async () => {
    try {
      setIsLoading(true);
      setCameraInitError(null);

      // Await startCamera and catch errors rather than swallowing
      await CameraEngine.startCamera();
      cameraRunningRef.current = true;
      setIsCameraRunning(true);
      setPermissionState('authorized');

      // Query hardware capabilities
      try {
        const capabilities: CameraCapabilities = await CameraEngine.getCapabilities();
        capabilitiesRef.current = capabilities;
        if (capabilities) {
          const variable = Boolean(capabilities.supportsVariableAperture);
          setSupportsVariableAperture(variable);
          const aperture = capabilities.activeAperture ?? capabilities.activeLensAperture ?? 1.8;
          setActiveAperture(aperture);
          setCurrentAperture(aperture);

          if (variable) {
            if (Array.isArray(capabilities.supportedApertures) && capabilities.supportedApertures.length > 0) {
              setAvailableApertures([...capabilities.supportedApertures].sort((a, b) => a - b));
            } else if (capabilities.minAperture != null && capabilities.maxAperture != null) {
              setAvailableApertures(deriveVariableApertures(capabilities.minAperture, capabilities.maxAperture));
            } else {
              setAvailableApertures([]);
            }
          } else {
            setAvailableApertures([]);
          }
        }
      } catch {
        setSupportsVariableAperture(false);
        setActiveAperture(1.8);
        setCurrentAperture(1.8);
        setAvailableApertures([]);
      }

      // Rear lens list → derive the focal-stop ladder for the dial.
      try {
        const list = await CameraEngine.getAvailableLenses();
        const lensArray = Array.isArray(list) ? list : [];
        const stops = buildFocalStops(lensArray.map((lens) => lens.id));
        setFocalStops(stops);
        setCurrentFocalMm((previous) =>
          previous ?? defaultFocalStop(lensArray.map((lens) => lens.id)).mm,
        );
      } catch {
        // Single-lens fallbacks stay on the previous state.
      }
    } catch (err: unknown) {
      cameraRunningRef.current = false;
      if (isPermissionDeniedError(err)) {
        setPermissionState('denied');
      } else {
        const errorMsg = err instanceof Error ? err.message : 'Failed to initialize Camera Engine';
        setCameraInitError(errorMsg);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Permission probe on mount: never triggers the system dialog itself. When already
  // authorized (or after the user opts in via the explainer) the session starts here.
  const didAutoStartRef = useRef(false);
  useEffect(() => {
    let mounted = true;
    CameraEngine.getCameraAuthorizationStatus()
      .then((status) => {
        if (mounted) setPermissionState(status);
      })
      .catch(() => {
        if (mounted) setPermissionState('denied');
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (permissionState === 'authorized' && !didAutoStartRef.current) {
      didAutoStartRef.current = true;
      initializeCameraSession();
    }
  }, [permissionState, initializeCameraSession]);

  // Stop the native session exactly once, on unmount.
  useEffect(() => {
    return () => {
      cameraRunningRef.current = false;
      CameraEngine.stopCamera().catch(() => {});
    };
  }, []);

  // -------------------------------------------------------------
  // 6b. Foreground recovery: iOS suspends/interrupts the capture session while
  // backgrounded (or during a call); startCamera is idempotent, so re-running the
  // full init on return restores preview, capabilities and error states.
  // -------------------------------------------------------------
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && cameraRunningRef.current) {
        void initializeCameraSession();
      }
    });
    return () => subscription.remove();
  }, [initializeCameraSession]);

  // -------------------------------------------------------------
  // 7. Apply profile in separate effect WITHOUT restarting camera
  // -------------------------------------------------------------
  // ApertureVisualProfile (§20/§21): one f-stop drives bloom + starburst together.
  // Depth is NOT software-faked (red line 4); on real variable-aperture hardware the
  // optics handle it. Neutral factors on fixed lenses keep profiles exactly as calibrated.
  const apertureVisual = useMemo(
    () => apertureVisualFactors(
      currentAperture,
      supportsVariableAperture,
      capabilitiesRef.current?.minAperture,
      capabilitiesRef.current?.maxAperture,
    ),
    [currentAperture, supportsVariableAperture, availableApertures],
  );
  const effectiveProfile = useMemo(
    () => (activeProfile ? applyApertureVisual(activeProfile as unknown as Record<string, unknown>, apertureVisual) : null),
    [activeProfile, apertureVisual],
  );

  useEffect(() => {
    if (!isCameraRunning || !activeProfile || !effectiveProfile) return;

    let isMounted = true;
    const applyCurrentProfile = async () => {
      try {
        await CameraEngine.applyProfile(effectiveProfile);

        // Aperture memory (Iteration 4): the JSON preferredAperture is only the first-touch
        // default — a user's last chosen f-stop for this profile wins.
        const target =
          cameraStateRef.current.lastApertures[activeProfile.id] ??
          activeProfile.aperture?.preferred;

        // If variable aperture is supported, clamp the target and update
        if (supportsVariableAperture && target != null) {
          const min = capabilitiesRef.current?.minAperture ?? availableApertures[0] ?? target;
          const max = capabilitiesRef.current?.maxAperture ?? availableApertures[availableApertures.length - 1] ?? target;
          const clamped = Math.min(Math.max(target, min), max);

          await CameraEngine.setAperture(clamped);
          if (isMounted) {
            setCurrentAperture(clamped);
            setActiveAperture(clamped);
          }
        }
      } catch (err: unknown) {
        if (isMounted) {
          showTransientError(resolveErrorMessage(err));
        }
      }
    };

    applyCurrentProfile();
    return () => {
      isMounted = false;
    };
  }, [effectiveProfile, activeProfile, isCameraRunning, supportsVariableAperture, availableApertures, showTransientError]);

  // Profile validation/import/reload errors shown as transient overlay while running
  useEffect(() => {
    if (profileErrors && profileErrors.length > 0) {
      showTransientError(profileErrors.join('\n'));
    }
  }, [profileErrors, showTransientError]);

  // -------------------------------------------------------------
  // 7b. Camera memory restore: once profiles are available, restore the
  // last used Camera Character exactly once per launch.
  // -------------------------------------------------------------
  useEffect(() => {
    if (restoreAttemptedRef.current || profiles.length === 0 || !cameraStateLoaded) return;
    restoreAttemptedRef.current = true;
    const stored = cameraStateRef.current.lastProfileId;
    if (stored && stored !== currentProfileId && profiles.some((p) => p.id === stored)) {
      selectProfile(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, cameraStateLoaded]);

  // -------------------------------------------------------------
  // 8. Hardware Actions: Aperture, Photo Capture
  // -------------------------------------------------------------
  const handleApertureChange = async (aperture: number) => {
    if (!supportsVariableAperture) {
      // Fixed devices never call setAperture
      return;
    }
    const min = capabilitiesRef.current?.minAperture ?? availableApertures[0] ?? aperture;
    const max = capabilitiesRef.current?.maxAperture ?? availableApertures[availableApertures.length - 1] ?? aperture;
    const clamped = Math.min(Math.max(aperture, min), max);
    const previous = currentAperture;

    // Optimistic UI so the marker tracks the finger immediately; revert if the
    // hardware rejects, so the shown value is always a real confirmed stop.
    setCurrentAperture(clamped);
    setActiveAperture(clamped);
    try {
      await CameraEngine.setAperture(clamped);
      // Persist the user's explicit choice for this profile (GOAL: aperture memory).
      if (activeProfile) {
        cameraStateRef.current.lastApertures[activeProfile.id] = clamped;
        rememberAperture(activeProfile.id, clamped);
      }
    } catch (err: unknown) {
      setCurrentAperture(previous);
      setActiveAperture(previous);
      showTransientError(resolveErrorMessage(err));
    }
  };

  /**
   * Focal-stop selection: switch the physical lens first when needed, then apply the
   * crop zoom on it. Display updates only after both hardware calls succeed.
   */
  const handleSelectFocal = useCallback(async (stop: FocalStop) => {
    try {
      if (stop.lensId !== currentLensId) {
        await CameraEngine.setLens(stop.lensId);
        setCurrentLensId(stop.lensId);
        // Different lens → different physical aperture; refresh the honest display.
        try {
          const caps = await CameraEngine.getCapabilities();
          const variable = Boolean(caps.supportsVariableAperture);
          setSupportsVariableAperture(variable);
          setAvailableApertures(variable && Array.isArray(caps.supportedApertures) && caps.supportedApertures.length > 0
            ? [...caps.supportedApertures].sort((a, b) => a - b)
            : []);
          const aperture = caps.activeAperture ?? caps.activeLensAperture ?? 1.8;
          setActiveAperture(aperture);
          setCurrentAperture(aperture);
        } catch {
          // Keep the previous aperture display; the lens switch itself succeeded.
        }
      }
      if (stop.zoom !== 1) {
        await CameraEngine.setZoomFactor(stop.zoom);
      }
      setCurrentFocalMm(stop.mm);
    } catch (err: unknown) {
      showTransientError(resolveErrorMessage(err));
    }
  }, [currentLensId, showTransientError]);

  const handleCapturePhoto = async () => {
    if (capturePhase === 'capturing') return;
    setCapturePhase('capturing');

    // Immediate shutter feedback: white flash + haptic fire on press, while the photo
    // processes in the background. Preview never blocks.
    Animated.sequence([
      Animated.timing(shutterFlashAnim, {
        toValue: 1,
        duration: 45,
        useNativeDriver: true,
      }),
      Animated.timing(shutterFlashAnim, {
        toValue: 0,
        duration: 160,
        useNativeDriver: true,
      }),
    ]).start();

    let timeoutId: NodeJS.Timeout | null = null;
    try {
      const result: CapturedPhoto = await Promise.race([
        CameraEngine.capturePhoto(),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('Capture timed out. The photo may still reach your library.')),
            CAPTURE_TIMEOUT_MS,
          );
        }),
      ]);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setCapturePhase('idle');
      if (result?.thumbnailUri) {
        setLatestThumbnail(result.thumbnailUri);
      } else if (result?.fileUri) {
        setLatestThumbnail(result.fileUri);
      }
      if (result?.processingFallback) {
        showTransientError('Camera DNA processing failed — the original photo was saved.');
      }
    } catch (err: unknown) {
      showTransientError(resolveErrorMessage(err));
      setCapturePhase('failed');
      // The failure state decays; the shutter is immediately usable again.
      setTimeout(() => setCapturePhase((phase) => (phase === 'failed' ? 'idle' : phase)), 2500);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  // -------------------------------------------------------------
  // 9. Viewfinder Long-Press & Radial Gesture Responder
  // -------------------------------------------------------------
  const cancelLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  /**
   * Tap-to-Focus: a quick, low-movement release sets the AF/AE point of interest and
   * shows a lightweight indicator. The tap is sent as a point normalized to the preview
   * layer; the native side converts it with captureDevicePointConverted, which stays
   * correct under aspect-fill on every device (no hand-rolled aspect math here).
   */
  const handleTapToFocus = useCallback(
    (pageX: number, pageY: number) => {
      if (!isCameraRunning) return;
      setFocusIndicator({ x: pageX, y: pageY, key: Date.now() });

      const nx = Math.min(1, Math.max(0, pageX / SCREEN_WIDTH));
      const ny = Math.min(1, Math.max(0, (pageY - VIEWFINDER_TOP) / VIEWFINDER_HEIGHT));
      CameraEngine.setFocusPoint(nx, ny).catch(() => {});
    },
    [isCameraRunning],
  );

  const handleSelectProfile = useCallback(
    (profile: CameraProfile) => {
      const ok = selectProfile(profile.id);
      if (ok) {
        cameraStateRef.current.lastProfileId = profile.id;
        saveCameraState({ lastProfileId: profile.id });
      }
    },
    [selectProfile]
  );

  const finalizeRadialSelection = useCallback(
    (releaseX?: number, releaseY?: number) => {
      cancelLongPressTimer();

      if (!isRadialOpenRef.current) {
        touchStartPosRef.current = null;
        return;
      }
      // Finalize selection exactly once on release
      isRadialOpenRef.current = false;
      setIsRadialOpen(false);

      const x = typeof releaseX === 'number' && !isNaN(releaseX) ? releaseX : currentTouchRef.current?.x;
      const y = typeof releaseY === 'number' && !isNaN(releaseY) ? releaseY : currentTouchRef.current?.y;
      const origin = touchStartPosRef.current ?? radialOrigin;

      if (x != null && y != null && origin) {
        const clampedCenter = getClampedCenter(origin, SCREEN_WIDTH, SCREEN_HEIGHT);
        const displayProfiles = profilesRef.current.slice(0, 8);
        const sector = computeRadialSector(x, y, clampedCenter, displayProfiles.length);

        if (sector !== null && displayProfiles[sector]) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          handleSelectProfile(displayProfiles[sector]!);
        } else {
          // Center cancels
          Haptics.selectionAsync().catch(() => {});
        }
      }

      setCurrentTouchPoint(null);
      touchStartPosRef.current = null;
    },
    [handleSelectProfile, radialOrigin]
  );

  const previewPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (evt: GestureResponderEvent) => {
          // Only single-finger touches; 3-finger calibration handled by ThreeFingerGestureDetector
          return evt.nativeEvent.touches.length === 1;
        },
        onMoveShouldSetPanResponder: () => true,
        onPanResponderStart: (_evt: GestureResponderEvent, gestureState: PanResponderGestureState) => {
          // A second or third finger landing means this is the 3-finger calibration
          // gesture, not a radial-selector hold. React Native only reports the extra
          // fingers through onResponderStart, so the check in onPanResponderGrant
          // below never re-runs for them (the first finger always arrives alone and
          // that is when this view becomes the responder).
          if (gestureState.numberActiveTouches > 1) {
            cancelLongPressTimer();
            if (isRadialOpenRef.current) {
              isRadialOpenRef.current = false;
              setIsRadialOpen(false);
            }
            setCurrentTouchPoint(null);
            touchStartPosRef.current = null;
            currentTouchRef.current = null;
          }
        },
        onPanResponderGrant: (evt: GestureResponderEvent) => {
          const { pageX, pageY, touches } = evt.nativeEvent;
          if (touches && touches.length > 1) {
            cancelLongPressTimer();
            return;
          }

          touchStartPosRef.current = { x: pageX, y: pageY };
          currentTouchRef.current = { x: pageX, y: pageY };
          touchStartTimeRef.current = Date.now();
          cancelLongPressTimer();

          // 350ms hold threshold to activate radial selector
          longPressTimerRef.current = setTimeout(() => {
            const startPt = touchStartPosRef.current ?? { x: pageX, y: pageY };
            setRadialOrigin(startPt);
            setCurrentTouchPoint(startPt);
            isRadialOpenRef.current = true;
            setIsRadialOpen(true);
            longPressTimerRef.current = null;
          }, 350);
        },
        onPanResponderMove: (evt: GestureResponderEvent) => {
          const { pageX, pageY } = evt.nativeEvent;
          currentTouchRef.current = { x: pageX, y: pageY };

          if (isRadialOpenRef.current) {
            setCurrentTouchPoint({ x: pageX, y: pageY });
          } else if (touchStartPosRef.current) {
            const dx = pageX - touchStartPosRef.current.x;
            const dy = pageY - touchStartPosRef.current.y;
            if (Math.hypot(dx, dy) > 15) {
              cancelLongPressTimer();
            }
          }
        },
        onPanResponderRelease: (evt: GestureResponderEvent) => {
          const { pageX, pageY } = evt.nativeEvent;
          // Snapshot BEFORE finalizeRadialSelection clears the touch bookkeeping.
          const start = touchStartPosRef.current;
          const moved = start ? Math.hypot(pageX - start.x, pageY - start.y) : Infinity;
          const elapsed = Date.now() - touchStartTimeRef.current;
          const wasRadialOpen = isRadialOpenRef.current;

          finalizeRadialSelection(pageX, pageY);

          // Quick, steady release = tap-to-focus (the radial gesture never opened).
          if (!wasRadialOpen && moved <= 15 && elapsed < 350) {
            handleTapToFocus(pageX, pageY);
          }
        },
        onPanResponderTerminate: () => {
          finalizeRadialSelection();
        },
      }),
    [finalizeRadialSelection, handleTapToFocus]
  );

  // -------------------------------------------------------------
  // 10. Startup State Views (permission explainer / initial mount error)
  // -------------------------------------------------------------
  const handleEnableCamera = useCallback(() => {
    // The user opted in on the explainer — the next startCamera triggers the system dialog.
    didAutoStartRef.current = true;
    initializeCameraSession();
  }, [initializeCameraSession]);

  // The native CameraEngineView MUST be mounted in every early-return branch: startCamera
  // rejects with ERR_NO_ACTIVE_VIEW while no view exists, so the system permission dialog
  // would never appear (the run-14 regression). The explainer just overlays it.
  if (permissionState === 'checking') {
    return (
      <View style={styles.rootContainer}>
        <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
        <CameraEngineView
          style={StyleSheet.absoluteFillObject}
          profile={activeProfile as unknown as Record<string, unknown>}
        />
        <CameraLoadingView message="Preparing camera..." />
      </View>
    );
  }

  if (permissionState === 'notDetermined' || permissionState === 'denied') {
    const denied = permissionState === 'denied';
    return (
      <View style={styles.rootContainer}>
        <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
        <CameraEngineView
          style={StyleSheet.absoluteFillObject}
          profile={activeProfile as unknown as Record<string, unknown>}
        />
        <View style={StyleSheet.absoluteFillObject}>
          <PermissionRequestView
            statusMessage={
              denied
                ? 'Camera access is currently disabled. Enable it in Settings — the camera is only used for the viewfinder and photos.'
                : 'Camera 18 simulates classic film cameras. The camera is used for the live viewfinder; photos are saved with add-only photo access.'
            }
            primaryLabel={denied ? 'Open Settings' : 'Continue'}
            onRequestPermission={
              denied
                ? () => {
                    Linking.openSettings().catch(() => {});
                  }
                : handleEnableCamera
            }
            secondaryLabel={denied ? 'Retry Camera' : undefined}
            onSecondary={denied ? handleEnableCamera : undefined}
          />
        </View>
      </View>
    );
  }

  if (cameraInitError && !isCameraRunning) {
    return (
      <View style={styles.rootContainer}>
        <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
        <CameraEngineView
          style={StyleSheet.absoluteFillObject}
          profile={activeProfile as unknown as Record<string, unknown>}
        />
        <View style={StyleSheet.absoluteFillObject}>
          <CameraErrorView
            error={cameraInitError}
            onRetry={() => {
              setCameraInitError(null);
              initializeCameraSession();
            }}
          />
        </View>
      </View>
    );
  }

  // -------------------------------------------------------------
  // 11. Main Camera Interface (Camera always mounted)
  // -------------------------------------------------------------
  return (
    <View style={styles.rootContainer}>
      <StatusBar barStyle="light-content" hidden={false} translucent backgroundColor="transparent" />

      {/* 3-Finger Gesture Handler wraps the interactive camera surface (~2 sec hold opens CalibrationModal) */}
      <ThreeFingerGestureDetector onTriggerCalibration={() => setIsCalibrationOpen(true)}>
        <View style={styles.fullScreen}>
          {/* 1. Native Camera Engine View — 4:3 viewfinder rect, top edge like the system camera.
              The profile prop carries the aperture-linked bloom/starburst factors so the
              live preview shows the same visual system the final capture will use. */}
          <CameraEngineView
            style={styles.viewfinder}
            profile={(effectiveProfile ?? activeProfile) as unknown as Record<string, unknown>}
          />

          {/* Initial Loading overlay without unmounting camera */}
          {isLoading && !isCameraRunning && (
            <View style={StyleSheet.absoluteFillObject}>
              <CameraLoadingView />
            </View>
          )}

          {/* Lightweight JSON-derived preview overlay removed: the native WYSIWYG pipeline
              (CameraDNARenderer .preview) is the single preview filter. No JS-side coloring. */}

          {/* Tap-to-focus indicator (visual only) */}
          <FocusIndicator point={focusIndicator} />

          {/* Empty preview touch area for original preview responder */}
          <View
            style={styles.viewfinderTouchArea}
            {...previewPanResponder.panHandlers}
          />

          {/* 2. Top Bar: current simulated camera name; tapping opens the formal Camera Selector */}
          <View style={styles.topControlsContainer} pointerEvents="box-none">
            <TopBar
              profileName={activeProfile?.displayName ?? activeProfile?.name}
              marker={activeProfile?.ui?.markerStyle}
              accent={activeProfile?.ui?.accent}
              onPress={() => setIsSelectorOpen(true)}
            />
          </View>

          {/* Focal/Aperture dial: always mounted (it carries the honest Fixed ƒ/x display) */}
          <View style={styles.dialContainer} pointerEvents="box-none">
            <FocalApertureDial
              stops={focalStops}
              currentFocalMm={currentFocalMm}
              onSelectFocal={(stop) => { void handleSelectFocal(stop); }}
              currentAperture={currentAperture}
              availableApertures={availableApertures}
              isVariableAperture={supportsVariableAperture}
              onApertureChange={handleApertureChange}
            />
          </View>

          {/* Transient Error Banner while running (does not unmount camera) */}
          {transientError && (
            <View style={styles.transientErrorContainer} pointerEvents="box-none">
              <View style={styles.transientErrorPill}>
                <Text style={styles.transientErrorIcon}>⚠️</Text>
                <Text style={styles.transientErrorText} numberOfLines={3}>
                  {transientError}
                </Text>
              </View>
            </View>
          )}

          {/* Bottom Bar: Shutter & Recent Thumbnail (aperture moved into the dial) */}
          <View style={styles.bottomControlsContainer} pointerEvents="box-none">
            {/* Bottom Actions Row: Recent Thumbnail & Shutter Button */}
            <View style={styles.bottomActionRow}>
              {/* 5. Lower-left Recent Photo Thumbnail (tap opens the photo library) */}
              <View style={styles.thumbnailSlot}>
                <ThumbnailPreview
                  uri={latestThumbnail}
                  onPress={
                    latestThumbnail
                      ? () => {
                          Linking.openURL('photos-redirect://').catch(() => {});
                        }
                      : undefined
                  }
                />
              </View>

              {/* 4. Centered Shutter Button */}
              <View style={styles.shutterSlot}>
                <ShutterButton
                  isCapturing={capturePhase === 'capturing'}
                  onPress={handleCapturePhoto}
                />
              </View>

              {/* Symmetrical Spacer Slot to keep Shutter centered */}
              <View style={styles.spacerSlot} />
            </View>
          </View>

          {/* Shutter Flash Curtain Overlay */}
          <Animated.View
            style={[
              StyleSheet.absoluteFillObject,
              styles.shutterFlashCurtain,
              { opacity: shutterFlashAnim },
            ]}
            pointerEvents="none"
          />

          {/* 7. Radial Selector (profile count adaptive) (Visual only; preview responder finalizes on release) */}
          <RadialProfileSelector
            visible={isRadialOpen}
            initialTouch={radialOrigin}
            currentTouch={currentTouchPoint}
            profiles={profiles}
            activeProfileId={activeProfile?.id}
          />

          {/* 7b. Formal Camera Selector (tap the top camera badge) */}
          <CameraSelector
            visible={isSelectorOpen}
            profiles={profiles}
            activeProfileId={activeProfile?.id}
            onSelectProfile={handleSelectProfile}
            onClose={() => setIsSelectorOpen(false)}
          />

          {/* 8. Hardware & Lens Calibration Modal (Triggered by 3-finger ~2s hold) */}
          <CalibrationModal
            visible={isCalibrationOpen}
            onClose={() => setIsCalibrationOpen(false)}
          />
        </View>
      </ThreeFingerGestureDetector>
    </View>
  );
}

/**
 * Top-Level App Entry wrapped in StartupErrorBoundary + ProfileProvider.
 * The boundary is the production safety net: without it an uncaught render error would
 * leave a silent full-black screen; with it the phone shows the actual error text.
 */
export default function App(): React.JSX.Element {
  return (
    <StartupErrorBoundary>
      <ProfileProvider>
        <CameraAppScreen />
      </ProfileProvider>
    </StartupErrorBoundary>
  );
}

const styles = StyleSheet.create({
  rootContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  fullScreen: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#000000',
  },
  viewfinderTouchArea: {
    ...StyleSheet.absoluteFillObject,
    top: VIEWFINDER_TOP,
    bottom: SCREEN_HEIGHT - VIEWFINDER_BOTTOM,
  },
  viewfinder: {
    position: 'absolute',
    top: VIEWFINDER_TOP,
    left: 0,
    width: SCREEN_WIDTH,
    height: VIEWFINDER_HEIGHT,
  },
  topControlsContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  dialContainer: {
    position: 'absolute',
    // Centered above the shutter row, overlapping the viewfinder's lower edge —
    // the same visual position as the system camera's zoom dial.
    bottom: 162,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 21,
  },
  transientErrorContainer: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 88 : 68,
    left: 16,
    right: 16,
    alignItems: 'center',
    zIndex: 100,
  },
  transientErrorPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(215, 38, 38, 0.94)',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    maxWidth: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 8,
  },
  transientErrorIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  transientErrorText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'center',
  },
  bottomControlsContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    // Enough clearance that the shutter clears the home indicator on every device —
    // all controls must stay fully inside the screen.
    paddingBottom: Platform.OS === 'ios' ? 52 : 28,
    paddingTop: 8,
    alignItems: 'center',
    zIndex: 20,
  },
  bottomActionRow: {
    flexDirection: 'row',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
    marginTop: 10,
  },
  thumbnailSlot: {
    width: 60,
    alignItems: 'flex-start',
  },
  shutterSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  spacerSlot: {
    width: 60,
  },
  shutterFlashCurtain: {
    backgroundColor: '#FFFFFF',
    zIndex: 50,
  },
});

