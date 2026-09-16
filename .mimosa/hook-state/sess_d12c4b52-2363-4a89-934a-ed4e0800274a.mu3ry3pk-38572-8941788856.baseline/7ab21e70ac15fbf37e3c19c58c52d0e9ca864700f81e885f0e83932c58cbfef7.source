import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  type GestureResponderEvent,
  type NativeTouchEvent,
} from 'react-native';
import * as Haptics from 'expo-haptics';

interface ThreeFingerGestureDetectorProps {
  onTriggerCalibration: () => void;
  children: React.ReactNode;
  durationMs?: number;
}

export const ThreeFingerGestureDetector: React.FC<ThreeFingerGestureDetectorProps> = ({
  onTriggerCalibration,
  children,
  durationMs = 2000,
}: ThreeFingerGestureDetectorProps) => {
  const [isActive, setIsActive] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const initialTouchPointsRef = useRef<{ x: number; y: number }[]>([]);

  const cancelGesture = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    progressAnim.stopAnimation();
    progressAnim.setValue(0);
    setIsActive(false);
  };

  const handleTouchStart = (e: GestureResponderEvent) => {
    const touches = e.nativeEvent.touches;
    if (touches.length === 3) {
      // Exactly three fingers down
      setIsActive(true);
      initialTouchPointsRef.current = touches.map((t: NativeTouchEvent) => ({ x: t.pageX, y: t.pageY }));

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

      progressAnim.setValue(0);
      Animated.timing(progressAnim, {
        toValue: 1,
        duration: durationMs,
        useNativeDriver: false, // needed for width/opacity interpolations
      }).start();

      timerRef.current = setTimeout(() => {
        // Successful 2s hold
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        cancelGesture();
        onTriggerCalibration();
      }, durationMs);
    } else if (touches.length > 3 || touches.length < 3) {
      if (isActive) {
        cancelGesture();
      }
    }
  };

  const handleTouchMove = (e: GestureResponderEvent) => {
    const touches = e.nativeEvent.touches;
    if (touches.length !== 3 && isActive) {
      cancelGesture();
      return;
    }

    // Check maximum displacement threshold
    if (isActive && touches.length === 3 && initialTouchPointsRef.current.length === 3) {
      for (let i = 0; i < 3; i++) {
        const touch = touches[i];
        const initial = initialTouchPointsRef.current[i];
        if (!touch || !initial) continue;
        const dx = touch.pageX - initial.x;
        const dy = touch.pageY - initial.y;
        if (Math.hypot(dx, dy) > 35) {
          // Moved too far, cancel
          cancelGesture();
          break;
        }
      }
    }
  };

  const handleTouchEnd = () => {
    if (isActive) {
      cancelGesture();
    }
  };

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View
      style={styles.wrapper}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {children}

      {/* Visual Feedback Overlay when 3 fingers are detected */}
      {isActive && (
        <View style={styles.hudFeedbackOverlay} pointerEvents="none">
          <View style={styles.hudCard}>
            <Text style={styles.hudTitle}>CALIBRATION MODE</Text>
            <Text style={styles.hudSubtitle}>Hold 3 fingers steady (~2s)</Text>
            <View style={styles.progressBarTrack}>
              <Animated.View style={[styles.progressBarFill, { width: progressWidth }]} />
            </View>
          </View>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
  },
  hudFeedbackOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    zIndex: 999,
  },
  hudCard: {
    backgroundColor: 'rgba(18, 18, 22, 0.92)',
    paddingHorizontal: 24,
    paddingVertical: 18,
    borderRadius: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    width: 260,
  },
  hudTitle: {
    color: '#FFCC00',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  hudSubtitle: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 11,
    fontWeight: '500',
    marginBottom: 12,
  },
  progressBarTrack: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#FFCC00',
    borderRadius: 2,
  },
});
