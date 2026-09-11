import React, { useCallback, useState } from 'react';
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

export interface CalibrationModalProps {
  readonly visible: boolean;
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

export function CalibrationModal({ visible, onClose }: CalibrationModalProps): React.JSX.Element {
  const { applyText, clearErrors, document, errors, exportJson, importJson, loading, reload, reset } = useProfiles();
  const [text, setText] = useState('');
  const [working, setWorking] = useState(false);

  const run = useCallback(async (action: () => Promise<boolean>, clearOnSuccess = false): Promise<void> => {
    setWorking(true);
    try {
      const succeeded = await action();
      if (succeeded && clearOnSuccess) setText('');
    } finally {
      setWorking(false);
    }
  }, []);

  // Export = load the active document into the editor below, ready to be copied out.
  // The editor is selectable, so "long-press -> Select All -> Copy" is all it takes.
  const handleExport = useCallback((): void => {
    const json = exportJson();
    if (json === null) return;
    clearErrors();
    setText(json);
  }, [clearErrors, exportJson]);

  const close = useCallback((): void => {
    clearErrors();
    onClose();
  }, [clearErrors, onClose]);

  const busy = working || loading;

  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      presentationStyle="pageSheet"
      transparent={false}
      visible={visible}
    >
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>Camera calibration</Text>
          <Pressable accessibilityLabel="Close calibration" accessibilityRole="button" hitSlop={12} onPress={close}>
            <Text style={styles.close}>Close</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.help}>
            Import a profile document or paste its complete JSON below. Valid changes are saved and applied immediately.
            Export loads the active JSON into the editor — long-press it to select all and copy.
          </Text>

          <View style={styles.actions}>
            <ActionButton disabled={busy} label="Import JSON" onPress={() => { void run(importJson); }} />
            <ActionButton disabled={busy || document === null} label="Export Current JSON" onPress={handleExport} />
            <ActionButton disabled={busy} label="Reload" onPress={() => { void run(reload); }} />
            <ActionButton destructive disabled={busy} label="Reset Default" onPress={() => { void run(reset, true); }} />
          </View>

          <Text style={styles.label}>Profile document JSON</Text>
          <TextInput
            accessibilityLabel="Profile document JSON"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={setText}
            placeholder={'{\n  "version": 1,\n  "profiles": […]\n}'}
            placeholderTextColor="#777"
            spellCheck={false}
            style={styles.editor}
            textAlignVertical="top"
            value={text}
          />
          <ActionButton
            disabled={busy || text.trim() === ''}
            label="Apply Pasted JSON"
            onPress={() => { void run(() => applyText(text)); }}
          />

          {busy ? <ActivityIndicator accessibilityLabel="Loading profiles" style={styles.progress} /> : null}
          {errors.length > 0 ? (
            <View accessibilityLiveRegion="polite" style={styles.errorBox}>
              <Text style={styles.errorTitle}>Could not apply profiles</Text>
              {errors.map((error, index) => (
                <Text key={`${index}-${error}`} selectable style={styles.errorText}>• {error}</Text>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101114' },
  header: { minHeight: 58, paddingHorizontal: 20, borderBottomColor: '#2b2d32', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: '#fff', fontSize: 20, fontWeight: '700' },
  close: { color: '#8db8ff', fontSize: 16, fontWeight: '600' },
  content: { padding: 20, gap: 14, paddingBottom: 40 },
  help: { color: '#b8bbc3', fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  button: { minHeight: 44, borderRadius: 9, borderWidth: 1, borderColor: '#4776bd', backgroundColor: '#182840', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonDimmed: { opacity: 0.45 },
  buttonText: { color: '#dbe9ff', fontSize: 15, fontWeight: '600' },
  destructiveButton: { borderColor: '#824a4a', backgroundColor: '#361d20' },
  destructiveText: { color: '#ffb6b6' },
  label: { color: '#e8e9ed', fontSize: 15, fontWeight: '600', marginTop: 4 },
  editor: { minHeight: 260, borderColor: '#3b3e45', borderWidth: 1, borderRadius: 10, backgroundColor: '#17191d', color: '#f4f4f5', fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }), fontSize: 13, lineHeight: 19, padding: 12 },
  progress: { marginVertical: 8 },
  errorBox: { borderRadius: 9, borderWidth: 1, borderColor: '#8b4444', backgroundColor: '#30191c', padding: 12, gap: 5 },
  errorTitle: { color: '#ffc1c1', fontWeight: '700', marginBottom: 2 },
  errorText: { color: '#ffcece', fontSize: 13, lineHeight: 18 },
});

export default CalibrationModal;
