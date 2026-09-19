// diagLog must be imported first: it self-installs on import so that any module-evaluation
// error from the imports below (native module resolution included) is already captured.
import { recordDiag } from './src/utils/diagLog';
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
} from 'react-native';
import * as Haptics from 'expo-haptics';
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
import { buildFocalStops, defaultFocalStop, type FocalStop, type PhysicalLens } from './src/camera/focalLadder';
import {
  addApertureChangedListener,
  addPhotoProcessedListener,
  addZoomChangedListener,
  setMockApertureMode,
} from './src/camera/CameraEngine';
import { apertureVisualFactors, applyApertureVisual } from './src/camera/apertureVisualProfile';
import { t, type StringKey } from './src/i18n';
import { MAX_RING_PROFILES } from './src/components/RadialProfileSelector';
import { accessFor } from './src/monetization/CameraAccessPolicy';
import { TRIAL_LIMIT } from './src/monetization/MonetizationConfig';
import { MONETIZATION_ENABLED, SUBSCRIPTIONS_MANAGE_URL } from './src/monetization/MonetizationConfig';
import { showManageSubscriptions } from './src/monetization/Monetization';
import { MonetizationProvider, useMonetization } from './src/monetization/MonetizationProvider';
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
  PaywallModal,
  OnboardingView,
  CURRENT_ONBOARDING_VERSION,
  type PaywallSource,
  getClampedCenter,
  computeRadialSector,
  type Point,
} from './src/components';
// App display version for the CameraSelector footer (the secret test-gate tap target).
import appConfigJson from './app.json';

const SCREEN_WIDTH_FALLBACK = Dimensions.get('window').width;
const SCREEN_HEIGHT_FALLBACK = Dimensions.get('window').height;

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
 * All copy flows through the i18n dictionary (en-first, zh secondary).
 */
const FRIENDLY_ERROR_CODES = [
  'ERR_PHOTO_PERMISSION_DENIED',
  'ERR_CAPTURE_BUSY',
  'ERR_CAPTURE_FAILED',
  'ERR_PROCESSING_FAILED',
  'ERR_SAVE_FAILED',
  'ERR_NOT_RUNNING',
  'ERR_APERTURE_UNSUPPORTED',
  'ERR_PERMISSION_DENIED',
  'ERR_CAMERA_UNAVAILABLE',
] as const;

const FRIENDLY_ERROR_KEYS: Record<(typeof FRIENDLY_ERROR_CODES)[number], StringKey> = {
  ERR_PHOTO_PERMISSION_DENIED: 'errPhotoPermissionDenied',
  ERR_CAPTURE_BUSY: 'errCaptureBusy',
  ERR_CAPTURE_FAILED: 'errCaptureFailed',
  ERR_PROCESSING_FAILED: 'errProcessingFailed',
  ERR_SAVE_FAILED: 'errSaveFailed',
  ERR_NOT_RUNNING: 'errNotRunning',
  ERR_APERTURE_UNSUPPORTED: 'errApertureUnsupported',
  ERR_PERMISSION_DENIED: 'errPermissionDenied',
  ERR_CAMERA_UNAVAILABLE: 'errCameraUnavailable',
};

