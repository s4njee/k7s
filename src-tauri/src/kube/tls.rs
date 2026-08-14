//! Parsing the *public* certificate of a `kubernetes.io/tls` Secret (B48).
//! Only the `tls.crt` value is touched — the private key is never read. The
//! parsed metadata (subject, SANs, issuer, validity) is not secret, and it's the
//! thing that takes sites down when it expires.

use serde::Serialize;

/// The public metadata of a certificate, for the properties panel.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    pub subject: String,
    /// Comma-joined SANs (DNS names + IPs).
    pub san: String,
    pub issuer: String,
    /// RFC3339 notBefore.
    pub not_before: String,
    /// RFC3339 notAfter.
    pub not_after: String,
}

/// Parse a PEM certificate (the `tls.crt` value of a TLS Secret), returning its
/// public metadata, or None when the value isn't a parseable certificate.
pub fn parse_crt(crt_pem: &[u8]) -> Option<CertInfo> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(crt_pem).ok()?;
    let cert = pem.parse_x509().ok()?;

    let san = cert
        .subject_alternative_name()
        .ok()
        .flatten()
        .map(|san| {
            san.value
                .general_names
                .iter()
                .filter_map(|g| match g {
                    x509_parser::extensions::GeneralName::DNSName(d) => Some((*d).to_string()),
                    x509_parser::extensions::GeneralName::IPAddress(ip) => {
                        Some(ip.iter().map(|b| b.to_string()).collect::<Vec<_>>().join("."))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();

    let validity = cert.validity();
    Some(CertInfo {
        subject: cert.subject().to_string(),
        san,
        issuer: cert.issuer().to_string(),
        not_before: unix_to_rfc3339(validity.not_before.timestamp()),
        not_after: unix_to_rfc3339(validity.not_after.timestamp()),
    })
}

/// Unix seconds → RFC3339 (for the age cells the frontend formats).
fn unix_to_rfc3339(ts: i64) -> String {
    let dt = chrono::DateTime::from_timestamp(ts, 0).unwrap_or_else(chrono::Utc::now);
    dt.to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{date_time_ymd, CertificateParams};

    /// A certificate's public metadata is parsed: subject, SANs, issuer, and the
    /// validity window as RFC3339 — the fields an `openssl x509 -text` shows.
    #[test]
    fn parses_a_certificate() {
        let mut params =
            CertificateParams::new(vec!["test.example.com".to_string(), "api.example.com".to_string()])
                .unwrap();
        params.distinguished_name = rcgen::DistinguishedName::new();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "test.example.com");
        params.not_before = date_time_ymd(2026, 1, 1);
        params.not_after = date_time_ymd(2027, 1, 1);
        let key_pair = rcgen::KeyPair::generate().unwrap();
        let cert = params.self_signed(&key_pair).unwrap();

        let info = parse_crt(cert.pem().as_bytes()).expect("a valid PEM cert parses");
        assert!(info.subject.contains("test.example.com"), "subject: {}", info.subject);
        assert!(info.san.contains("test.example.com"), "SAN: {}", info.san);
        assert!(info.san.contains("api.example.com"));
        assert_eq!(info.not_before, "2026-01-01T00:00:00+00:00");
        assert_eq!(info.not_after, "2027-01-01T00:00:00+00:00");
    }

    /// Junk that isn't a certificate parses to None — the panel then shows no
    /// Certificate section rather than erroring.
    #[test]
    fn junk_is_not_a_certificate() {
        assert!(parse_crt(b"not a cert").is_none());
    }
}
