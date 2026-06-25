import { scoreColor } from '@renderer/shared/lib/format';

interface ScoreRingProps {
  /** 0..100 performance score. */
  score: number;
  size?: number;
  strokeWidth?: number;
  /** Hide the numeric label in the center. */
  hideLabel?: boolean;
}

/** Circular progress ring colored by score band. */
export function ScoreRing({
  score,
  size = 40,
  strokeWidth = 4,
  hideLabel = false,
}: ScoreRingProps): JSX.Element {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const color = scoreColor(clamped);
  const center = size / 2;

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      title={`Performance score: ${clamped}/100`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#252c40"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      {!hideLabel && (
        <span
          className="absolute font-mono font-semibold"
          style={{ color, fontSize: Math.max(10, size * 0.28) }}
        >
          {clamped}
        </span>
      )}
    </div>
  );
}
