use std::fs;
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use sha2::{Digest, Sha256};

const NONCE_LEN: usize = 12;

/// Encrypts TOTP secrets at rest (ChaCha20-Poly1305; blob = nonce || ciphertext).
#[derive(Clone)]
pub struct Crypto {
    cipher: ChaCha20Poly1305,
}

impl Crypto {
    /// Key = SHA-256 of the key material: `env_key` if given, else `data_dir/secret.key`
    /// (generated once with mode 0600).
    pub fn load(data_dir: &Path, env_key: Option<&str>) -> Result<Self> {
        match env_key.filter(|k| !k.is_empty()) {
            Some(material) => Ok(Self::from_material(material.as_bytes())),
            None => {
                let material = read_or_create_key_file(&data_dir.join("secret.key"))?;
                Ok(Self::from_material(material.as_bytes()))
            }
        }
    }

    pub fn from_material(material: &[u8]) -> Self {
        let key = Sha256::digest(material);
        Self {
            cipher: ChaCha20Poly1305::new(&Key::from(<[u8; 32]>::from(key))),
        }
    }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let nonce_bytes: [u8; NONCE_LEN] = rand::random();
        let ciphertext = self
            .cipher
            .encrypt(&Nonce::from(nonce_bytes), plaintext)
            .map_err(|_| anyhow::anyhow!("encryption failed"))?;
        let mut blob = nonce_bytes.to_vec();
        blob.extend_from_slice(&ciphertext);
        Ok(blob)
    }

    pub fn decrypt(&self, blob: &[u8]) -> Result<Vec<u8>> {
        if blob.len() <= NONCE_LEN {
            bail!("encrypted blob is too short");
        }
        let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
        let nonce = Nonce::try_from(nonce).context("invalid nonce")?;
        self.cipher
            .decrypt(&nonce, ciphertext)
            .map_err(|_| anyhow::anyhow!("decryption failed (wrong secret key?)"))
    }
}

fn read_or_create_key_file(path: &Path) -> Result<String> {
    if !path.exists() {
        let key: [u8; 32] = rand::random();
        let encoded = URL_SAFE_NO_PAD.encode(key);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        match options.open(path) {
            Ok(mut file) => {
                file.write_all(encoded.as_bytes())
                    .with_context(|| format!("writing {}", path.display()))?;
                tracing::info!(path = %path.display(), "generated new secret key file");
                return Ok(encoded);
            }
            // Lost a race with another process: fall through and read its key.
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(err).with_context(|| format!("creating {}", path.display())),
        }
    }
    let content =
        fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let content = content.trim().to_string();
    if content.is_empty() {
        bail!("{} is empty", path.display());
    }
    Ok(content)
}

/// 128-bit random token, base64url without padding (22 chars).
pub fn random_token() -> String {
    let bytes: [u8; 16] = rand::random();
    URL_SAFE_NO_PAD.encode(bytes)
}

/// SHA-256 hex digest; tokens are stored only in this form.
pub fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
