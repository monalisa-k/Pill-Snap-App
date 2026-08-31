import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { decodePhoto } from './src/lib/decodeImage';
import {
  deleteCount,
  loadHistory,
  saveCount,
  type CountRecord,
} from './src/lib/history';
import { colors, radius, spacing } from './src/lib/theme';
import CameraScreen from './src/ui/CameraScreen';
import HistoryScreen from './src/ui/HistoryScreen';
import ResultScreen from './src/ui/ResultScreen';
import { countPills } from './src/vision/count';
import type { CountResult } from './src/vision/types';

type Screen =
  | { name: 'camera' }
  | { name: 'analysing'; uri: string }
  | { name: 'result'; uri: string; result: CountResult }
  | { name: 'error'; message: string }
  | { name: 'history' };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'camera' });
  const [history, setHistory] = useState<CountRecord[]>([]);

  useEffect(() => {
    loadHistory().then(setHistory);
  }, []);

  const analyse = useCallback(async (uri: string) => {
    setScreen({ name: 'analysing', uri });
    try {
      const { image } = await decodePhoto(uri);
      // Yield a frame first so the spinner actually paints before the
      // pipeline takes over the JS thread for a few hundred milliseconds.
      await new Promise((resolve) => setTimeout(resolve, 16));
      const result = countPills(image);
      setScreen({ name: 'result', uri, result });
    } catch (error) {
      setScreen({
        name: 'error',
        message: error instanceof Error ? error.message : 'Could not read that photo.',
      });
    }
  }, []);

  const handleSave = useCallback(
    async (payload: {
      count: number;
      detected: number;
      added: number;
      removed: number;
      confidence: number;
    }) => {
      setHistory(await saveCount(payload));
      setScreen({ name: 'camera' });
    },
    [],
  );

  const handleDelete = useCallback(async (id: string) => {
    setHistory(await deleteCount(id));
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {screen.name === 'camera' && (
        <CameraScreen
          onCaptured={analyse}
          onOpenHistory={() => setScreen({ name: 'history' })}
          busy={false}
        />
      )}

      {screen.name === 'analysing' && (
        <View style={styles.centred}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.busyText}>Counting…</Text>
        </View>
      )}

      {screen.name === 'result' && (
        <ResultScreen
          imageUri={screen.uri}
          result={screen.result}
          onRetake={() => setScreen({ name: 'camera' })}
          onSave={handleSave}
        />
      )}

      {screen.name === 'error' && (
        <View style={styles.centred}>
          <Text style={styles.errorTitle}>Something went wrong</Text>
          <Text style={styles.errorBody}>{screen.message}</Text>
          <Pressable style={styles.button} onPress={() => setScreen({ name: 'camera' })}>
            <Text style={styles.buttonText}>Back to camera</Text>
          </Pressable>
        </View>
      )}

      {screen.name === 'history' && (
        <HistoryScreen
          history={history}
          onClose={() => setScreen({ name: 'camera' })}
          onDelete={handleDelete}
        />
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  centred: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  busyText: { color: colors.textMuted, fontSize: 16, marginTop: spacing.lg },
  errorTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  errorBody: {
    color: colors.textMuted,
    fontSize: 15,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
  button: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
  },
  buttonText: { color: colors.bg, fontSize: 16, fontWeight: '700' },
});
