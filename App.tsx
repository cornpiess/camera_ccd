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
  Image,
  Linking,
  Modal,
  Platform,
  PanResponder,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from 'react-native';import * as Haptics from 'expo-haptics';
import { File, Paths } from 'expo-file-system';

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
import { loadCameraState, saveCameraState, type CameraState } from './src/camera/cameraStateStore';
import { buildFocalStops, defaultFocalStop, type FocalStop, type DeviceKind } from './src/camera/focalLadder';
import { addApertureChangedListener, addZoomChangedListener } from './src/camera/CameraEngine';
import { apertureVisualFactors, applyApertureVisual } from './src/camera/apertureVisualProfile';
import { MAX_RING_PROFILES } from './src/components/RadialProfileSelector';
import { deriveSkin, isLightColor } from './src/theme/skin';

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
  FocalCircleRow,
  ApertureBar,
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

const SCREEN_WIDTH_FALLBACK = Dimensions.get('window').width;
const SCREEN_HEIGHT_FALLBACK = Dimensions.get('window').height;

installDiagLog();

/**
 * Viewfinder layout — the interface is PORTRAIT-LOCKED (the canonical camera-app choice:
 * controls never move relative to the hand; the capture CONTENT rotates instead via the
 * native connection orientation). The viewfinder is the exact 4:3 capture frame: a
 * full-width band below the top capsule, rounded-rect card clipped.
 *
 * All geometry derives from useWindowDimensions() (defensive for any future rotation).
 */
const STATUS_BAR_HEIGHT = Platform.OS === 'ios' ? 47 : (StatusBar.currentHeight ?? 24);
/** Status bar + the camera capsule. */
const TOP_BAND = Math.round(STATUS_BAR_HEIGHT + 70);
/** Minimum room for the aperture strip (96pt: side view + tick scale) + shutter row. */
const MIN_BOTTOM_BAND = 256;

