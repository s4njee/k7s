/**
 * Event timeline (B57): a canvas-rendered timeline of Kubernetes events.
 * - Time axis (horizontal)
 * - Events as colored marks (Normal=green, Warning=red)
 * - Swim-lanes by involved object (when viewing workload-level)
 * - Wheel-zoom + drag-pan
 * - Hover tooltip with full event details
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./EventTimeline.module.css";
import type { EventItem } from "../../providers/types";

interface EventTimelineProps {
  events: EventItem[];
}

interface RenderedDot {
  x: number;
  y: number;
  radius: number;
  event: EventItem;
}

export function EventTimeline({ events }: EventTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Pan and zoom state
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, panX: 0 });

  // Hover state for tooltips
  const [hovered, setHovered] = useState<{
    event: EventItem;
    x: number;
    y: number;
  } | null>(null);

  const dotsRef = useRef<RenderedDot[]>([]);

  // Parse event timestamps (falling back to age or now)
  const parsedEvents = useMemo(() => {
    const now = Date.now();
    return events.map((e) => {
      let ts = e.timestamp ? new Date(e.timestamp).getTime() : NaN;
      if (isNaN(ts)) {
        ts = now;
      }
      return { event: e, time: ts };
    });
  }, [events]);

  const { minTime, maxTime } = useMemo(() => {
    const times = parsedEvents.map((p) => p.time);
    if (times.length === 0) {
      const now = Date.now();
      return { minTime: now - 3600000, maxTime: now };
    }
    const min = Math.min(...times);
    const max = Math.max(...times);
    // At least 5 minutes range so points don't collapse to one spot
    const span = Math.max(max - min, 300000);
    return { minTime: max - span, maxTime: max };
  }, [parsedEvents]);

  // Group events by involved object (swim lanes)
  const lanes = useMemo(() => {
    const map = new Map<string, { label: string; items: typeof parsedEvents }>();
    for (const item of parsedEvents) {
      const inv = item.event.involved;
      const key = inv?.kind && inv?.name ? `${inv.kind}/${inv.name}` : "Events";
      if (!map.has(key)) {
        map.set(key, { label: key, items: [] });
      }
      map.get(key)!.items.push(item);
    }
    return Array.from(map.values());
  }, [parsedEvents]);

  // Redraw canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const LEFT_PAD = 120;
    const RIGHT_PAD = 30;
    const TOP_PAD = 40;
    const BOTTOM_PAD = 30;
    const plotWidth = width - LEFT_PAD - RIGHT_PAD;
    const timeSpan = maxTime - minTime || 1;

    // Time to X coordinate mapper
    const timeToX = (t: number) => {
      const fraction = (t - minTime) / timeSpan;
      return LEFT_PAD + (fraction * plotWidth * zoom) + panX;
    };

    // Draw horizontal lane guides and labels
    const laneHeight = Math.max(40, (height - TOP_PAD - BOTTOM_PAD) / Math.max(lanes.length, 1));

    ctx.font = "10px JetBrains Mono, monospace";
    ctx.fillStyle = "rgba(140, 150, 170, 0.8)";
    ctx.strokeStyle = "rgba(140, 150, 170, 0.15)";
    ctx.lineWidth = 1;

    // Time axis top line
    ctx.beginPath();
    ctx.moveTo(LEFT_PAD, TOP_PAD - 10);
    ctx.lineTo(width - RIGHT_PAD, TOP_PAD - 10);
    ctx.stroke();

    // Time ticks
    const tickCount = 6;
    for (let i = 0; i <= tickCount; i++) {
      const t = minTime + (timeSpan / tickCount) * i;
      const x = timeToX(t);
      if (x >= LEFT_PAD && x <= width - RIGHT_PAD) {
        ctx.beginPath();
        ctx.moveTo(x, TOP_PAD - 15);
        ctx.lineTo(x, TOP_PAD - 8);
        ctx.stroke();

        const date = new Date(t);
        const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        ctx.fillText(timeStr, x - 25, TOP_PAD - 20);
      }
    }

    const dots: RenderedDot[] = [];

    lanes.forEach((lane, laneIdx) => {
      const laneY = TOP_PAD + laneIdx * laneHeight + laneHeight / 2;

      // Lane line
      ctx.beginPath();
      ctx.strokeStyle = "rgba(140, 150, 170, 0.08)";
      ctx.moveTo(LEFT_PAD, laneY);
      ctx.lineTo(width - RIGHT_PAD, laneY);
      ctx.stroke();

      // Lane label (truncated)
      ctx.fillStyle = "rgba(180, 190, 210, 0.7)";
      const label = lane.label.length > 14 ? lane.label.slice(0, 13) + "…" : lane.label;
      ctx.fillText(label, 12, laneY + 3);

      // Event dots
      for (const item of lane.items) {
        const x = timeToX(item.time);
        if (x < LEFT_PAD - 10 || x > width - RIGHT_PAD + 10) continue;

        const isWarn = item.event.type === "Warning";
        const dotRadius = Math.min(8, Math.max(4, 3 + Math.log2(item.event.count || 1)));

        // Outer glow/ring for multiple counts
        if (item.event.count > 1) {
          ctx.beginPath();
          ctx.arc(x, laneY, dotRadius + 3, 0, Math.PI * 2);
          ctx.fillStyle = isWarn ? "rgba(247, 118, 142, 0.2)" : "rgba(158, 206, 106, 0.2)";
          ctx.fill();
        }

        // Dot fill
        ctx.beginPath();
        ctx.arc(x, laneY, dotRadius, 0, Math.PI * 2);
        ctx.fillStyle = isWarn ? "#f7768e" : "#9ece6a";
        ctx.fill();

        dots.push({
          x,
          y: laneY,
          radius: dotRadius + 4,
          event: item.event,
        });
      }
    });

    dotsRef.current = dots;
    ctx.restore();
  }, [lanes, minTime, maxTime, zoom, panX]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Window resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(container);
    return () => ro.disconnect();
  }, [draw]);

  // Mouse interaction handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, panX };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    if (isDragging) {
      const dx = e.clientX - dragStartRef.current.x;
      setPanX(dragStartRef.current.panX + dx);
      return;
    }

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Check hit test against dots
    const hit = dotsRef.current.find((dot) => {
      const dx = dot.x - mouseX;
      const dy = dot.y - mouseY;
      return Math.sqrt(dx * dx + dy * dy) <= dot.radius;
    });

    if (hit) {
      setHovered({ event: hit.event, x: mouseX + 12, y: mouseY + 12 });
    } else {
      setHovered(null);
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    setZoom((z) => Math.min(20, Math.max(0.5, z * factor)));
  };

  const resetView = () => {
    setZoom(1);
    setPanX(0);
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span className={styles.count}>{events.length} events</span>
        <div className={styles.controls}>
          <span>scroll to zoom · drag to pan</span>
          {(zoom !== 1 || panX !== 0) && (
            <button className={styles.resetBtn} onClick={resetView}>
              reset view
            </button>
          )}
        </div>
      </div>
      <div
        className={styles.canvasWrap}
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          handleMouseUp();
          setHovered(null);
        }}
        onWheel={handleWheel}
      >
        <canvas ref={canvasRef} className={styles.canvas} />
        {hovered && (
          <div
            className={styles.tooltip}
            style={{
              left: Math.min(hovered.x, (containerRef.current?.clientWidth ?? 400) - 290),
              top: Math.max(10, hovered.y),
            }}
          >
            <div className={styles.headline}>
              <span
                className={styles.tooltipType}
                style={{
                  color: hovered.event.type === "Warning" ? "var(--status-err)" : "var(--status-ok)",
                }}
              >
                {hovered.event.type}
              </span>
              <span className={styles.tooltipReason}>{hovered.event.reason}</span>
            </div>
            <div className={styles.tooltipMsg}>{hovered.event.message}</div>
            <div className={styles.tooltipMeta}>
              {hovered.event.age} · count: {hovered.event.count}
            </div>
          </div>
        )}
      </div>
      {/* B84: the timeline is canvas; give assistive tech the same data as text. */}
      <ul className="visuallyHidden">
        {events.map((e, i) => (
          <li key={i}>
            {`${e.type} ${e.reason} · ${e.age} ×${e.count} — ${e.message}`}
          </li>
        ))}
      </ul>
    </div>
  );
}