function resolveErrorMessage(err: unknown): string {
  if (err instanceof CameraEngineError) {
    const key = (FRIENDLY_ERROR_KEYS as Record<string, StringKey | undefined>)[err.code];
    return key ? t(key) : err.message;
  }
  const record = err as { code?: string; message?: string } | null;
  const key = record?.code ? (FRIENDLY_ERROR_KEYS as Record<string, StringKey | undefined>)[record.code] : undefined;
  if (key) return t(key);
  return err instanceof Error ? err.message : t('errGeneric');
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
  // FINGER OWNERSHIP (回弹 fix): TRUE while the user's finger owns the ring. Every
  // NON-finger aperture writer (stale settle callbacks, native echoes incl. the 3s
  // watchdog, signature re-applies) must check this and stay silent — during
  // continuous sliding the previous gesture's callbacks land MID-gesture and snap
  // the value to a stale f-number (user: 滑到 ƒ/4 突然跳回 ƒ/1.5，反之亦然).
  const apertureDraggingRef = useRef<boolean>(false);
  // Stable setter for the ApertureBar's onDragStateChange callback prop.
  const setApertureDraggingRef = useCallback((dragging: boolean) => {
    apertureDraggingRef.current = dragging;
  }, []);
  // Settle sequence guard: only the LATEST settle's callbacks may write state — a
  // slower earlier settle resolving out of order must not overwrite a newer result.
  const apertureSettleSeqRef = useRef<number>(0);

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

  // -------------------------------------------------------------
  // 2b. Monetization state (Camera 18 Pro + per-camera 3-shot trials)
  // -------------------------------------------------------------
  const { isPro, trialUsed, reserveTrialShot, commitTrialShot, rollbackTrialShot } = useMonetization();
  // First-launch onboarding gate (persisted as a VERSION, not a bool).
  const [showOnboarding, setShowOnboarding] = useState<boolean>(false);
  // Paywall = user-intent moments ONLY (exhausted shutter press / explicit Pro taps).
  const [paywall, setPaywall] = useState<{ source: PaywallSource; profileId: string | null } | null>(null);
  // Light, NON-blocking hint after the LAST trial shot saved (never a surprise paywall).
  const [trialHintVisible, setTrialHintVisible] = useState<boolean>(false);
  const trialHintTimerRef = useRef<NodeJS.Timeout | null>(null);
  // The trial reservation owned by the capture in flight (shutter → saved photo).
  // Snapshot matches the profile that was active AT SHUTTER TIME, so switching
  // cameras mid-processing still commits to the right counter.
  const pendingTrialRef = useRef<{ profileId: string; reservedAt: number } | null>(null);
  // Subscription-stable refs for the photo-processed listener: the effect below must
  // NOT re-subscribe on every trial commit (remove + re-add races a native event
  // fired in between — the exact event the trial count depends on). Refs keep the
  // listener identity stable while the callbacks stay fresh.
  const commitTrialShotRef = useRef(commitTrialShot);
  commitTrialShotRef.current = commitTrialShot;
  const rollbackTrialShotRef = useRef(rollbackTrialShot);
  rollbackTrialShotRef.current = rollbackTrialShot;
  const trialUsedRef = useRef(trialUsed);
  trialUsedRef.current = trialUsed;

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
      // Versioned onboarding gate: absent/older version = first launch (or a new
      // onboarding rev the user hasn't seen). Completing or skipping writes the version.
      if ((state.completedOnboardingVersion ?? 0) < CURRENT_ONBOARDING_VERSION) {
        setShowOnboarding(true);
      }
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
  const [apertureVariable, setApertureVariable] = useState<boolean>(false);
  // Developer-mode extra: side-view lens cross-section above the tick scale (default off).
  const [apertureSideView, setApertureSideView] = useState<boolean>(false);
  // TESTING BUILDS ONLY (local dev / TestFlight Beta): the test settings gate.
  // Hidden by default; unlocked ONLY by the 7-taps-on-the-version-label gesture below,
  // and only when the NATIVE compile-time testingBuild flag allows it — a production
  // App Store build compiles the flag out, so the gesture is a no-op there and an
  // App Store reviewer can never reach the ⚙ settings entries even by accident.
  const [testSettingsUnlocked, setTestSettingsUnlocked] = useState<boolean>(false);
  // Active mock aperture mode as STATE (the ⚙ settings sheet renders the selection);
  // mockApertureModeRef mirrors it for sync reads inside async aperture callbacks.
  const [mockApertureMode, setMockApertureModeState] = useState<'real' | 'mock-variable' | 'mock-fixed' | null>(null);
  const testingBuildRef = useRef<boolean>(false);
  const versionTapCountRef = useRef<number>(0);
  const versionTapLastAtRef = useRef<number>(0);
  // (The old ultra-wide fixed-aperture note is retired: simulated aperture keeps the
  // ring live on every lens, so no lens disables the control anymore.)

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
          const variableMode = capabilities.apertureMode === 'variable';
          setApertureVariable(variableMode);
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
          } else if (variableMode) {
            // Variable iris: the REAL range/stops from capabilities (native spec).
            setApertureRange({
              min: capabilities.minAperture ?? 0,
              max: capabilities.maxAperture ?? 0,
            });
          } else {
            setApertureRange(null);
          }
        }
      } catch {
        setSupportsVariableAperture(false);
        setApertureVariable(false);
        confirmedApertureRef.current = 1.8;
        setActiveAperture(1.8);
        setCurrentAperture(1.8);
        setApertureRange(null);
      }

      // PHYSICAL lens inventory → derive the focal-stop ladder for the dial (a stop
      // without its physical lens is hidden); zoom re-applies because sessions reset
      // zoom on restart, and a restored non-wide stop re-swaps the physical input.
      try {
        const info = await CameraEngine.getAvailableLenses();
        const stops = buildFocalStops({
          ultraWide: Boolean(info?.ultraWide),
          tele: Boolean(info?.tele),
          teleZoom: info?.teleZoom ?? null,
        });
        setFocalStops(stops);
        const teleStop = stops.find((stop) => stop.lens === 'tele');
        teleBaseRef.current = teleStop?.mm ?? null;
        setCurrentFocalMm((previous) => previous ?? defaultFocalStop().mm);
        const engaged = stops.find((stop) => stop.mm === (currentFocalMmRef.current ?? defaultFocalStop().mm));
        if (engaged) {
          activeLensRef.current = engaged.lens;
          await CameraEngine.setLens(engaged.lens);
          await CameraEngine.setZoomFactor(engaged.zoom, engaged.mm);
        }
      } catch {
        // Single-lens fallbacks stay on the previous state.
      }

      // TESTING BUILDS ONLY: arm the mock aperture menu CAPABILITY (compile-time native
      // flag). Revealing the row is the secret version gesture — never automatic.
      try {
        const diag = await CameraEngine.getDiagnostics();
        testingBuildRef.current = Boolean(diag.testingBuild);
      } catch {
        testingBuildRef.current = false;
      }
    } catch (err: unknown) {
      cameraRunningRef.current = false;
      // Surface the failure: a swallowed error here rendered as a silent black
      // viewfinder with no way to recover (background+foreground used to "fix" it).
      setIsCameraRunning(false);
      if (isPermissionDeniedError(err)) {
        setPermissionState('denied');
      } else {
        const errorMsg = err instanceof Error ? err.message : t('initFailed');
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
  // PHYSICAL ROUTING: which physical lens the session input currently carries, and the
  // tele stop's own mm — both feed the zoom-event → mm mapping (zoom is relative to the
  // ACTIVE physical lens now, not to one virtual device).
  const activeLensRef = useRef<PhysicalLens>('wide');
  const teleBaseRef = useRef<number | null>(null);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !cameraRunningRef.current) return;
      CameraEngine.startCamera()
        .then(() => {
          setPermissionState('authorized');
          const engaged = focalStopsRef.current.find((stop) => stop.mm === currentFocalMmRef.current);
          if (engaged) {
            CameraEngine.setLens(engaged.lens).catch(() => {});
            CameraEngine.setZoomFactor(engaged.zoom, engaged.mm).catch(() => {});
          }
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
      const range = apertureVariable
        ? (apertureRange ?? { min: capabilitiesRef.current?.minAperture ?? null, max: capabilitiesRef.current?.maxAperture ?? null })
        : { min: null, max: null };
      return apertureVisualFactors(
        currentAperture,
        apertureVariable,
        range.min,
        range.max,
      );
    },
    [currentAperture, supportsVariableAperture, apertureVariable, apertureRange],
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
  // Which mock mode the diag menu forced (null = real hardware). The hardware-readback
  // sync after setAperture must NOT run in mock-variable: capabilities would report the
  // REAL lens's fixed 1.8 and snap the ring away from the chosen stop.
  const mockApertureModeRef = useRef<'real' | 'mock-variable' | 'mock-fixed' | null>(null);

  /**
   * SINGLE mock-aperture entry point (the ⚙ settings sheet's Mock Aperture section —
   * test-gated). Sets the native mock mode, then re-queries capabilities so every
   * consumer (settle clamp, selector rows, signature apply) sees the MOCK range instead
   * of the startup fixed-lens min=max snapshot that made every drag snap back.
   */
  const applyMockApertureMode = useCallback((value: 'real' | 'mock-variable' | 'mock-fixed') => {
    mockApertureModeRef.current = value;
    setMockApertureModeState(value);
    setMockApertureMode(value).catch(() => {});
    CameraEngine.getCapabilities()
      .then((capabilitiesSnapshot) => {
        capabilitiesRef.current = capabilitiesSnapshot;
        const variableMode = capabilitiesSnapshot.apertureMode === 'variable';
        setApertureVariable(variableMode);
        setSupportsVariableAperture(variableMode);
        if (variableMode) {
          setApertureRange({
            min: capabilitiesSnapshot.minAperture ?? 1.48,
            max: capabilitiesSnapshot.maxAperture ?? 4,
          });
        } else {
          setApertureRange(null);
          const fixed = capabilitiesSnapshot.activeAperture ?? 1.8;
          setCurrentAperture(fixed);
          setActiveAperture(fixed);
          confirmedApertureRef.current = fixed;
        }
      })
      .catch(() => {});
  }, []);

  /**
   * SIGNATURE APERTURE (spec §1): the profile's aperture.preferred is a REAL recommended
   * aperture on a variable lens — clamp to the live hardware range, commit through the
   * real setAperture, then sync the UI from the hardware readback (the iris may settle
   * on the nearest physical detent). Fixed lenses never apply it; ORIG has none; in
   * mock-variable the readback is skipped (capabilities would report the REAL lens).
   */
  const applySignatureAperture = useCallback(async (profile: CameraProfile) => {
    const preferred = profile.aperture?.preferred;
    if (typeof preferred !== 'number' || !Number.isFinite(preferred) || preferred <= 0) return;
    if (mockApertureModeRef.current === 'mock-fixed') return;
    // Live range first (mock-variable overwrites it with the project f/1.48–f/4 range);
    // the startup capabilities snapshot is only a fallback.
    const min = apertureRange?.min ?? capabilitiesRef.current?.minAperture ?? preferred;
    const max = apertureRange?.max ?? capabilitiesRef.current?.maxAperture ?? preferred;
    const clamped = Math.min(Math.max(preferred, min), max);
    try {
      await CameraEngine.setAperture(clamped);
      confirmedApertureRef.current = clamped;
      if (apertureDraggingRef.current) return;
      setCurrentAperture(clamped);
      setActiveAperture(clamped);
      if (mockApertureModeRef.current === null) {
        // Real variable hardware: the iris may settle on the nearest physical stop —
        // the UI shows the HARDWARE truth, not the request.
        const capabilities = await CameraEngine.getCapabilities();
        const real = capabilities.activeAperture;
        if (typeof real === 'number' && Number.isFinite(real) && real > 0) {
          confirmedApertureRef.current = real;
          if (!apertureDraggingRef.current) {
            setCurrentAperture(real);
            setActiveAperture(real);
          }
        }
      }
    } catch (err: unknown) {
      // Hardware refused — leave the ring where the user had it, journal the reason.
      recordDiag('warn', `signature aperture ${preferred} rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [apertureRange]);

  useEffect(() => {
    if (!isCameraRunning || !activeProfile) return;
    if (preferredApertureProfileRef.current === activeProfile.id) return;
    preferredApertureProfileRef.current = activeProfile.id;
    // ORIG (passthrough) carries no signature aperture: switching to it must NOT touch
    // the current real aperture state (user spec). A FIXED lens never applies the
    // signature at all — the ring shows the lens's real mechanical aperture only.
    if (activeProfile.id === 'negative_film') return;
    if (apertureVariable) void applySignatureAperture(activeProfile);
  }, [activeProfile, isCameraRunning, apertureVariable, apertureRange, applySignatureAperture]);

  // Native -> ApertureState sync: the Camera Control slider (and any native aperture
  // source) flows back here so the SCREEN RING always shows the same f-number. There is
  // exactly ONE ApertureState; every entry point converges on it.
  useEffect(() => {
    const apertureSub = addApertureChangedListener((event) => {
      const f = Number(event?.fNumber);
      if (!Number.isFinite(f) || f <= 0) return;
      // FINGER-OWNERSHIP gate: echoes of OUR OWN settle (incl. the native 3s watchdog's
      // late success) arriving while the finger is sliding must not touch the ring —
      // they carry the PREVIOUS gesture's f-number (the mid-drag 回弹). Bookkeeping
      // still records it as confirmed.
      confirmedApertureRef.current = f;
      if (apertureDraggingRef.current) return;
      setCurrentAperture(f);
      setActiveAperture(f);
    });
    const zoomSub = addZoomChangedListener((event) => {
      const zoom = Number(event?.zoom);
      if (!Number.isFinite(zoom) || zoom <= 0) return;
      // Zoom is relative to the ACTIVE PHYSICAL lens: 35mm-equiv = base mm x zoom,
      // base = 13 (ultra-wide) / 26 (wide) / the tele stop's own mm. Snap to nearest stop.
      const base = activeLensRef.current === 'ultrawide' ? 13 : activeLensRef.current === 'tele' ? (teleBaseRef.current ?? 65) : 26;
      const mm = base * zoom;
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

  // BACKGROUND PHOTO PIPELINE outcome (spec §6): fires AFTER the shutter promise
  // settled — carries the final fileUri/thumbnail (Camera DNA → HEIF → PhotoKit done)
  // or the pipeline failure. Keeping this off the shutter path is the whole point.
  useEffect(() => {
    const sub = addPhotoProcessedListener((event) => {
      // Trial bookkeeping (spec §3): ONLY a successfully SAVED photo consumes a
      // free shot. Any pipeline failure rolls the reservation back — the count
      // must survive failed captures untouched.
      const pending = pendingTrialRef.current;
      if (!event?.ok) {
        const code = String(event?.errorCode ?? 'unknown');
        recordDiag('error', `capture pipeline: FAILED (${code}): ${String(event?.detail ?? '')}`);
        if (pending) {
          pendingTrialRef.current = null;
          rollbackTrialShotRef.current(pending.profileId);
          recordDiag('info', `trial: rolled back reservation (${pending.profileId})`);
        }
        if (code === 'ERR_PHOTO_PERMISSION_DENIED') setPhotoPermDenied(true);
        showTransientError(String(event?.detail ?? 'Photo save failed.'));
        return;
      }
      if (pending) {
        pendingTrialRef.current = null;
        commitTrialShotRef.current(pending.profileId);
        const remaining = TRIAL_LIMIT - (trialUsedRef.current[pending.profileId] ?? 0) - 1;
        recordDiag('info', `trial: committed (${pending.profileId}, remaining=${remaining})`);
        // The 3rd (last) free shot just saved: a LIGHT, non-blocking hint — the
        // paywall only appears on the NEXT shutter press with this camera.
        if (remaining <= 0) {
          if (trialHintTimerRef.current) clearTimeout(trialHintTimerRef.current);
          setTrialHintVisible(true);
          trialHintTimerRef.current = setTimeout(() => setTrialHintVisible(false), 6000);
        }
      }
      if (event.processingFallback) {
        showTransientError(t('dnaFallbackSaved'));
      }
      recordDiag('info', `capture pipeline: saved (thumb=${Boolean(event.thumbnailUri)}, codec=${event.codec ?? '?'}, eq=${event.equivalentFocal ?? '?'}mm)`);
      if (event.fileUri) setLastCaptureFileUri(event.fileUri);
      const thumbUri = event.thumbnailUri ?? event.fileUri ?? null;
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
    });
    return () => sub.remove();
  }, [showTransientError]);

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
    if (!apertureVariable) {
      // Fixed devices without the demo ring never move.
      return;
    }
    setCurrentAperture(aperture);
    setActiveAperture(aperture);
  };

  // Gesture end → ONE hardware commit (aperture-priority: shutter/ISO stay automatic).
  // Reverts to the last confirmed stop when the hardware rejects, and self-heals a lens
  // misreported as variable (iOS 27 quirk) by demoting to fixed + DEMO for the session.
  // FINGER-OWNERSHIP + SEQUENCE guards: in continuous sliding the finger often starts
  // the NEXT gesture before this settle's promise resolves — its callbacks then land
  // mid-drag and snapped the value to a stale f-number (the 回弹 bug). Bookkeeping
  // (confirmed/ref/demote) always runs; the RING's visible value is only written when
  // no newer settle superseded this one AND no finger owns the ring.
  const handleApertureSettle = (aperture: number) => {
    if (!apertureVariable) return;
    // apertureRange FIRST: it tracks the live capability (mock-variable overwrites it
    // with the project f/1.48-f/4 range), while capabilitiesRef holds the STARTUP
    // snapshot — on a fixed lens that snapshot is min=max=1.8, which clamped every
    // mock drag straight back to the real aperture at release.
    const min = apertureRange?.min ?? capabilitiesRef.current?.minAperture ?? aperture;
    const max = apertureRange?.max ?? capabilitiesRef.current?.maxAperture ?? aperture;
    const clamped = Math.min(Math.max(aperture, min), max);
    const seq = ++apertureSettleSeqRef.current;
    CameraEngine.setAperture(clamped)
      .then(() => {
        confirmedApertureRef.current = clamped;
        if (seq !== apertureSettleSeqRef.current || apertureDraggingRef.current) return;
        setCurrentAperture(clamped);
        setActiveAperture(clamped);
      })
      .catch((err: unknown) => {
        if (seq !== apertureSettleSeqRef.current) return;
        if (apertureDraggingRef.current) {
          // Finger owns the ring — do NOT yank it back mid-gesture; the CURRENT
          // gesture's own settle will re-commit from the finger's position.
          return;
        }
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
   * Focal-stop selection — PHYSICAL LENS ROUTING: 26/35/52 stay on the physical main
   * (zoom-only move, no input churn — the main's real variable iris serves all three);
   * 13mm/Tele swap the physical input natively (setLens). After ANY switch the aperture
   * capability is re-queried: 13mm/Tele are honest FIXED lenses, so the ring must drop
   * out of variable mode when one of them is active.
   */
  const handleSelectFocal = useCallback(async (stop: FocalStop) => {
    const previousMm = currentFocalMm;
    const previousLens = activeLensRef.current;
    try {
      recordDiag('info', `focal: select ${stop.mm}mm lens=${stop.lens} (zoom=${stop.zoom}) from ${previousMm}mm`);
      await CameraEngine.setLens(stop.lens);
      await CameraEngine.setZoomFactor(stop.zoom, stop.mm);
      activeLensRef.current = stop.lens;
      recordDiag('info', `focal: lens=${stop.lens} zoom ${stop.zoom} applied`);
      setCurrentFocalMm(stop.mm);
      // Input swap changes the aperture capability — re-query and sync the ring state.
      const capabilities = await CameraEngine.getCapabilities();
      capabilitiesRef.current = capabilities;
      const variableMode = capabilities.apertureMode === 'variable';
      setApertureVariable(variableMode);
      setSupportsVariableAperture(variableMode);
      if (variableMode) {
        setApertureRange({
          min: capabilities.minAperture ?? 1.48,
          max: capabilities.maxAperture ?? 4,
        });
        // FIXED → VARIABLE lens switch (13mm/Tele → Wide): the current profile's
        // signature aperture becomes REAL again — apply it (spec §1). Wide→Wide
        // (26/35/52) never reaches the input swap, so the user's aperture survives.
        if (previousLens !== 'wide' && stop.lens === 'wide' && activeProfile && activeProfile.id !== 'negative_film') {
          void applySignatureAperture(activeProfile);
        }
      } else {
        setApertureRange(null);
        const fixed = capabilities.activeAperture ?? 1.8;
        setCurrentAperture(fixed);
        setActiveAperture(fixed);
        confirmedApertureRef.current = fixed;
      }
    } catch (err: unknown) {
      recordDiag('error', `focal: select ${stop.mm}mm FAILED: ${err instanceof Error ? err.message : String(err)}`);
      // Never leave the dial claiming a focal the optics did not reach.
      if (previousMm != null) setCurrentFocalMm(previousMm);
      showTransientError(resolveErrorMessage(err));
    }
  }, [currentFocalMm, showTransientError, activeProfile, applySignatureAperture]);

  const handleCapturePhoto = async () => {
    if (capturePhase === 'capturing') return;

    // -------------------------------------------------------------
    // Monetization gate (spec §5/§6/§27): runs entirely BEFORE the capture, from
    // in-memory state — StoreKit/Keychain never touch the hot path after this.
    // GRIT N (and any future "free" profile) passes straight through.
    // -------------------------------------------------------------
    const gateProfile = activeProfile;
    if (gateProfile) {
      const access = accessFor(gateProfile.id, isPro, trialUsed, gateProfile);
      if (access.kind === 'requiresPro') {
        // Exhausted camera is still selectable for PREVIEW (spec §6); only the
        // real shutter reveals the paywall — the moment of purchase intent.
        recordDiag('info', `trial: exhausted (${gateProfile.id}) → paywall`);
        setPaywall({ source: 'trialExhausted', profileId: gateProfile.id });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        return;
      }
      if (access.kind === 'trial') {
        // A stale reservation (timeout with no pipeline event ever arriving) must
        // not eat the last slot forever: the 20s capture timeout + margin covers it.
        const stale = pendingTrialRef.current;
        if (stale && Date.now() - stale.reservedAt > 30_000) {
          pendingTrialRef.current = null;
          rollbackTrialShot(stale.profileId);
        }
        const reserved = reserveTrialShot(gateProfile.id);
        if (!reserved) {
          // Rapid taps raced the last slot — same intent as exhausted.
          recordDiag('info', `trial: reservation refused (${gateProfile.id}) → paywall`);
          setPaywall({ source: 'trialExhausted', profileId: gateProfile.id });
          return;
        }
        pendingTrialRef.current = { profileId: gateProfile.id, reservedAt: Date.now() };
      }
    }

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
      // SHUTTER DECOUPLING (spec §6): the promise settles when APPLE'S CAPTURE is done.
      // Camera DNA + HEIF + PhotoKit continue in the background on the serial native
      // processing queue and report via onPhotoProcessed — they never hold the shutter.
      const currentStop = focalStopsRef.current.find((stop) => stop.mm === currentFocalMmRef.current);
      const result: CapturedPhoto | undefined = await Promise.race([
        CameraEngine.capturePhoto(currentStop?.mm ?? 0),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('Capture timed out. The photo may still reach your library.')),
            CAPTURE_TIMEOUT_MS,
          );
        }),
      ]);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      // Shutter unlocked HERE — the thumbnail chip arrives via onPhotoProcessed.
      setCapturePhase('idle');
      setPhotoPermDenied(false);
      recordDiag('info', `capture: Apple capture complete (zoom=${result?.appliedZoom?.toFixed(2) ?? '?'} → ${result?.equivalentFocal ?? currentStop?.mm ?? '?'}mm eq); Camera DNA/HEIF/PhotoKit continue in background`);
    } catch (err: unknown) {
      const code = err instanceof CameraEngineError ? err.code : 'unknown';
      const timedOut = err instanceof Error && err.message.includes('timed out');
      recordDiag('error', `capture: FAILED (${code}): ${err instanceof Error ? err.message : String(err)}`);
      // A hard capture failure produces no photo → free the reserved trial shot.
      // The TIMEOUT path keeps the reservation: the photo may still save and land
      // in onPhotoProcessed, which is the only place that commits or rolls back.
      if (!timedOut && pendingTrialRef.current) {
        const pending = pendingTrialRef.current;
        pendingTrialRef.current = null;
        rollbackTrialShot(pending.profileId);
      }
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
  // SECRET TEST GATE: 7 taps on the version label (CameraSelector footer), each within
  // 2s of the previous, unlock the per-camera ⚙ settings entries (CameraSelector rows).
  // Session-only — restarting the app re-hides them. In a production build the native
  // testingBuild flag is compiled out, so this gesture is a no-op and the settings
  // surface is unreachable (App Store safe).
  const handleVersionSecretTap = () => {
    if (!testingBuildRef.current) return;
    const now = Date.now();
    versionTapCountRef.current = now - versionTapLastAtRef.current > 2000 ? 1 : versionTapCountRef.current + 1;
    versionTapLastAtRef.current = now;
    if (versionTapCountRef.current >= 7) {
      versionTapCountRef.current = 0;
      setTestSettingsUnlocked(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  };

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

  // The single Pro entry point. Already-subscribed users skip the paywall entirely
  // and go straight to Apple's official manage-subscription sheet.
  const handleOpenPro = useCallback(
    (source: 'proBadge' | 'settings') => {
      if (!MONETIZATION_ENABLED) return;
      if (isPro && source === 'settings') {
        showManageSubscriptions().catch(() => {
          Linking.openURL(SUBSCRIPTIONS_MANAGE_URL).catch(() => {});
        });
        return;
      }
      setPaywall({ source, profileId: activeProfile?.id ?? null });
    },
    [isPro, activeProfile]
  );

  // Shared-policy badge source for the CameraSelector rows (same function the
  // shutter gate uses — the badge and the gate can never disagree).
  const accessForProfile = useCallback(
    (profile: CameraProfile) => accessFor(profile.id, isPro, trialUsed, profile),
    [isPro, trialUsed]
  );

  const handleCompleteOnboarding = useCallback(() => {
    cameraStateRef.current.completedOnboardingVersion = CURRENT_ONBOARDING_VERSION;
    saveCameraState({ completedOnboardingVersion: CURRENT_ONBOARDING_VERSION });
    setShowOnboarding(false);
  }, []);

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

      <ThreeFingerGestureDetector
        onTriggerCalibration={() => {
          // SECRET TEST GATE (App Store 2.3.1): the calibration console (profile JSON
          // import/export, engine diagnostics, DEMO toggles, log export) must never be
          // reachable in a review build. Same session unlock as the mock aperture row —
          // 7 taps on the version label; production builds compile the native flag out,
          // so this stays a silent no-op there.
          if (testingBuildRef.current) setIsCalibrationOpen(true);
        }}
      >
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
              {/* Pro entry, top-right (product decision 2026-09-19: the paid tier
                  must be one visible tap away, not buried in the camera list).
                  zIndex MUST beat TopBar's SafeAreaView (10) — the full-width
                  safe area otherwise swallows taps on the chip (RN hit-testing
                  does not fall through to non-responder siblings below).
                  Subscribed: chip becomes the manage-subscriptions entry (the
                  selector's Pro row was removed at the user's request). */}
              {MONETIZATION_ENABLED ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={isPro ? 'Camera 18 Pro is active. Manage subscription.' : 'Camera 18 Pro. Unlock every camera.'}
                  activeOpacity={0.8}
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => {});
                    handleOpenPro('settings');
                  }}
                  style={[styles.proEntryChip, isPro && styles.proEntryChipActive]}
                >
                  <Text style={[styles.proEntryChipText, isPro && styles.proEntryChipTextActive]}>
                    {`${t('trialProBadge')}${isPro ? ' ✓' : ''}`}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}

          {/* Startup state overlays (block all touches beneath) */}
          {permissionState === 'checking' && <CameraLoadingView message={t('preparingCamera')} />}
          {(permissionState === 'notDetermined' || permissionState === 'denied') && (
            <View style={StyleSheet.absoluteFillObject}>
              <PermissionRequestView
                statusMessage={
                  permissionState === 'denied'
                    ? t('permDeniedStatus')
                    : t('permExplainer')
                }
                primaryLabel={permissionState === 'denied' ? t('openSettings') : t('continueLabel')}
                onRequestPermission={
                  permissionState === 'denied'
                    ? () => {
                        Linking.openSettings().catch(() => {});
                      }
                    : handleEnableCamera
                }
                secondaryLabel={permissionState === 'denied' ? t('retryCamera') : undefined}
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
                <Text style={styles.photoPermText}>{t('photoSaveOff')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Trial-exhausted hint (spec §7): appears AFTER the 3rd shot saved —
              light, non-blocking, tappable for the genuinely interested user. The
              paywall itself only comes on the NEXT shutter press. */}
          {trialHintVisible && isCameraRunning && !permissionOverlayVisible && (
            <View style={styles.trialHintContainer} pointerEvents="box-none">
              <TouchableOpacity
                accessibilityRole="button"
                activeOpacity={0.85}
                onPress={() => {
                  setTrialHintVisible(false);
                  setPaywall({ source: 'proBadge', profileId: activeProfile?.id ?? null });
                }}
                style={[styles.trialHintPill, { borderColor: skin.border }]}
              >
                <Text style={styles.trialHintTitle}>{t('trialUsedHint')}</Text>
                <Text style={styles.trialHintSubtitle}>{t('trialUnlockHint')}</Text>
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
                // Aperture ring: draggable ONLY on a variable-iris lens; a fixed
                // lens shows its real mechanical aperture (no drag, no simulation).
                <ApertureBar
                minAperture={
                  apertureVariable
                    ? (apertureRange?.min ?? capabilitiesRef.current?.minAperture ?? currentAperture)
                    : currentAperture
                }
                maxAperture={
                  apertureVariable
                    ? (apertureRange?.max ?? capabilitiesRef.current?.maxAperture ?? currentAperture)
                    : currentAperture
                }
                currentAperture={currentAperture}
                isVariableAperture={apertureVariable}
                onApertureChange={handleApertureChange}
                onApertureSettle={handleApertureSettle}
                onDragStateChange={setApertureDraggingRef}
                fixedMode={!apertureVariable}
                signatureAperture={activeProfile?.aperture?.preferred ?? null}
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
            versionLabel={`v${appConfigJson.expo.version}`}
            onVersionPress={handleVersionSecretTap}
            settingsVisible={testSettingsUnlocked}
            apertureMode={apertureVariable ? 'variable' : 'fixed'}
            fixedAperture={currentAperture}
            mockApertureMode={mockApertureMode}
            onSelectMockApertureMode={applyMockApertureMode}
            accessForProfile={accessForProfile}
            onOpenPro={handleOpenPro}
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
                      showTransientError(t('photosRedirectFail'));
                    });
                  }}
                >
                  <Text style={styles.photoViewerButtonText}>{t('openInPhotos')}</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </Modal>

          {/* First-launch onboarding (3 pages; no paywall afterwards by design). */}
          <OnboardingView
            visible={showOnboarding}
            profiles={profiles}
            apertureRange={apertureVariable ? apertureRange : null}
            onComplete={handleCompleteOnboarding}
          />

          {/* Camera 18 Pro paywall — intent-gated only (exhausted shutter / explicit
              tap); fully dark while MONETIZATION_ENABLED is off (free 1.0.0 build). */}
          <PaywallModal
            visible={MONETIZATION_ENABLED && paywall !== null}
            source={paywall?.source ?? null}
            onClose={() => setPaywall(null)}
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
        <MonetizationProvider>
          <CameraAppScreen />
        </MonetizationProvider>
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
  trialHintContainer: {
    position: 'absolute',
    bottom: 320,
    left: 16,
    right: 16,
    alignItems: 'center',
    zIndex: 60,
  },
  trialHintPill: {
    backgroundColor: 'rgba(20, 20, 24, 0.94)',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
  },
  trialHintTitle: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  trialHintSubtitle: {
    color: 'rgba(232, 184, 75, 0.95)',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 3,
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
  proEntryChip: {
    position: 'absolute',
    // Same visual band as the top-left camera capsule — mirrors CameraSelector's
    // CAPSULE_TOP (the morph anchor the capsule geometry is known to match).
    top: Platform.OS === 'ios' ? 55 : 8,
    right: 16,
    zIndex: 30,
    elevation: 30,
    backgroundColor: '#E8B84B',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  proEntryChipActive: {
    backgroundColor: 'rgba(20, 20, 24, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(232, 184, 75, 0.85)',
  },
  proEntryChipText: {
    color: '#141414',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  proEntryChipTextActive: {
    color: '#E8B84B',
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

