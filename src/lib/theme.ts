/** Shared visual language. Dark by default: pills are usually photographed
 *  under bright light, and a dark UI keeps the photo the brightest thing on
 *  screen so the markers stay readable against it. */
export const colors = {
  bg: '#0B0F14',
  surface: '#151B23',
  surfaceAlt: '#1E2732',
  border: '#2A3340',
  text: '#E8EDF3',
  textMuted: '#8A97A6',
  textFaint: '#5C6875',
  accent: '#35D0A5',
  accentDim: '#1E6B58',
  warn: '#F5A524',
  danger: '#F5576C',
  overlay: 'rgba(11,15,20,0.82)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

/** Confidence bands the UI speaks in, so the wording matches the number. */
export type ConfidenceBand = 'high' | 'medium' | 'low';

export function confidenceBand(confidence: number, hasBlocker: boolean): ConfidenceBand {
  if (hasBlocker || confidence < 0.7) return 'low';
  if (confidence < 0.9) return 'medium';
  return 'high';
}

export function bandColor(band: ConfidenceBand): string {
  return band === 'high' ? colors.accent : band === 'medium' ? colors.warn : colors.danger;
}

export function bandLabel(band: ConfidenceBand): string {
  return band === 'high'
    ? 'High confidence'
    : band === 'medium'
      ? 'Worth a check'
      : 'Needs your review';
}
