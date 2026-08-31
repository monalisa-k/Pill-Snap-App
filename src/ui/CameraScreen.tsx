import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radius, spacing } from '../lib/theme';

interface Props {
  onCaptured: (uri: string) => void;
  onOpenHistory: () => void;
  busy: boolean;
}

/**
 * Capture screen.
 *
 * The framing guides and the standing tip are not decoration. Almost every
 * way this app can get a count wrong traces back to how the photo was taken -
 * pills touching, a shadow across the tray, the flash blowing out a corner -
 * and all of it is cheaper to prevent here than to recover from afterwards.
 */
export default function CameraScreen({ onCaptured, onOpenHistory, busy }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const cameraRef = useRef<CameraView>(null);

  const takePhoto = async () => {
    if (!cameraRef.current || capturing || busy) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.95,
        skipProcessing: false,
      });
      if (photo?.uri) onCaptured(photo.uri);
    } finally {
      setCapturing(false);
    }
  };

  const pickFromLibrary = async () => {
    if (busy) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    if (!result.canceled && result.assets[0]?.uri) onCaptured(result.assets[0].uri);
  };

  if (!permission) {
    return (
      <SafeAreaView style={styles.centred}>
        <ActivityIndicator color={colors.accent} />
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.centred}>
        <Text style={styles.permissionTitle}>Camera access needed</Text>
        <Text style={styles.permissionBody}>
          Pill Snap counts pills from a photo. Nothing leaves your phone - the counting runs
          on device.
        </Text>
        <Pressable style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.primaryButtonText}>Allow camera</Text>
        </Pressable>
        <Pressable style={styles.linkButton} onPress={pickFromLibrary}>
          <Text style={styles.linkButtonText}>Choose a photo instead</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} />

      <SafeAreaView style={styles.overlay} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <Pressable style={styles.chip} onPress={onOpenHistory} hitSlop={8}>
            <Text style={styles.chipText}>History</Text>
          </Pressable>
          <Pressable
            style={[styles.chip, torch && styles.chipActive]}
            onPress={() => setTorch((on) => !on)}
            hitSlop={8}
          >
            <Text style={[styles.chipText, torch && styles.chipTextActive]}>
              {torch ? 'Light on' : 'Light off'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.guideArea} pointerEvents="none">
          <View style={styles.guide}>
            <View style={[styles.corner, styles.cornerTopLeft]} />
            <View style={[styles.corner, styles.cornerTopRight]} />
            <View style={[styles.corner, styles.cornerBottomLeft]} />
            <View style={[styles.corner, styles.cornerBottomRight]} />
          </View>
          <Text style={styles.tip}>
            Spread the pills on a plain surface that contrasts with them, fill the frame, and
            keep the light even.
          </Text>
        </View>

        <View style={styles.bottomBar}>
          <Pressable style={styles.sideAction} onPress={pickFromLibrary} hitSlop={8}>
            <Text style={styles.sideActionText}>Library</Text>
          </Pressable>

          <Pressable
            style={[styles.shutter, (capturing || busy) && styles.shutterBusy]}
            onPress={takePhoto}
            disabled={capturing || busy}
          >
            {capturing || busy ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <View style={styles.shutterInner} />
            )}
          </Pressable>

          <View style={styles.sideAction} />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centred: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  overlay: { flex: 1, justifyContent: 'space-between' },

  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.overlay,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  chipTextActive: { color: colors.bg },

  guideArea: { alignItems: 'center', paddingHorizontal: spacing.xl },
  guide: {
    width: '92%',
    aspectRatio: 1,
    maxHeight: 380,
  },
  corner: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderColor: 'rgba(255,255,255,0.75)',
  },
  cornerTopLeft: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 10 },
  cornerTopRight: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 10 },
  cornerBottomLeft: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 10 },
  cornerBottomRight: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 10 },
  tip: {
    marginTop: spacing.lg,
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    backgroundColor: colors.overlay,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    overflow: 'hidden',
  },

  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
  },
  sideAction: { width: 76 },
  sideActionText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterBusy: { backgroundColor: colors.textMuted },
  shutterInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 3,
    borderColor: colors.bg,
  },

  permissionTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  permissionBody: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
  },
  primaryButtonText: { color: colors.bg, fontSize: 16, fontWeight: '700' },
  linkButton: { marginTop: spacing.lg },
  linkButtonText: { color: colors.textMuted, fontSize: 15 },
});
