const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup table, built once. */
const LOOKUP = (() => {
  const table = new Uint8Array(256).fill(255);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/**
 * Decode base64 to bytes.
 *
 * Written out rather than reaching for `atob` or Buffer: neither is reliably
 * present across Hermes, the web target and the Jest environment, and a photo
 * failing to decode on one platform is a miserable bug to chase. Characters
 * outside the alphabet (whitespace, data-URI padding) are skipped.
 */
export function base64ToBytes(input: string): Uint8Array {
  // Tolerate a full data URI as well as bare base64.
  const comma = input.indexOf(',');
  const body = input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;

  let length = 0;
  for (let i = 0; i < body.length; i++) {
    if (LOOKUP[body.charCodeAt(i)] !== 255) length++;
  }

  const bytes = new Uint8Array(Math.floor((length * 3) / 4));
  let accumulator = 0;
  let bits = 0;
  let out = 0;

  for (let i = 0; i < body.length; i++) {
    const value = LOOKUP[body.charCodeAt(i)];
    if (value === 255) continue;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (accumulator >> bits) & 0xff;
    }
  }

  return out === bytes.length ? bytes : bytes.subarray(0, out);
}
