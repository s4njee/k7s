/**
 * Cycle a kubeconfig through a QR sequence (M9).
 *
 * The selected context is exported as a standalone kubeconfig (certs included)
 * and encoded with the same MK7S1 frames mk7s on a phone reads. Closing this
 * dialog drops the frames — a partial scan on the phone imports nothing.
 */

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import styles from "./ShowKubeconfigQr.module.css";
import { getProvider } from "../../providers";
import { encodeHandoff } from "../../lib/handoff";

interface ShowKubeconfigQrProps {
  context: string;
  onClose: () => void;
}

/** Long enough for a phone camera to focus and decode before the next frame. */
const CYCLE_MS = 2500;

export function ShowKubeconfigQr({ context, onClose }: ShowKubeconfigQrProps) {
  const [frames, setFrames] = useState<string[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const yaml = await getProvider().exportContextKubeconfig(context);
        const encoded = await encodeHandoff(yaml);
        const urls = await Promise.all(
          encoded.map((f) =>
            QRCode.toDataURL(f, {
              errorCorrectionLevel: "M",
              margin: 1,
              width: 320,
              color: { dark: "#111111", light: "#ffffff" },
            }),
          ),
        );
        if (!cancelled) {
          setFrames(encoded);
          setImages(urls);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context]);

  useEffect(() => {
    if (paused || images.length < 2) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % images.length), CYCLE_MS);
    return () => clearInterval(t);
  }, [images.length, paused]);

  return (
    <div className={styles.scrim} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.title}>Show kubeconfig QR</div>
        <p className={styles.hint}>
          In mk7s on a phone, open the cluster switcher and tap Scan kubeconfig….
          Each frame stays up for a few seconds so the camera can focus. Click the
          code to pause; a partial scan on the phone imports nothing.
        </p>
        {error && <div className={styles.error}>{error}</div>}
        {!error && images.length === 0 && <p className={styles.status}>Encoding…</p>}
        {images[idx] && (
          <div className={styles.qrWrap}>
            <button
              type="button"
              className={styles.qrBtn}
              onClick={() => setPaused((p) => !p)}
              title={paused ? "Resume cycling" : "Pause on this frame"}
            >
              <img
                className={styles.qr}
                src={images[idx]}
                alt={`QR frame ${idx + 1} of ${images.length}`}
              />
            </button>
            <p className={styles.status}>
              {context} · frame {idx + 1} / {frames.length}
              {paused ? " · paused" : ""}
            </p>
            {images.length > 1 && (
              <div className={styles.step}>
                <button
                  type="button"
                  className={styles.close}
                  onClick={() => {
                    setPaused(true);
                    setIdx((i) => (i - 1 + images.length) % images.length);
                  }}
                >
                  ←
                </button>
                <button type="button" className={styles.close} onClick={() => setPaused((p) => !p)}>
                  {paused ? "Resume" : "Pause"}
                </button>
                <button
                  type="button"
                  className={styles.close}
                  onClick={() => {
                    setPaused(true);
                    setIdx((i) => (i + 1) % images.length);
                  }}
                >
                  →
                </button>
              </div>
            )}
          </div>
        )}
        <div className={styles.actions}>
          <button className={styles.close} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
