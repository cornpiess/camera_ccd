import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useProfiles } from '../profiles';
import { profileDisplayName } from '../components/types';

export interface ProfileConfigModalProps {
  readonly visible: boolean;
  readonly profileId: string | null;
  readonly onClose: () => void;
}

interface ActionButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}

function ActionButton({ label, onPress, disabled = false, destructive = false }: ActionButtonProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, destructive && styles.destructiveButton, (pressed || disabled) && styles.buttonDimmed]}
    >
      <Text style={[styles.buttonText, destructive && styles.destructiveText]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Per-camera configuration sheet: edit / import / paste the JSON of ONE profile and
 * see the effect live (the camera preview keeps rendering behind the dimmed backdrop).
 * The sheet accepts either a single profile object or a complete profile document —
 * the provider merges single profiles into the active override document.
 */
export function ProfileConfigModal({ visible, profileId, onClose }: ProfileConfigModalProps): React.JSX.Element {
  const { applyProfileText, clearErrors, errors, exportProfileJson, importProfileFile, loading, profiles, resetProfile } = useProfiles();
  const [text, setText] = useState('');
  const [working, setWorking] = useState(false);

  const profile = profiles.find((entry) => entry.id === profileId) ?? null;

  // Load the camera's current JSON into the editor whenever the sheet opens for a camera.
  useEffect(() => {
    if (visible && profileId !== null) {
      setText(exportProfileJson(profileId) ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, profileId]);

  const run = useCallback(async (action: () => Promise<boolean>): Promise<void> => {
    setWorking(true);
    try {
      await action();
    } finally {
      setWorking(false);
    }
  }, []);

  const close = useCallback((): void => {
    clearErrors();
    onClose();
  }, [clearErrors, onClose]);

  const busy = working || loading;

  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      transparent
      visible={visible}
    >
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
        {/* Dimmed but see-through: the tuned look is visible on the live preview behind. */}
        <Pressable accessibilityLabel="Close camera configuration" style={styles.backdrop} onPress={close} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headingBlock}>
              <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
                {profile ? profileDisplayName(profile) : 'Camera'}
              </Text>
              <Text style={styles.subtitle}>Tune this camera · changes apply instantly</Text>
            </View>
            <Pressable accessibilityLabel="Close configuration" accessibilityRole="button" hitSlop={12} onPress={close}>
              <Text style={styles.close}>Done</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.help}>
              Paste this camera&apos;s JSON (a single object) or a complete profile document, then Apply. Valid
              changes are saved and take effect immediately — tweak, look at the preview, repeat.
            </Text>

            <View style={styles.actions}>
              <ActionButton disabled={busy} label="Import File" onPress={() => { void run(() => importProfileFile(profileId ?? undefined)); }} />
              <ActionButton disabled={busy} label="Load Current" onPress={() => { clearErrors(); if (profileId !== null) setText(exportProfileJson(profileId) ?? ''); }} />
              <ActionButton
                disabled={busy || text.trim() === ''}
                label="Apply"
                onPress={() => { void run(() => applyProfileText(text, profileId ?? undefined)); }}
              />
              <ActionButton destructive disabled={busy || profileId === null} label="Reset Camera" onPress={() => { void run(() => resetProfile(profileId!)); }} />
            </View>

            <TextInput
              accessibilityLabel="Camera profile JSON"
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              onChangeText={setText}
              placeholder={'Paste a single-camera JSON object here,\nor a complete profile document.'}
              placeholderTextColor="#777"
              spellCheck={false}
              style={styles.editor}
              textAlignVertical="top"
              value={text}
            />

            {busy ? <ActivityIndicator accessibilityLabel="Applying profile" style={styles.progress} /> : null}
            {errors.length > 0 ? (
              <View accessibilityLiveRegion="polite" style={styles.errorBox}>
                <Text style={styles.errorTitle}>Could not apply</Text>
                {errors.map((error, index) => (
                  <Text key={`${index}-${error}`} selectable style={styles.errorText}>• {error}</Text>
                ))}
              </View>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: {
    backgroundColor: '#101114f2',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: '78%',
    paddingBottom: 12,
  },
  header: {
    minHeight: 58,
    paddingHorizontal: 20,
    paddingTop: 14,
    borderBottomColor: '#2b2d32',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headingBlock: { flex: 1, gap: 2 },
  title: { color: '#fff', fontSize: 19, fontWeight: '700' },
  subtitle: { color: '#8e939e', fontSize: 12.5 },
  close: { color: '#8db8ff', fontSize: 16, fontWeight: '600' },
  content: { padding: 20, gap: 12, paddingBottom: 28 },
  help: { color: '#b8bbc3', fontSize: 13.5, lineHeight: 19 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  button: { minHeight: 42, borderRadius: 9, borderWidth: 1, borderColor: '#4776bd', backgroundColor: '#182840', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  buttonDimmed: { opacity: 0.45 },
  buttonText: { color: '#dbe9ff', fontSize: 14, fontWeight: '600' },
  destructiveButton: { borderColor: '#824a4a', backgroundColor: '#361d20' },
  destructiveText: { color: '#ffb6b6' },
  editor: {
    minHeight: 200,
    borderColor: '#3b3e45',
    borderWidth: 1,
    borderRadius: 10,
    backgroundColor: '#17191dee',
    color: '#f4f4f5',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 12.5,
    lineHeight: 18,
    padding: 12,
  },
  progress: { marginVertical: 8 },
  errorBox: { borderRadius: 9, borderWidth: 1, borderColor: '#8b4444', backgroundColor: '#30191c', padding: 12, gap: 5 },
  errorTitle: { color: '#ffc1c1', fontWeight: '700', marginBottom: 2 },
  errorText: { color: '#ffcece', fontSize: 13, lineHeight: 18 },
});

export default ProfileConfigModal;
