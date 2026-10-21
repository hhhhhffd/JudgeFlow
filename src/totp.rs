use anyhow::{Context, Result};
use totp_rs::{Algorithm, Builder, Secret, Totp};

use crate::crypto::Crypto;

const ISSUER: &str = "JudgeFlow";

/// A freshly generated TOTP secret in the forms callers need.
pub struct NewSecret {
    /// Encrypted, ready to store in the database.
    pub encrypted: Vec<u8>,
    pub otpauth_uri: String,
    /// Base32, for manual entry.
    pub secret: String,
}

/// Builds the TOTP verifier: SHA1, 6 digits, 30 s step, skew 1.
pub fn build(secret: Vec<u8>, account_name: &str) -> Result<Totp> {
    Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(6)
        .with_step_duration(30)
        .with_skew(1)
        .with_secret(secret)
        // ':' is not allowed in the account name part of the otpauth URI.
        .with_account_name(account_name.replace(':', "-"))
        .with_issuer(Some(ISSUER))
        .build()
        .context("building TOTP")
}

/// Generates a new secret for `account_name`.
pub fn generate(crypto: &Crypto, account_name: &str) -> Result<NewSecret> {
    let secret = Secret::generate();
    let totp = build(secret.as_bytes().to_vec(), account_name)?;
    Ok(NewSecret {
        encrypted: crypto.encrypt(secret.as_bytes())?,
        otpauth_uri: totp.to_url().context("building otpauth URI")?,
        secret: secret.to_base32(),
    })
}

/// Decrypts a stored secret and checks `code` against it. Returns the matched time step.
/// Callers must enforce replay protection (`step > last accepted step`) in a write transaction.
pub fn check_code(
    crypto: &Crypto,
    encrypted: &[u8],
    account_name: &str,
    code: &str,
) -> Result<Option<u64>> {
    let totp = build(crypto.decrypt(encrypted)?, account_name)?;
    Ok(totp.check_current(code.trim()))
}
