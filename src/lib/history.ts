import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'pillsnap.history.v1';
const MAX_ENTRIES = 200;

export interface CountRecord {
  id: string;
  /** The number the user settled on, after any corrections. */
  count: number;
  /** What the pipeline found on its own, before corrections. */
  detected: number;
  /** Markers the user added by tapping. */
  added: number;
  /** Markers the user removed by tapping. */
  removed: number;
  confidence: number;
  /** Epoch milliseconds. */
  at: number;
  label?: string;
  imageUri?: string;
}

export async function loadHistory(): Promise<CountRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Storage can outlive a schema change, so drop anything malformed rather
    // than letting one bad row take down the history screen.
    return parsed.filter(isCountRecord);
  } catch {
    return [];
  }
}

export async function saveCount(
  record: Omit<CountRecord, 'id' | 'at'> & Partial<Pick<CountRecord, 'id' | 'at'>>,
): Promise<CountRecord[]> {
  const entry: CountRecord = {
    ...record,
    id: record.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: record.at ?? Date.now(),
  };

  const history = [entry, ...(await loadHistory())].slice(0, MAX_ENTRIES);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  return history;
}

export async function deleteCount(id: string): Promise<CountRecord[]> {
  const history = (await loadHistory()).filter((entry) => entry.id !== id);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  return history;
}

export async function clearHistory(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

function isCountRecord(value: unknown): value is CountRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.count === 'number' &&
    typeof v.detected === 'number' &&
    typeof v.at === 'number'
  );
}

/** "Today at 14:32", "Yesterday at 09:05", or a full date for anything older. */
export function formatWhen(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  // Compare against calendar boundaries rather than subtracting 24 hours, so
  // "yesterday" means yesterday's date and not "somewhere in the last day".
  // Rolling the date back by one also lands correctly across month ends and
  // daylight-saving shifts, which raw millisecond arithmetic does not.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  if (date >= startOfToday) return `Today at ${time}`;
  if (date >= startOfYesterday) return `Yesterday at ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}
