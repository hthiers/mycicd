const crypto = require('crypto');
const bcrypt = require('bcrypt');
const cryptoService = require('./crypto');

const BCRYPT_ROUNDS = 12;
const DEK_LENGTH = 32;

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function generateDEK() {
  return crypto.randomBytes(DEK_LENGTH);
}

// Wrap the DEK with a key derived from the login password (PBKDF2 + AES-256-GCM)
function wrapDEK(dek, loginPassword) {
  const salt = crypto.randomBytes(cryptoService.SALT_LENGTH);
  const wrappingKey = cryptoService.deriveKey(loginPassword, salt);
  const wrapped = cryptoService.encryptWithKey(dek.toString('hex'), wrappingKey);
  const [iv, tag, encrypted] = wrapped.split(':');

  return {
    salt: salt.toString('hex'),
    iv,
    tag,
    encrypted
  };
}

// Unwrap the DEK using the login password; throws if the password is wrong
function unwrapDEK(wrappedDEK, loginPassword) {
  const salt = Buffer.from(wrappedDEK.dek_salt, 'hex');
  const wrappingKey = cryptoService.deriveKey(loginPassword, salt);
  const combined = `${wrappedDEK.dek_iv}:${wrappedDEK.dek_tag}:${wrappedDEK.dek_encrypted}`;
  const dekHex = cryptoService.decryptWithKey(combined, wrappingKey);
  return Buffer.from(dekHex, 'hex');
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateDEK,
  wrapDEK,
  unwrapDEK
};
