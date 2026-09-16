import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import * as Haptics from 'expo-haptics';

interface PermissionRequestViewProps {
  onRequestPermission: () => void;
  statusMessage?: string;
  /** Label of the primary action button (defaults to the neutral "Continue"). */
  primaryLabel?: string;
  /** Optional secondary action (e.g. "Open Settings" / "Retry") shown under the primary button. */
  secondaryLabel?: string;
  onSecondary?: () => void;
}

export const PermissionRequestView: React.FC<PermissionRequestViewProps> = ({
  onRequestPermission,
  statusMessage = 'Camera 18 simulates classic film cameras. It needs the camera for the viewfinder and photo access (add-only) to save your shots.',
  // Neutral CTA label: App Store review rejects copy that steers users into enabling
  // permissions ("Enable Camera" was rejected once) — keep it neutral ("Continue").
  primaryLabel = 'Continue',
  secondaryLabel,
  onSecondary,
}: PermissionRequestViewProps) => {
  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onRequestPermission();
  };

  const handleSecondary = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onSecondary?.();
  };

  return (
    <SafeAreaView style={styles.stateContainer}>
      <View style={styles.card}>
        <View style={styles.iconCircle}>
          <Text style={styles.iconGlyph}>📷</Text>
        </View>

        <Text style={styles.title}>Camera Access Required</Text>
        <Text style={styles.description}>{statusMessage}</Text>

        <TouchableOpacity
          activeOpacity={0.8}
          onPress={handlePress}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryButtonText}>{primaryLabel}</Text>
        </TouchableOpacity>

        {secondaryLabel && onSecondary ? (
          <TouchableOpacity activeOpacity={0.8} onPress={handleSecondary} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{secondaryLabel}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </SafeAreaView>
  );
};

interface CameraLoadingViewProps {
  message?: string;
}

export const CameraLoadingView: React.FC<CameraLoadingViewProps> = ({
  message = 'Initializing Camera Engine...',
}: CameraLoadingViewProps) => {
  return (
    <View style={styles.stateContainer}>
      <ActivityIndicator size="large" color="#FFFFFF" />
      <Text style={styles.loadingText}>{message}</Text>
    </View>
  );
};

interface CameraErrorViewProps {
  error: string;
  onRetry: () => void;
}

export const CameraErrorView: React.FC<CameraErrorViewProps> = ({
  error,
  onRetry,
}: CameraErrorViewProps) => {
  const handleRetry = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onRetry();
  };

  return (
    <SafeAreaView style={styles.stateContainer}>
      <View style={styles.card}>
        <View style={[styles.iconCircle, styles.errorIconCircle]}>
          <Text style={styles.iconGlyph}>⚠️</Text>
        </View>

        <Text style={styles.title}>Camera Engine Error</Text>
        <Text style={styles.description}>{error}</Text>

        <TouchableOpacity
          activeOpacity={0.8}
          onPress={handleRetry}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryButtonText}>Retry Camera</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  stateContainer: {
    flex: 1,
    backgroundColor: '#0A0A0C',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    alignItems: 'center',
    maxWidth: 320,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  errorIconCircle: {
    backgroundColor: 'rgba(255, 59, 48, 0.15)',
    borderColor: 'rgba(255, 59, 48, 0.3)',
  },
  iconGlyph: {
    fontSize: 28,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 0.3,
    marginBottom: 10,
    textAlign: 'center',
  },
  description: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 28,
  },
  primaryButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 24,
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  secondaryButton: {
    marginTop: 14,
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
  secondaryButtonText: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 14,
    fontWeight: '600',
  },
  loadingText: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 16,
    letterSpacing: 0.4,
  },
});
