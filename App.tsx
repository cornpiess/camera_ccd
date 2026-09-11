import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  StatusBar,
  Animated,
  Dimensions,
  AppState,
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
  CameraEngineView,
  CameraEngineError,
  type CapturedPhoto,
  type CameraCapabilities,
} from './src/camera/CameraEngine';

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
  ApertureControl,
  ProfileOverlay,
  RadialProfileSelector,
  CameraSelector,
  FocusIndicator,
  type FocusPoint,
  ThreeFingerGestureDetector,
  PermissionRequestView,
  CameraLoadingView,
  CameraErrorView,
  getClampedCenter,
  computeRadialSector,
  type Point,
} from './src/components';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

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
  const { profiles, currentProfile, selectProfile, errors: profileErrors } = useProfiles();
  const activeProfile = currentProfile ?? profiles[0] ?? null;

  // -------------------------------------------------------------
  // 2. Camera Engine Hardware State
  // -------------------------------------------------------------
  const [permissionDenied, setPermissionDenied] = useState<boolean>(false);
  const [cameraInitError, setCameraInitError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isCameraRunning, setIsCameraRunning] = useState<boolean>(false);

  // Aperture hardware capability states
  const [supportsVariableAperture, setSupportsVariableAperture] = useState<boolean>(false);
  const [activeAperture, setActiveAperture] = useState<number>(1.8);
  const [currentAperture, setCurrentAperture] = useState<number>(1.8);
  const [availableApertures, setAvailableApertures] = useState<number[]>([]);
  const capabilitiesRef = useRef<CameraCapabilities | null>(null);

  // Photo Capture & Preview states
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [latestThumbnail, setLatestThumbnail] = useState<string | null>(null);

  // Tracks whether the native session started successfully (used by the AppState recovery path)
  const cameraRunningRef = useRef<boolean>(false);

  // Flash curtain effect
  const shutterFlashAnim = useRef(new Animated.Value(0)).current;

  // -------------------------------------------------------------
  // 3. Transient Error Overlay (Running Errors: profile/apply/aperture/capture/save)
  // -------------------------------------------------------------
  const [transientError, setTransientError] = useState<string | null>(null);
  const transientErrorTimerRef = useRef<NodeJS.Timeout | null>(null);

  const showTransientError = useCallback((message: string) => {
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
      setPermissionDenied(false);

      // Await startCamera and catch errors rather than swallowing
      await CameraEngine.startCamera();
      cameraRunningRef.current = true;
      setIsCameraRunning(true);

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
    } catch (err: unknown) {
      cameraRunningRef.current = false;
      if (isPermissionDeniedError(err)) {
        setPermissionDenied(true);
      } else {
        const errorMsg = err instanceof Error ? err.message : 'Failed to initialize Camera Engine';
        setCameraInitError(errorMsg);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initialize camera only once after view mount
  useEffect(() => {
    initializeCameraSession();
    return () => {
      cameraRunningRef.current = false;
      CameraEngine.stopCamera().catch(() => {});
    };
  }, [initializeCameraSession]);

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
  useEffect(() => {
    if (!isCameraRunning || !activeProfile) return;

    let isMounted = true;
    const applyCurrentProfile = async () => {
      try {
        await CameraEngine.applyProfile(activeProfile as unknown as Record<string, unknown>);

        // If variable aperture is supported, clamp preferred aperture and update
        if (supportsVariableAperture && activeProfile.aperture?.preferred != null) {
          const preferred = activeProfile.aperture.preferred;
          const min = capabilitiesRef.current?.minAperture ?? availableApertures[0] ?? preferred;
          const max = capabilitiesRef.current?.maxAperture ?? availableApertures[availableApertures.length - 1] ?? preferred;
          const clamped = Math.min(Math.max(preferred, min), max);

          await CameraEngine.setAperture(clamped);
          if (isMounted) {
            setCurrentAperture(clamped);
            setActiveAperture(clamped);
          }
        }
      } catch (err: unknown) {
        if (isMounted) {
          const msg = err instanceof Error ? err.message : 'Failed to apply camera profile';
          showTransientError(msg);
        }
      }
    };

    applyCurrentProfile();
    return () => {
      isMounted = false;
    };
  }, [activeProfile, isCameraRunning, supportsVariableAperture, availableApertures, showTransientError]);

  // Profile validation/import/reload errors shown as transient overlay while running
  useEffect(() => {
    if (profileErrors && profileErrors.length > 0) {
      showTransientError(profileErrors.join('\n'));
    }
  }, [profileErrors, showTransientError]);

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

    try {
      await CameraEngine.setAperture(clamped);
      // Update UI only after native success
      setCurrentAperture(clamped);
      setActiveAperture(clamped);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to set aperture';
      showTransientError(msg);
    }
  };

  const handleCapturePhoto = async () => {
    if (isCapturing) return;
    setIsCapturing(true);

    // Visual white flash curtain
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
      if (result?.thumbnailUri) {
        setLatestThumbnail(result.thumbnailUri);
      } else if (result?.fileUri) {
        setLatestThumbnail(result.fileUri);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Capture failed';
      showTransientError(errorMsg);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      setIsCapturing(false);
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
   * shows a lightweight indicator. Screen coords are mapped through the aspect-fill
   * preview into normalized video coords (photo preset renders a 4:3 portrait frame,
   * so narrow screens crop the sides); the native layer converts them to the device's
   * landscape sensor space.
   */
  const handleTapToFocus = useCallback(
    (pageX: number, pageY: number) => {
      if (!isCameraRunning) return;
      setFocusIndicator({ x: pageX, y: pageY, key: Date.now() });

      const screenAspect = SCREEN_WIDTH / SCREEN_HEIGHT;
      const videoAspect = 3 / 4;
      let nx = pageX / SCREEN_WIDTH;
      let ny = pageY / SCREEN_HEIGHT;
      if (screenAspect < videoAspect) {
        nx = (nx - 0.5) * (screenAspect / videoAspect) + 0.5;
      } else {
        ny = (ny - 0.5) * (videoAspect / screenAspect) + 0.5;
      }
      CameraEngine.setFocusPoint(
        Math.min(1, Math.max(0, nx)),
        Math.min(1, Math.max(0, ny)),
      ).catch(() => {});
    },
    [isCameraRunning],
  );

  const handleSelectProfile = useCallback(
    (profile: CameraProfile) => {
      selectProfile(profile.id);
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
  // 10. Startup State Views (Permission denied / initial mount error)
  // -------------------------------------------------------------
  if (permissionDenied) {
    return (
      <View style={styles.rootContainer}>
        <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
        <CameraEngineView
          style={StyleSheet.absoluteFillObject}
          profile={activeProfile as unknown as Record<string, unknown>}
        />
        <View style={StyleSheet.absoluteFillObject}>
          <PermissionRequestView
            statusMessage="Camera permission was denied. Please grant camera access in Settings to use the camera."
            onRequestPermission={() => {
              setPermissionDenied(false);
              initializeCameraSession();
            }}
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
          {/* 1. Full-Screen Native Camera Engine View (cameraPosition prop removed) */}
          <CameraEngineView
            style={StyleSheet.absoluteFillObject}
            profile={activeProfile as unknown as Record<string, unknown>}
          />

          {/* Initial Loading overlay without unmounting camera */}
          {isLoading && !isCameraRunning && (
            <View style={StyleSheet.absoluteFillObject}>
              <CameraLoadingView />
            </View>
          )}

          {/* Lightweight JSON-derived preview overlay */}
          <ProfileOverlay profile={activeProfile} />

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
              profileName={activeProfile?.name}
              onPress={() => setIsSelectorOpen(true)}
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

          {/* Bottom Bar: Aperture Control, Shutter, Recent Thumbnail */}
          <View style={styles.bottomControlsContainer} pointerEvents="box-none">
            {/* 3. Aperture Control (Interactive only if variable; otherwise Fixed ƒ/x) */}
            <ApertureControl
              currentAperture={currentAperture}
              onApertureChange={handleApertureChange}
              isVariableAperture={supportsVariableAperture}
              availableApertures={availableApertures}
              activeAperture={activeAperture}
            />

            {/* Bottom Actions Row: Recent Thumbnail & Shutter Button */}
            <View style={styles.bottomActionRow}>
              {/* 5. Lower-left Recent Photo Thumbnail (Display Only) */}
              <View style={styles.thumbnailSlot}>
                <ThumbnailPreview uri={latestThumbnail} />
              </View>

              {/* 4. Centered Shutter Button */}
              <View style={styles.shutterSlot}>
                <ShutterButton
                  isCapturing={isCapturing}
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

          {/* 7. 8-Profile Radial Selector (Visual only; preview responder finalizes on release) */}
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
 * Top-Level App Entry wrapped in ProfileProvider
 */
export default function App(): React.JSX.Element {
  return (
    <ProfileProvider>
      <CameraAppScreen />
    </ProfileProvider>
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
    top: 80,
    bottom: 160,
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
  bottomControlsContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
    paddingTop: 8,
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
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