interface FinderRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function computeFinderRect(width: number, height: number): FinderRect {
  // Portrait formula (widths > heights never occur with the portrait lock; the math is
  // width-driven either way so a future landscape policy only needs the band constants).
  const maxWidth = Math.round(Math.min(width, (height - TOP_BAND - MIN_BOTTOM_BAND) * (3 / 4)));
  const frameWidth = Math.max(200, Math.min(width, maxWidth));
  const frameHeight = Math.round(frameWidth * (4 / 3));
  const top = TOP_BAND + Math.max(0, Math.round((height - TOP_BAND - MIN_BOTTOM_BAND - frameHeight) / 2));
  return { left: Math.round((width - frameWidth) / 2), top, width: frameWidth, height: frameHeight };
}

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
  // Live dimensions: the whole interface rotates with the device, so every band of the
  // layout recomputes on rotation (canonical camera-app behavior).
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();
  const finder = useMemo(() => computeFinderRect(SCREEN_WIDTH, SCREEN_HEIGHT), [SCREEN_WIDTH, SCREEN_HEIGHT]);

  // -------------------------------------------------------------
  // 1. Profile State exclusively via useProfiles() JSON state
  // -------------------------------------------------------------
  const { profiles, currentProfile, currentProfileId, selectProfile, errors: profileErrors } = useProfiles();
  const activeProfile = currentProfile ?? profiles[0] ?? null;

  // Per-camera UI skin: the interface chrome takes the camera's identity color
  // (muted, brand-evocative — e.g. textured Leica red, pale Ricoh film green).
  const skin = useMemo(
    () => deriveSkin(activeProfile?.ui?.accent as string | undefined),
    [activeProfile?.ui?.accent],
  );

  // -------------------------------------------------------------
  // 2. Camera Engine Hardware State
  // -------------------------------------------------------------
  // App Store-style permission flow: probe WITHOUT triggering the system dialog, show an
  // explainer first, and only start the session (which may request access) on user action.
  const [permissionState, setPermissionState] = useState<CameraAuthorizationStatus | 'checking'>('checking');
  const [cameraInitError, setCameraInitError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isCameraRunning, setIsCameraRunning] = useState<boolean>(false);

  // Aperture hardware capability states — the control is CONTINUOUS (无极): the underlying
  // API (iOS 27 setExposureModeCustom(lensAperture:)) takes an arbitrary f-number inside
  // [minAperture, maxAperture]; recommended stops are hints, not limits.
  const [supportsVariableAperture, setSupportsVariableAperture] = useState<boolean>(false);
  const [activeAperture, setActiveAperture] = useState<number>(1.8);
  const [currentAperture, setCurrentAperture] = useState<number>(1.8);
  const [apertureRange, setApertureRange] = useState<{ min: number; max: number } | null>(null);
  const capabilitiesRef = useRef<CameraCapabilities | null>(null);
  // Last hardware-confirmed f-stop; the ring reverts here when setAperture rejects.
  const confirmedApertureRef = useRef<number>(1.8);

  // Rear lens inventory → derived focal stops for the dial (13/26/35/52 on virtual dual,
  // +78/156 on triple; single-wide bodies get 26/35/52).
  const [focalStops, setFocalStops] = useState<FocalStop[]>([]);
  const [currentFocalMm, setCurrentFocalMm] = useState<number | null>(null);
  const currentFocalMmRef = useRef<number | null>(null);
  currentFocalMmRef.current = currentFocalMm;

  // Photo Capture & Preview states
  const [capturePhase, setCapturePhase] = useState<CapturePhase>('idle');
  const [latestThumbnail, setLatestThumbnail] = useState<string | null>(null);
  // Full-resolution file of THIS session's last shot (temp file; not persisted). The
  // photo viewer prefers it and falls back to the persisted 512px thumbnail after restart.
  const [lastCaptureFileUri, setLastCaptureFileUri] = useState<string | null>(null);
  const [photoViewerUri, setPhotoViewerUri] = useState<string | null>(null);
  // Per-capture display copy of the thumbnail (RN Image caches by URI; the native
  // persisted path is stable, so without this the chip keeps showing the first shot).
  const chipFileRef = useRef<string | null>(null);
  // Persistent, tappable remediation when the photo-library ADD permission is denied —
  // a 4-second transient banner was too easy to miss, which read as "photos don't save".
  const [photoPermDenied, setPhotoPermDenied] = useState<boolean>(false);

  // Tracks whether the native session started successfully (used by the AppState recovery path)
  const cameraRunningRef = useRef<boolean>(false);

  // Persisted camera memory: last profile + per-profile last user-chosen aperture.
  // Loaded async once on mount; restore happens after both profiles and state are ready.
  const cameraStateRef = useRef<CameraState>({ lastProfileId: null });
  const [cameraStateLoaded, setCameraStateLoaded] = useState(false);
  const restoreAttemptedRef = useRef(false);
  useEffect(() => {
    let mounted = true;
    loadCameraState().then((state) => {
      if (!mounted) return;
      cameraStateRef.current = state;
      // Restore the latest-shot chip: the thumbnail lives at a STABLE Documents path now.
      if (state.lastThumbUri) setLatestThumbnail(state.lastThumbUri);
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
  /**
   * Aperture DEMO mode (fixed-lens devices): the ring is fully interactive by DEFAULT so
   * the wheel feel exists on e.g. iPhone 14 Plus — bloom/starburst linkage only, the
   * capture always stays at the lens's fixed aperture and the bar is labeled DEMO.
   * Depth/bokeh is never faked (red line 4). Toggle off in the calibration panel.
   */
  const [apertureDemoMode, setApertureDemoMode] = useState<boolean>(true);
  // Capability-driven SIMULATED aperture (native .simulated mode): the ring stays a real
  // control — the chosen f-number drives capture-time blur/starburst — but the lens has
  // no physical iris, so it is NOT "variable hardware".
  const [apertureSimulated, setApertureSimulated] = useState<boolean>(false);
  // Developer-mode extra: side-view lens cross-section above the tick scale (default off).
  const [apertureSideView, setApertureSideView] = useState<boolean>(false);
  // (The old ultra-wide fixed-aperture note is retired: simulated aperture keeps the
  // ring live on every lens, so no lens disables the control anymore.)
  /** Continuous demo range for fixed-lens devices (like a fast compact: ƒ/1.48–ƒ/4). */
  const DEMO_APERTURE_RANGE = useMemo(() => ({ min: 1.48, max: 4 }), []);

  // -------------------------------------------------------------
  // 4b. Formal Camera Selector (top-badge entry) & Tap-to-Focus states
  // -------------------------------------------------------------
  const [isSelectorOpen, setIsSelectorOpen] = useState<boolean>(false);
  const [focusIndicator, setFocusIndicator] = useState<FocusPoint | null>(null);

  // -------------------------------------------------------------
  // 5. Radial Profile Selector State (Long-press on empty preview)
  // -------------------------------------------------------------
  const [isRadialOpen, setIsRadialOpen] = useState<boolean>(false);
  const [radialOrigin, setRadialOrigin] = useState<Point>({
    x: SCREEN_WIDTH_FALLBACK / 2,
    y: SCREEN_HEIGHT_FALLBACK / 2,
  });
  const [currentTouchPoint, setCurrentTouchPoint] = useState<Point | null>(null);

  // Live screen dims for gesture math (rotation-aware; refs avoid responder closures
  // capturing stale values).
  const screenDimsRef = useRef({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT });
  screenDimsRef.current = { width: SCREEN_WIDTH, height: SCREEN_HEIGHT };

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

      // Start with a bounded retry: on the very first authorized launch the native view
      // may still be registering while the state branches swap, and startCamera would
      // reject with ERR_NO_ACTIVE_VIEW. One quiet retry 250ms later always succeeds —
      // surfacing that as a "Retry Camera" screen was a false alarm (kill+relaunch bug).
      let lastStartError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await CameraEngine.startCamera();
          lastStartError = null;
          break;
        } catch (err: unknown) {
          lastStartError = err;
          const isNoActiveView = err instanceof CameraEngineError && err.code === 'ERR_NO_ACTIVE_VIEW';
          if (!isNoActiveView || attempt === 2) throw err;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      void lastStartError;
      cameraRunningRef.current = true;
      setIsCameraRunning(true);
      setPermissionState('authorized');

      // Query hardware capabilities
      try {
        const capabilities: CameraCapabilities = await CameraEngine.getCapabilities();
        capabilitiesRef.current = capabilities;
        if (capabilities) {
          // iOS 27 quirk guard: a fixed-aperture lens that still publishes a near-degenerate
          // lens-aperture range must NOT flip the ring into hardware mode — with a tiny span
          // the ring renders no ticks, attaches no gesture and hides the DEMO caption, which
          // reads exactly as "the aperture demo disappeared". Real variable hardware spans
          // ƒ/1.4–ƒ/4 (span 2.6), so 0.3 separates them safely.
          const reportedStops = Array.isArray(capabilities.supportedApertures) ? capabilities.supportedApertures : [];
          const spanOK =
            capabilities.minAperture != null && capabilities.maxAperture != null
              ? capabilities.maxAperture - capabilities.minAperture >= 0.3
              : reportedStops.length > 1;
          const variable = Boolean(capabilities.supportsVariableAperture) && spanOK;
          setSupportsVariableAperture(variable);
          const simulated = capabilities.apertureMode === 'simulated';
          setApertureSimulated(simulated);
          const aperture = capabilities.activeAperture ?? capabilities.activeLensAperture ?? 1.8;
          confirmedApertureRef.current = aperture;
          setActiveAperture(aperture);
          setCurrentAperture(aperture);

          if (variable) {
            if (capabilities.minAperture != null && capabilities.maxAperture != null) {
              setApertureRange({ min: capabilities.minAperture, max: capabilities.maxAperture });
            } else if (Array.isArray(capabilities.supportedApertures) && capabilities.supportedApertures.length > 1) {
              // Degenerate report without a range: synthesize one from the suggested stops.
              const stops = [...capabilities.supportedApertures].sort((a, b) => a - b);
              setApertureRange({ min: stops[0]!, max: stops[stops.length - 1]! });
            } else {
              setApertureRange(null);
            }
          } else if (simulated) {
            // Simulation grid — same f/1.4-4 range as the physical iris (unified ring).
            setApertureRange({ min: 1.4, max: 4 });
          } else {
            setApertureRange(null);
          }
        }
      } catch {
        setSupportsVariableAperture(false);
        setApertureSimulated(false);
        confirmedApertureRef.current = 1.8;
        setActiveAperture(1.8);
        setCurrentAperture(1.8);
        setApertureRange(null);
      }

      // Device kind → derive the focal-stop ladder for the dial (virtual devices get the
      // seamless system crossfade; zoom re-applies because sessions reset zoom on restart).
      try {
        const info = await CameraEngine.getAvailableLenses();
        const kind = (info?.kind ?? 'single') as DeviceKind;
        const stops = buildFocalStops(kind, { teleZoom: info?.teleZoom ?? null });
        setFocalStops(stops);
        setCurrentFocalMm((previous) => previous ?? defaultFocalStop(kind).mm);
        const engaged = stops.find((stop) => stop.mm === (currentFocalMmRef.current ?? defaultFocalStop(kind).mm));
        if (engaged) {
          await CameraEngine.setZoomFactor(engaged.zoom);
        }
      } catch {
        // Single-lens fallbacks stay on the previous state.
      }
    } catch (err: unknown) {
      cameraRunningRef.current = false;
      // Surface the failure: a swallowed error here rendered as a silent black
      // viewfinder with no way to recover (background+foreground used to "fix" it).
      setIsCameraRunning(false);
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
  // backgrounded. startCamera is IDEMPOTENT natively (configured + running → no-op),
  // so a lightweight restart call is enough — the old full initializeCameraSession
  // here reset the user's DEMO aperture and flashed the loading overlay on EVERY
  // foreground return. Zoom is re-asserted because some iOS versions drop the
  // videoZoomFactor when they suspend the session.
  // -------------------------------------------------------------
  const focalStopsRef = useRef<FocalStop[]>([]);
  focalStopsRef.current = focalStops;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !cameraRunningRef.current) return;
      CameraEngine.startCamera()
        .then(() => {
          setPermissionState('authorized');
          const engaged = focalStopsRef.current.find((stop) => stop.mm === currentFocalMmRef.current);
          if (engaged) CameraEngine.setZoomFactor(engaged.zoom).catch(() => {});
        })
        .catch((err: unknown) => {
          recordDiag('warn', `foreground resume failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    });
    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------
  // 7. Apply profile in separate effect WITHOUT restarting camera
  // -------------------------------------------------------------
  // ApertureVisualProfile (§20/§21): one f-stop drives bloom + starburst together.
  // Depth is NOT software-faked (red line 4); on real variable-aperture hardware the
  // optics handle it. Neutral factors on fixed lenses keep profiles exactly as calibrated.
  const apertureVisual = useMemo(
    () => {
      const demo = !supportsVariableAperture && !apertureSimulated && apertureDemoMode;
      const range = supportsVariableAperture
        ? (apertureRange ?? { min: capabilitiesRef.current?.minAperture ?? null, max: capabilitiesRef.current?.maxAperture ?? null })
        : (apertureSimulated
          ? (apertureRange ?? { min: 1.4, max: 4 })
          : (demo ? DEMO_APERTURE_RANGE : { min: null, max: null }));
      return apertureVisualFactors(
        currentAperture,
        supportsVariableAperture || apertureSimulated || demo,
        range.min,
        range.max,
      );
    },
    [currentAperture, supportsVariableAperture, apertureSimulated, apertureDemoMode, DEMO_APERTURE_RANGE, apertureRange],
  );
  const effectiveProfile = useMemo(
    () => (activeProfile ? applyApertureVisual(activeProfile as unknown as Record<string, unknown>, apertureVisual) : null),
    [activeProfile, apertureVisual],
  );

  // The profile reaches the renderer through the DECLARATIVE `profile` prop on
  // <CameraEngineView> alone (below). The old applyProfile effect here was a second
  // channel onto the same native setProfile — on aperture moves it fired the bridge
  // twice per tick. The native side additionally fingerprints the color payload, so a
  // re-applied unchanged profile no longer rebuilds the compiled color cube at all.

  // Recommended-aperture default (product decision 2026-09-13): SELECTING a camera snaps
  // the ring to that profile's aperture.preferred (e.g. Ricoh GR → ƒ/2.8); the user then
  // adjusts from there. Guarded by profile id so the aperture-driven effectiveProfile
  // re-renders never re-apply it mid-drag (the effect would otherwise fight the finger).
  const preferredApertureProfileRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isCameraRunning || !activeProfile) return;
    if (preferredApertureProfileRef.current === activeProfile.id) return;
    preferredApertureProfileRef.current = activeProfile.id;
    const preferred = activeProfile.aperture?.preferred;
    if (typeof preferred !== 'number' || !Number.isFinite(preferred) || preferred <= 0) return;
    if (supportsVariableAperture || apertureSimulated) {
      const min = capabilitiesRef.current?.minAperture ?? apertureRange?.min ?? preferred;
      const max = capabilitiesRef.current?.maxAperture ?? apertureRange?.max ?? preferred;
      const clamped = Math.min(Math.max(preferred, min), max);
      CameraEngine.setAperture(clamped)
        .then(() => {
          confirmedApertureRef.current = clamped;
        })
        .catch(() => {});
      setCurrentAperture(clamped);
      setActiveAperture(clamped);
    } else {
      // Demo/fixed lenses: visual-only snap — the capture stays at the fixed aperture.
      setCurrentAperture(preferred);
      setActiveAperture(preferred);
    }
  }, [activeProfile, isCameraRunning, supportsVariableAperture, apertureSimulated, apertureRange]);

  // Native -> ApertureState sync: the Camera Control slider (and any native aperture
  // source) flows back here so the SCREEN RING always shows the same f-number. There is
  // exactly ONE ApertureState; every entry point converges on it.
  useEffect(() => {
    const apertureSub = addApertureChangedListener((event) => {
      const f = Number(event?.fNumber);
      if (!Number.isFinite(f) || f <= 0) return;
      confirmedApertureRef.current = f;
      setCurrentAperture(f);
      setActiveAperture(f);
    });
    const zoomSub = addZoomChangedListener((event) => {
      const zoom = Number(event?.zoom);
      if (!Number.isFinite(zoom) || zoom <= 0) return;
      // Physical main camera: 35mm-equiv = 26mm x zoom. Snap the dial to the nearest stop.
      const mm = 26 * zoom;
      const nearest = focalStops.reduce((best, stop) =>
        Math.abs(stop.mm - mm) < Math.abs(best.mm - mm) ? stop : best,
      );
      setCurrentFocalMm(nearest.mm);
    });
    return () => {
      apertureSub.remove();
      zoomSub.remove();
    };
  }, [focalStops]);

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
  // Per-move: update the UI ONLY so the marker tracks the finger at touch rate. The
  // hardware commit happens exactly once per gesture in handleApertureSettle — the old
  // code called CameraEngine.setAperture on EVERY move event, queueing dozens of
  // lockForConfiguration commands on the native session queue per drag (capture lag
  // right after a drag, and a command storm on real variable-aperture hardware).
  const handleApertureChange = (aperture: number) => {
    if (!supportsVariableAperture && !apertureSimulated && !apertureDemoMode) {
      // Fixed devices without the demo ring never move.
      return;
    }
    setCurrentAperture(aperture);
    setActiveAperture(aperture);
  };

  // Gesture end → ONE hardware commit (aperture-priority: shutter/ISO stay automatic).
  // Reverts to the last confirmed stop when the hardware rejects, and self-heals a lens
  // misreported as variable (iOS 27 quirk) by demoting to fixed + DEMO for the session.
  const handleApertureSettle = (aperture: number) => {
    if (!supportsVariableAperture && !apertureSimulated) return;
    const min = capabilitiesRef.current?.minAperture ?? apertureRange?.min ?? aperture;
    const max = capabilitiesRef.current?.maxAperture ?? apertureRange?.max ?? aperture;
    const clamped = Math.min(Math.max(aperture, min), max);
    CameraEngine.setAperture(clamped)
      .then(() => {
        confirmedApertureRef.current = clamped;
        setCurrentAperture(clamped);
        setActiveAperture(clamped);
      })
      .catch((err: unknown) => {
        setCurrentAperture(confirmedApertureRef.current);
        setActiveAperture(confirmedApertureRef.current);
        if (err instanceof CameraEngineError && err.code === 'ERR_APERTURE_UNSUPPORTED') {
          setSupportsVariableAperture(false);
          setApertureDemoMode(true);
          recordDiag('warn', 'aperture: hardware rejected setAperture — demoted to fixed + DEMO for this session');
        }
        showTransientError(resolveErrorMessage(err));
      });
  };

  /**
   * Focal-stop selection — the Apple virtual-device path: EVERY stop (including zoom 1.0)
   * is a videoZoomFactor move, so the system crossfades between physical cameras and no
   * state can linger (the old "skip when zoom===1" bug left 1.35× residue, making 35→26
   * a no-op). Journaled to the diag log; the mm display reverts on failure.
   */
  const handleSelectFocal = useCallback(async (stop: FocalStop) => {
    const previousMm = currentFocalMm;
    try {
      recordDiag('info', `focal: select ${stop.mm}mm (zoom=${stop.zoom}) from ${previousMm}mm`);
      await CameraEngine.setZoomFactor(stop.zoom);
      recordDiag('info', `focal: zoom ${stop.zoom} applied`);
      setCurrentFocalMm(stop.mm);
    } catch (err: unknown) {
      recordDiag('error', `focal: select ${stop.mm}mm FAILED: ${err instanceof Error ? err.message : String(err)}`);
      // Never leave the dial claiming a focal the optics did not reach.
      if (previousMm != null) setCurrentFocalMm(previousMm);
      showTransientError(resolveErrorMessage(err));
    }
  }, [currentFocalMm, showTransientError]);

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
      setPhotoPermDenied(false);
      recordDiag('info', `capture: saved (fallback=${Boolean(result?.processingFallback)}, thumb=${Boolean(result?.thumbnailUri)}, zoom=${result?.appliedZoom?.toFixed(2) ?? '?'} → ${result?.equivalentFocal ?? '?'}mm eq)`);
      const thumbUri = result?.thumbnailUri ?? result?.fileUri ?? null;
      setLastCaptureFileUri(result?.fileUri ?? null);
      if (thumbUri) {
        // RN Image caches by URI: the native persisted thumbnail path is STABLE, so the
        // chip would keep showing the first shot's bitmap. Copy to a per-capture display
        // file (dropping the previous one) so every capture gets a fresh URI.
        void (async () => {
          let display = thumbUri;
          try {
            const dest = new File(Paths.document, `camera18-chip-${Date.now()}.jpg`);
            if (dest.exists) dest.delete();
            new File(thumbUri).copy(dest);
            if (chipFileRef.current) {
              try {
                const prev = new File(chipFileRef.current);
                if (prev.exists) prev.delete();
              } catch {
                // stale chip cleanup is best-effort
              }
            }
            chipFileRef.current = dest.uri;
            display = dest.uri;
          } catch {
            // fall back to the native stable copy
          }
          setLatestThumbnail(display);
          cameraStateRef.current.lastThumbUri = display;
          saveCameraState({ lastThumbUri: display });
        })();
      }
      if (result?.processingFallback) {
        showTransientError('Camera DNA processing failed — the original photo was saved.');
      }
    } catch (err: unknown) {
      const code = err instanceof CameraEngineError ? err.code : 'unknown';
      recordDiag('error', `capture: FAILED (${code}): ${err instanceof Error ? err.message : String(err)}`);
      // A denied add-only photo permission is easy to miss as a 4s banner and reads as
      // "photos don't save" — surface it as a persistent, tappable remediation pill.
      if (code === 'ERR_PHOTO_PERMISSION_DENIED') setPhotoPermDenied(true);
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
   * shows a lightweight indicator. The tap is normalized against the finder rect (which
   * IS the 4:3 frame); the native side maps it through its letterbox math, staying
   * correct in both orientations.
   */
  const handleTapToFocus = useCallback(
    (pageX: number, pageY: number) => {
      if (!isCameraRunning) return;
      setFocusIndicator({ x: pageX, y: pageY, key: Date.now() });

      const nx = Math.min(1, Math.max(0, (pageX - finder.left) / finder.width));
      const ny = Math.min(1, Math.max(0, (pageY - finder.top) / finder.height));
      CameraEngine.setFocusPoint(nx, ny).catch(() => {});
    },
    [isCameraRunning, finder],
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
        const { width: liveW, height: liveH } = screenDimsRef.current;
        const clampedCenter = getClampedCenter(origin, liveW, liveH);
        // MUST match the ring's own cap (RadialProfileSelector MAX_RING_PROFILES): the
        // sector math resolves over the SAME node count the ring draws, or nodes 9+ on a
        // >8-profile library would highlight one camera but select another.
        const displayProfiles = profilesRef.current.slice(0, MAX_RING_PROFILES);
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

  // -------------------------------------------------------------
  // 11. Main Camera Interface — SINGLE native view, state overlays on top.
  // The CameraEngineView is mounted exactly once for every app state: swapping branches
  // used to unmount/remount the native view and race startCamera into ERR_NO_ACTIVE_VIEW
  // (kill+relaunch showed a false "Retry Camera" screen) and swallowed restart failures
  // rendered as a permanent black viewfinder. Overlays block touches; the view never moves.
  // -------------------------------------------------------------
  const permissionOverlayVisible =
    permissionState === 'checking' ||
    permissionState === 'notDetermined' ||
    permissionState === 'denied' ||
    (cameraInitError !== null && !isCameraRunning);

  return (
    <View style={[styles.rootContainer, { backgroundColor: skin.chrome }]}>
      <StatusBar barStyle="light-content" hidden={false} translucent backgroundColor="transparent" />

      {/* The one and only native preview. The profile prop carries the aperture-linked
          bloom/starburst factors so the live preview shows the same visual system the
          final capture will use. The rect tracks rotation via live window dimensions;
          the rounded-rect card (Dazz-style) is clipped natively via cornerRadius. */}
      <CameraEngineView
        style={[
          styles.viewfinder,
          { left: finder.left, top: finder.top, width: finder.width, height: finder.height },
        ]}
        cornerRadius={28}
        profile={(effectiveProfile ?? activeProfile) as unknown as Record<string, unknown>}
      />

      <ThreeFingerGestureDetector onTriggerCalibration={() => setIsCalibrationOpen(true)}>
        <View style={styles.fullScreen}>
          {/* Viewfinder card edge: a hairline ring matching the native rounded clip,
              giving the finder the "card" read (Dazz-style) without blocking touches. */}
          <View
            pointerEvents="none"
            style={[
              styles.finderCardFrame,
              { left: finder.left, top: finder.top, width: finder.width, height: finder.height },
            ]}
          />

          {/* Tap-to-focus indicator (visual only) */}
          <FocusIndicator point={focusIndicator} />

          {/* Viewfinder touch area: tap-to-focus + long-press radial selector (the finder rect) */}
          {isCameraRunning && !permissionOverlayVisible && (
            <View
              style={[
                styles.viewfinderTouchArea,
                { left: finder.left, top: finder.top, width: finder.width, height: finder.height },
              ]}
              {...previewPanResponder.panHandlers}
            />
          )}

          {/* 2. Top Bar: current simulated camera name; tapping opens the formal Camera Selector */}
          {isCameraRunning && !permissionOverlayVisible && (
            <View style={styles.topControlsContainer} pointerEvents="box-none">
              <TopBar
                profileName={activeProfile?.displayName ?? activeProfile?.name}
                marker={activeProfile?.ui?.markerStyle}
                accent={activeProfile?.ui?.accent}
                skin={skin}
                onPress={() => setIsSelectorOpen(true)}
              />
            </View>
          )}

          {/* Startup state overlays (block all touches beneath) */}
          {permissionState === 'checking' && <CameraLoadingView message="Preparing camera..." />}
          {(permissionState === 'notDetermined' || permissionState === 'denied') && (
            <View style={StyleSheet.absoluteFillObject}>
              <PermissionRequestView
                statusMessage={
                  permissionState === 'denied'
                    ? 'Camera access is currently disabled. Enable it in Settings — the camera is only used for the viewfinder and photos.'
                    : 'Camera 18 simulates classic film cameras. The camera is used for the live viewfinder; photos are saved with add-only photo access.'
                }
                primaryLabel={permissionState === 'denied' ? 'Open Settings' : 'Continue'}
                onRequestPermission={
                  permissionState === 'denied'
                    ? () => {
                        Linking.openSettings().catch(() => {});
                      }
                    : handleEnableCamera
                }
                secondaryLabel={permissionState === 'denied' ? 'Retry Camera' : undefined}
                onSecondary={permissionState === 'denied' ? handleEnableCamera : undefined}
              />
            </View>
          )}
          {cameraInitError && !isCameraRunning && (
            <View style={StyleSheet.absoluteFillObject}>
              <CameraErrorView
                error={cameraInitError}
                onRetry={() => {
                  setCameraInitError(null);
                  initializeCameraSession();
                }}
              />
            </View>
          )}
          {isLoading && isCameraRunning && (
            <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
              <CameraLoadingView />
            </View>
          )}

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

          {/* Photo-saving remediation pill: persistent until a capture succeeds. */}
          {photoPermDenied && isCameraRunning && !permissionOverlayVisible && (
            <View style={styles.photoPermContainer} pointerEvents="box-none">
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Photo saving is off. Open Settings."
                activeOpacity={0.8}
                onPress={() => {
                  Linking.openSettings().catch(() => {});
                }}
                style={[styles.photoPermPill, { borderColor: skin.border }]}
              >
                <Text style={styles.photoPermIcon}>🖼️</Text>
                <Text style={styles.photoPermText}>
                  Photo saving is off — tap to open Settings
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Focal-length circles live INSIDE the viewfinder (system-camera style):
              small chips hugging the finder's bottom edge; the bottom band below is
              reserved for the hero aperture ring. box-none so only chips take touches. */}
          {isCameraRunning && !permissionOverlayVisible && focalStops.length > 0 && (
            <View
              style={[
                styles.focalInFinder,
                { left: finder.left, width: finder.width, top: finder.top + finder.height - 62 },
              ]}
              pointerEvents="box-none"
            >
              <FocalCircleRow
                stops={focalStops}
                currentFocalMm={currentFocalMm}
                accent={skin.accent}
                onSelectFocal={(stop) => { void handleSelectFocal(stop); }}
              />
            </View>
          )}

          {/* Bottom control stack: the hero aperture ring + shutter row. */}
          {isCameraRunning && !permissionOverlayVisible && (
            <View style={[styles.bottomControlsContainer, { backgroundColor: skin.chrome }]} pointerEvents="box-none">
              {
                // Aperture ring: continuous (无极) on EVERY lens — simulated mode keeps
                // it live on ultra-wide/tele (blur + starburst still apply per spec).
                <ApertureBar
                minAperture={
                  supportsVariableAperture || apertureSimulated
                    ? (apertureRange?.min ?? capabilitiesRef.current?.minAperture ?? DEMO_APERTURE_RANGE.min)
                    : DEMO_APERTURE_RANGE.min
                }
                maxAperture={
                  supportsVariableAperture || apertureSimulated
                    ? (apertureRange?.max ?? capabilitiesRef.current?.maxAperture ?? DEMO_APERTURE_RANGE.max)
                    : DEMO_APERTURE_RANGE.max
                }
                currentAperture={currentAperture}
                isVariableAperture={supportsVariableAperture || apertureSimulated || apertureDemoMode}
                onApertureChange={handleApertureChange}
                onApertureSettle={handleApertureSettle}
                simulatedMode={apertureSimulated}
                sideViewEnabled={apertureSideView}
                onToggleSideView={() => setApertureSideView((enabled) => !enabled)}
                accent={skin.accent}
              />
              }

              {/* Bottom Actions Row: Recent Thumbnail & Shutter Button */}
              <View style={styles.bottomActionRow}>
                {/* Library entry only once a photo exists this session — an empty
                    placeholder invited taps that lead nowhere. */}
                <View style={styles.thumbnailSlot}>
                  {latestThumbnail ? (
                    <ThumbnailPreview
                      uri={latestThumbnail}
                      onPress={() => {
                        // In-app full-screen viewer (the system camera's own pattern).
                        // iOS exposes no public way to open the Photos app from a
                        // third-party app — photos-redirect:// is semi-private and fails
                        // outright on current iOS. Prefer this session's full-res temp
                        // file; fall back to the persisted 512px thumbnail.
                        let uri = lastCaptureFileUri;
                        if (uri) {
                          try {
                            if (!new File(uri).exists) uri = null;
                          } catch {
                            uri = null;
                          }
                        }
                        setPhotoViewerUri(uri ?? latestThumbnail);
                      }}
                    />
                  ) : null}
                </View>

                {/* Centered Shutter Button */}
                <View style={styles.shutterSlot}>
                  <ShutterButton
                    isCapturing={capturePhase === 'capturing'}
                    accent={skin.accent}
                    onPress={handleCapturePhoto}
                  />
                </View>

                {/* Symmetrical Spacer Slot to keep Shutter centered */}
                <View style={styles.spacerSlot} />
              </View>
            </View>
          )}

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
            apertureDemoMode={apertureDemoMode}
            onToggleApertureDemo={() => setApertureDemoMode((mode) => !mode)}
            apertureSideView={apertureSideView}
            onToggleApertureSideView={() => setApertureSideView((enabled) => !enabled)}
          />

          {/* Full-screen photo viewer: tap the thumbnail to inspect the last shot.
              The "open in Photos" action is best-effort — photos-redirect:// is
              semi-private and refuses on some iOS versions; the photo itself is
              already saved to the library either way. */}
          <Modal
            animationType="fade"
            onRequestClose={() => setPhotoViewerUri(null)}
            transparent
            visible={photoViewerUri !== null}
          >
            <TouchableOpacity
              accessibilityLabel="Close photo viewer"
              accessibilityRole="button"
              activeOpacity={1}
              onPress={() => setPhotoViewerUri(null)}
              style={styles.photoViewer}
            >
              {photoViewerUri ? (
                <Image
                  resizeMode="contain"
                  source={{ uri: photoViewerUri }}
                  style={styles.photoViewerImage}
                />
              ) : null}
            </TouchableOpacity>
            {photoViewerUri ? (
              <View pointerEvents="box-none" style={styles.photoViewerActions}>
                <TouchableOpacity
                  accessibilityLabel="Open in the Photos app"
                  accessibilityRole="button"
                  style={styles.photoViewerButton}
                  onPress={() => {
                    Linking.openURL('photos-redirect://').catch(() => {
                      showTransientError('此 iOS 无法从这里跳转「照片」——照片已保存在相册，可从主屏幕打开。');
                    });
                  }}
                >
                  <Text style={styles.photoViewerButtonText}>在“照片”中打开</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </Modal>
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
    // MUST stay transparent: the native preview view is a SIBLING underneath this
    // container, and an opaque background here paints a permanent black viewfinder
    // over a perfectly healthy capture session (the black-frame regression).
    backgroundColor: 'transparent',
  },
  viewfinder: {
    position: 'absolute',
    backgroundColor: '#000000',
  },
  finderCardFrame: {
    position: 'absolute',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    zIndex: 5,
  },
  viewfinderTouchArea: {
    position: 'absolute',
  },
  photoPermContainer: {
    position: 'absolute',
    bottom: 268,
    left: 16,
    right: 16,
    alignItems: 'center',
    zIndex: 60,
  },
  photoPermPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(20, 20, 24, 0.92)',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
  },
  photoPermIcon: {
    fontSize: 14,
    marginRight: 8,
  },
  photoPermText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  focalInFinder: {
    position: 'absolute',
    alignItems: 'center',
    zIndex: 15,
  },
  topControlsContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
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
  photoViewer: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.96)',
  },
  photoViewerImage: {
    flex: 1,
    marginTop: 48,
    marginBottom: 48,
  },
  photoViewerActions: {
    position: 'absolute',
    bottom: 56,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  photoViewerButton: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    backgroundColor: 'rgba(30, 30, 34, 0.85)',
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  photoViewerButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  ultraWideNote: {
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ultraWideNoteText: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1,
  },
  bottomControlsContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    // Exactly the BOTTOM_AREA band: focal circles + aperture bar + shutter row.
    paddingBottom: Platform.OS === 'ios' ? 52 : 28,
    paddingTop: 8,
    gap: 8,
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

