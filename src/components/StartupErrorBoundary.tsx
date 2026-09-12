import React from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

type StartupErrorBoundaryProps = {
  readonly children: React.ReactNode;
};

type StartupErrorBoundaryState = {
  readonly error: Error | null;
};

/**
 * Last-resort error boundary around the whole app.
 *
 * In a production build an uncaught render error unmounts the entire React tree and iOS
 * keeps showing the empty window — for this app a full black screen with zero information
 * (red box only exists in development). This boundary converts that black screen into the
 * actual error text so a single screenshot is enough to diagnose the failure remotely.
 */
export class StartupErrorBoundary extends React.Component<
  StartupErrorBoundaryProps,
  StartupErrorBoundaryState
> {
  readonly state: StartupErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): StartupErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Also reach the system log so the failure is visible when the phone is attached to Metro.
    console.error('[StartupErrorBoundary]', error.message, error.stack, info.componentStack);
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <View style={styles.screen}>
        <Text style={styles.title}>Camera 18 failed to start</Text>
        <Text style={styles.meta}>iOS {Platform.Version}</Text>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Text selectable style={styles.message}>
            {error.message}
          </Text>
          {error.stack ? <Text selectable style={styles.stack}>{error.stack}</Text> : null}
        </ScrollView>
        <Text style={styles.hint}>
          Screenshot this screen and send it to the developer — it pinpoints the failure.
        </Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0A0A0C',
    paddingTop: 72,
    paddingHorizontal: 20,
    paddingBottom: 28,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 6,
  },
  meta: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 18,
  },
  scroll: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  scrollContent: {
    padding: 14,
  },
  message: {
    color: '#FFD8A8',
    fontSize: 14,
    fontWeight: '700',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    marginBottom: 12,
  },
  stack: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 11,
    lineHeight: 15,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  hint: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 14,
  },
});
