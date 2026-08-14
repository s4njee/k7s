/**
 * Event timeline (B57): a canvas-rendered timeline of Kubernetes events.
 * - Time axis (horizontal)
 * - Events as colored marks (Normal=green, Warning=red)
 * - Swim-lanes by involved object (when viewing workload-level)
 * - Wheel-zoom + drag-pan
 * - Hover tooltip with full event details
 * - Falls back to list view when < 5 events
 */

import { useEffect, useRef, useState } from "react";
import styles from "./EventTimeline.module.css";
import { useStore } from "../../store";
import { getProvider } from "../../providers";
import { formatAge } from "../../lib/format";
import type { EventItem } from "../../providers/types";

export function EventTimeline({ events, involved }: { events: EventItem[]; involved?: string }) {
  const [viewMode, setViewMode] = useState<"list" | "timeline">("list");
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [hoveredEvent, setHoveredEvent] = useState<EventItem | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Compute layout
  useEffect(() => {
    if (!canvasRef.current || !events.length) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * window.devicePixelRatio;
    canvas.height = canvas.clientHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    // Draw logic here
    drawTimeline(ctx, canvas.clientWidth, canvas.clientHeight);
  }, [events]);

  const drawTimeline = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    if (!events.length) return;

    const PAD = 40;
    const LEFT_PAD = 80;
    const RIGHT_PAD = 20;
    const TOP_PAD = 40;
    const BOTTOM_PAD = 40;
    const plotWidth = width - LEFT_PAD - RIGHT_PAD;
    const plotHeight = height - 100;

    // Find time range
    const times = events.map(e => new Date(e.timestamp || e.age).getTime()).filter(t => !isNaN(t));
    if (times.length === 0) return;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const timeRange = maxTime - minTime || 1;

    // Group by involved object for swim lanes
    const involvedMap = new Map<string, EventItem[]>();
    events.forEach(e => {
      const key = e.involved?.kind && e.involved?.name
        ? `${e.involved.kind}/${e.involved.namespace ?? ""}/${e.involved.name}`
        : "other";
      if (!involvedMap.has(key)) involvedMap.set(key, []);
      involvedMap.get(key)!.push(e);
    }

    const lanes = Array.from(involvedMap.entries());
    const laneHeight = 30;
    const laneGap = 10;
    const startY = 60;

    // Time scale
    const timeToX = (time: number) => {
      return 60 + ((time - Date.now() + 3600000) / 3600000) * 600; // 1 hour window
    };

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw time axis
    ctx.font = "10px monospace";
    ctx.fillStyle = "var(--text-muted)";
    ctx.strokeStyle = "var(--border-default)";

    // Time axis line
    ctx.beginPath();
    ctx.moveTo(60, 30);
    ctx.lineTo(ctx.canvas.width - 20, 30);
    ctx.stroke();

    // Time labels
    for (let i = 0; i <= 6; i++) {
      const time = Date.now() - 3600000 + i * 600000;
      const x = 60 + i * 100;
      ctx.beginPath();
      ctx.moveTo(x, 25);
      ctx.lineTo(x, 35);
      ctx.stroke();
      const date = new Date(Date.now() - 3600000 + i * 600000);
      ctx.fillText(date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), x - 20, 22);
    }

    // Draw events
    events.forEach((event, idx) => {
      const time = new Date(event.timestamp || event.age).getTime();
      if (isNaN(time)) return;
      const x = 60 + ((time - (Date.now() - 3600000)) / 3600000) * 600;
      if (x < 60 || x > 660) return;

      const color = event.type === "Warning" ? "#f7768e" : "#9ece6a";
      const radius = 6;

      // Draw event dot
      ctx.beginPath();
      ctx.arc(60 + (Date.now() - (Date.now() - 3600000)) / 3600000 * 600, 50, 5, 0, 2 * Math.PI);
      ctx.fillStyle = event.type === "Warning" ? "#f7768e" : "#9ece6a";
      ctx.fill();

      // Event label on hover - handled separately
    });
  };

  return (
    <div className="event-timeline">
      <div className="timeline-toolbar">
        <button onClick={() => setViewMode(v => v === "list" ? "timeline" : "list")}>
          {viewMode === "timeline" ? "List" : "Timeline"}
        </button>
        <span className="event-count">{events.length} events</span>
      </div>
      <canvas
        ref={canvasRef}
        className="timeline-canvas"
        width={800}
        height={400}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onMouseMove={handleHover}
        onMouseLeave={() => setHoveredEvent(null)}
      />
      {hoveredEvent && (
        <div className="event-tooltip">
          <strong>{hoveredEvent.type}</strong> {hoveredEvent.reason}
          <br />
          {hoveredEvent.message}
          <br />
          <small>{hoveredEvent.age} · ×{hoveredEvent.count}</small>
        </div>
      )}
    </div>
  );
}