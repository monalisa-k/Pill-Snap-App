import * as Haptics from 'expo-haptics';
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { bandColor, bandLabel, colors, confidenceBand, radius, spacing } from '../lib/theme';
import type { CountResult } from '../vision/types';
import PillCanvas, { type CanvasMarker } from './PillCanvas';

interface Props {
  imageUri: string;
  result: CountResult;
  onRetake: () => void;
  onSave: (payload: {
    count: number;
    detected: number;
    added: number;
    removed: number;
    confidence: number;
  }) => void;
}

/**
 * Review screen: the count, the evidence for it, and the means to fix it.
 *
 * The number is shown next to the dots that produced it rather than on its
 * own. A bare number asks the user to trust the app; a number with every
 * counted pill marked lets them verify it at a glance and correct it in a
 * couple of taps, which is the only honest route to an exact answer.
 */
export default function ResultScreen({ imageUri, result, onRetake, onSave }: Props) {
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<{ id: string; x: number; y: number }[]>([]);

  const detectedMarkers = useMemo<CanvasMarker[]>(
    () =>
      result.markers.map((marker, index) => ({
        id: `d${index}`,
        x: marker.x,
        y: marker.y,
        highlight: marker.fromCluster,
        userAdded: false,
      })),
    [result],
  );

  const markers = useMemo<CanvasMarker[]>(
    () => [
      ...detectedMarkers.filter((marker) => !removed.has(marker.id)),
      ...added.map((marker) => ({ ...marker, highlight: false, userAdded: true })),
    ],
    [detectedMarkers, removed, added],
  );

  const count = markers.length;
  const blockers = result.warnings.filter((w) => w.severity === 'block');
  const band = confidenceBand(result.confidence, blockers.length > 0);
  const accent = bandColor(band);
  const corrected = removed.size > 0 || added.length > 0;

  const handleAdd = (x: number, y: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setAdded((current) => [
      ...current,
      { id: `u${Date.now()}-${current.length}`, x, y },
    ]);
  };

  const handleRemove = (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (id.startsWith('u')) {
      setAdded((current) => current.filter((marker) => marker.id !== id));
      return;
    }
    setRemoved((current) => new Set(current).add(id));
  };

  const reset = () => {
    setRemoved(new Set());
    setAdded([]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.canvasWrap}>
        <PillCanvas
          imageUri={imageUri}
          imageWidth={result.processedWidth}
          imageHeight={result.processedHeight}
          markers={markers}
          pillRadius={result.unitRadius > 0 ? result.unitRadius : 10}
          onAdd={handleAdd}
          onRemove={handleRemove}
          editable
        />
        <View style={styles.canvasHint} pointerEvents="none">
          <Text style={styles.canvasHintText}>
            Pinch to zoom · tap a dot to remove · tap a gap to add
          </Text>
        </View>
      </View>

      <View style={styles.panel}>
        <View style={styles.headline}>
          <View style={styles.headlineLeft}>
            {/* A refused photo must not look like an answer. Showing 464 in the
                same enormous type as a good count invites it to be believed and
                written down, which is the one outcome worth designing against;
                the number stays visible, but small and clearly set aside. */}
            <Text style={blockers.length > 0 ? styles.countRejected : styles.count}>{count}</Text>
            <Text style={styles.countLabel}>
              {blockers.length > 0 ? "can't count this photo" : count === 1 ? 'pill' : 'pills'}
            </Text>
          </View>

          <View style={styles.headlineRight}>
            <View style={[styles.badge, { borderColor: accent }]}>
              <View style={[styles.badgeDot, { backgroundColor: accent }]} />
              <Text style={[styles.badgeText, { color: accent }]}>{bandLabel(band)}</Text>
              {/* The raw score alongside the band, for field testing: the band
                  is what the app acts on, but two decimals are what tell you
                  whether the thresholds are calibrated. Display only - it
                  reads the score the pipeline already returned. */}
              <Text style={[styles.badgeScore, { color: accent }]}>
                {result.confidence.toFixed(2)}
              </Text>
            </View>
            {corrected && (
              <Text style={styles.correction}>
                {result.count} found
                {added.length > 0 ? ` · +${added.length}` : ''}
                {removed.size > 0 ? ` · -${removed.size}` : ''}
              </Text>
            )}
          </View>
        </View>

        <ScrollView style={styles.notes} contentContainerStyle={styles.notesContent}>
          {result.warnings.map((warning) => (
            <View
              key={warning.code}
              style={[
                styles.note,
                {
                  borderLeftColor:
                    warning.severity === 'block' ? colors.danger : colors.warn,
                },
              ]}
            >
              <Text style={styles.noteText}>{warning.message}</Text>
            </View>
          ))}

          {result.warnings.length === 0 && (
            <View style={[styles.note, { borderLeftColor: colors.accent }]}>
              <Text style={styles.noteText}>
                Every pill was found as its own separate shape. Nothing needed guessing.
              </Text>
            </View>
          )}

          <Text style={styles.stats}>
            {result.components} shape{result.components === 1 ? '' : 's'} detected
            {result.clusters > 0
              ? ` · ${result.clusters} clump${result.clusters === 1 ? '' : 's'} split (largest held ${result.largestCluster})`
              : ''}
            {` · ${result.elapsedMs}ms`}
          </Text>
        </ScrollView>

        <View style={styles.actions}>
          <Pressable style={styles.secondaryButton} onPress={onRetake}>
            <Text style={styles.secondaryButtonText}>Retake</Text>
          </Pressable>

          {corrected && (
            <Pressable style={styles.secondaryButton} onPress={reset}>
              <Text style={styles.secondaryButtonText}>Undo edits</Text>
            </Pressable>
          )}

          <Pressable
            style={[styles.primaryButton, { backgroundColor: accent }]}
            onPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              onSave({
                count,
                detected: result.count,
                added: added.length,
                removed: removed.size,
                confidence: result.confidence,
              });
            }}
          >
            <Text style={styles.primaryButtonText}>
              {blockers.length > 0 ? `Save ${count} anyway` : `Save ${count}`}
            </Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  canvasWrap: { flex: 1, position: 'relative' },
  canvasHint: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: spacing.md,
    alignItems: 'center',
  },
  canvasHintText: {
    color: colors.text,
    fontSize: 12,
    backgroundColor: colors.overlay,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },

  panel: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    maxHeight: '46%',
  },
  headline: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  count: { color: colors.text, fontSize: 56, fontWeight: '800', lineHeight: 58 },
  countRejected: {
    color: colors.textMuted,
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 34,
    textDecorationLine: 'line-through',
  },
  headlineLeft: { flexShrink: 1, paddingRight: spacing.md },
  countLabel: { color: colors.textMuted, fontSize: 15, marginTop: 2 },
  headlineRight: { alignItems: 'flex-end', paddingTop: spacing.sm },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  badgeDot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  badgeText: { fontSize: 13, fontWeight: '700' },
  badgeScore: {
    fontSize: 13,
    fontWeight: '700',
    marginLeft: spacing.sm,
    opacity: 0.7,
    // Tabular figures so the score does not jitter sideways between results.
    fontVariant: ['tabular-nums'],
  },
  correction: { color: colors.textMuted, fontSize: 13, marginTop: spacing.sm },

  notes: { marginTop: spacing.lg },
  notesContent: { paddingBottom: spacing.md },
  note: {
    borderLeftWidth: 3,
    paddingLeft: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
  },
  noteText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  stats: { color: colors.textFaint, fontSize: 12, marginTop: spacing.xs },

  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
  },
  secondaryButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryButtonText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  primaryButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
  },
  primaryButtonText: { color: colors.bg, fontSize: 16, fontWeight: '800' },
});
