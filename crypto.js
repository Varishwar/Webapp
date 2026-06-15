'use strict';
// Web Crypto API helpers — ECDH P-256 key exchange + AES-256-GCM encryption.
// All operations are client-only; the server never sees plaintext.

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );
}

async function exportPublicKey(publicKey) {
  const buf = await crypto.subtle.exportKey('spki', publicKey);
  return bufToB64(buf);
}

async function importPublicKey(b64) {
  const buf = b64ToBuf(b64);
  return crypto.subtle.importKey(
    'spki',
    buf,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

async function deriveSharedKey(privateKey, peerPublicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptMessage(sharedKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, encoded);
  return {
    encryptedMessage: bufToB64(ciphertext),
    iv: bufToB64(iv.buffer),
  };
}

async function decryptMessage(sharedKey, encryptedMessage, ivB64) {
  const ciphertext = b64ToBuf(encryptedMessage);
  const iv = b64ToBuf(ivB64);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedKey, ciphertext);
  return new TextDecoder().decode(plaintext);
}
