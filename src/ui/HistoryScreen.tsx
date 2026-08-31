import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatWhen, type CountRecord } from '../lib/history';
import { bandColor, colors, confidenceBand, radius, spacing } from '../lib/theme';

interface Props {
  history: CountRecord[];
  onClose: () => void;
  onDelete: (id: string) => void;
}

export default function HistoryScreen({ history, onClose, onDelete }: Props) {
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>History</Text>
        <Pressable style={styles.closeButton} onPress={onClose} hitSlop={8}>
          <Text style={styles.closeText}>Done</Text>
        </Pressable>
      </View>

      {history.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No counts yet</Text>
          <Text style={styles.emptyBody}>Counts you save will be listed here.</Text>
        </View>
      ) : (
        <FlatList
          data={history}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const accent = bandColor(confidenceBand(item.confidence, false));
            const edits = item.added + item.removed;
            return (
              <View style={styles.row}>
                <View style={[styles.rowBar, { backgroundColor: accent }]} />
                <View style={styles.rowBody}>
                  <Text style={styles.rowCount}>{item.count}</Text>
                  <View style={styles.rowMeta}>
                    <Text style={styles.rowWhen}>{formatWhen(item.at)}</Text>
                    <Text style={styles.rowDetail}>
                      {item.detected} found automatically
                      {edits > 0
                        ? ` · you corrected ${edits} ${edits === 1 ? 'pill' : 'pills'}`
                        : ' · no corrections'}
                    </Text>
                  </View>
                </View>
                <Pressable
                  style={styles.deleteButton}
                  onPress={() => onDelete(item.id)}
                  hitSlop={8}
                >
                  <Text style={styles.deleteText}>Delete</Text>
                </Pressable>
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  title: { color: colors.text, fontSize: 26, fontWeight: '800' },
  closeButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
  },
  closeText: { color: colors.text, fontSize: 15, fontWeight: '600' },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  emptyBody: { color: colors.textMuted, fontSize: 15, marginTop: spacing.sm },

  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    overflow: 'hidden',
  },
  rowBar: { width: 4, alignSelf: 'stretch' },
  rowBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingLeft: spacing.md,
  },
  rowCount: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
    minWidth: 56,
  },
  rowMeta: { flex: 1 },
  rowWhen: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowDetail: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  deleteButton: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  deleteText: { color: colors.textFaint, fontSize: 13, fontWeight: '600' },
});
