/** Trend arrows as reported by Dexcom; `unknown` covers a missing or unrecognized value. */
export const TRENDS = [
  "doubleUp",
  "singleUp",
  "fortyFiveUp",
  "flat",
  "fortyFiveDown",
  "singleDown",
  "doubleDown",
  "none",
  "notComputable",
  "rateOutOfRange",
  "unknown",
] as const;
export type Trend = (typeof TRENDS)[number];

export function toTrend(value: string | null | undefined): Trend {
  const found = TRENDS.find((trend) => trend === value);
  return found ?? "unknown";
}

/** One estimated glucose value, the same shape for every source. */
export interface GlucoseReading {
  /** When the sensor measured the value (UTC instant). */
  time: Date;
  /** Glucose in mg/dL; null when the sensor reported no value. */
  mgdl: number | null;
  /** Set when the value is outside the sensor's measuring range (below 40 or above 400 mg/dL). */
  status: "low" | "high" | null;
  trend: Trend;
  /** Rate of change in mg/dL/min, when the source reports it. */
  trendRate: number | null;
}

/** Half-open time range [from, to). */
export interface TimeRange {
  from: Date;
  to: Date;
}

export type Source = "v3" | "share";

export interface Capabilities {
  /** Readings arrive within minutes of the measurement. */
  realtime: boolean;
  /** Typical delay between measurement and availability. */
  delayMs: number;
  /** How far back readings reach; null when the whole account history is available. */
  historyMs: number | null;
}

/** What every source offers. Source-specific clients extend it. */
export interface Dexcom {
  readonly source: Source;
  readonly capabilities: Capabilities;
  /** Readings in [from, to), oldest first. */
  getReadings(range: TimeRange): Promise<GlucoseReading[]>;
  /** The newest available reading, or null if there is none. */
  getLatestReading(): Promise<GlucoseReading | null>;
}
