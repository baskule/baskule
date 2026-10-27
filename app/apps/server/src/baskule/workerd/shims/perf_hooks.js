// T3's event loop monitor needs histogram and utilization APIs; a cell reports zeros.
export const performance = {
  now: () => globalThis.performance.now(),
  timeOrigin: globalThis.performance.timeOrigin,
  eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }),
  mark() {},
  measure() {},
  clearMarks() {},
  clearMeasures() {},
  getEntriesByName: () => [],
  getEntriesByType: () => [],
  toJSON: () => ({}),
};
export const monitorEventLoopDelay = () => ({
  enable() {},
  disable() {},
  reset() {},
  percentile: () => 0,
  mean: 0,
  max: 0,
  min: 0,
  stddev: 0,
  count: 0,
  percentiles: new Map(),
});
export const createHistogram = monitorEventLoopDelay;
export class PerformanceObserver {
  observe() {}
  disconnect() {}
}
export default { performance, monitorEventLoopDelay, createHistogram, PerformanceObserver };
