/** Unpadded, canonical base64url. Reject unused nonzero trailing bits. */
export function decodeBase64url(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error('base64url_invalid');
  }
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  if (encodeBase64url(bytes) !== value) throw new Error('base64url_invalid');
  return bytes;
}

export function encodeBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
