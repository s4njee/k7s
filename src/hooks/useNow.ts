/**
 * useNow — returns a timestamp that updates on a fixed interval, so age columns
 * ("4d2h") re-render periodically without each row owning a timer. Default 30s.
 */

import { useEffect, useState } from "react";

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
