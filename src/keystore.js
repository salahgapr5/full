// Stores API keys encrypted at rest via Electron's safeStorage, which on
// macOS is backed by the Keychain. Keys never touch localStorage or the
// renderer's filesystem access - only main.js reads/writes the encrypted
// files, and only the decrypted value is ever sent to the renderer (over
// the same IPC channel it already trusts, same as any other vem:* call).
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

function keyFile(name) {
  // `name` is always one of a small fixed set from preload.js ('anthropic',
  // 'gemini') - never used to build the filename from renderer-supplied text.
  return path.join(app.getPath('userData'), `key-${name}.enc`);
}

function setKey(name, value) {
  const file = keyFile(name);
  if (!value) {
    try { fs.unlinkSync(file); } catch (_) { /* already absent */ }
    return { ok: true };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'Secure storage is not available on this system.' };
  }
  fs.writeFileSync(file, safeStorage.encryptString(value));
  return { ok: true };
}

function getKey(name) {
  try {
    const enc = fs.readFileSync(keyFile(name));
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(enc);
  } catch (_) {
    return ''; // no key saved yet
  }
}

module.exports = { setKey, getKey };
