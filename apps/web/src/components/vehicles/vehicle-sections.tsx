/**
 * A vehicle's tabs in one module, loaded on demand (./vehicle-lazy.tsx): the Overview, Readings
 * (with the proof strip and the chart), Schedules (with starter schedules) and Costs (plan T18),
 * and the other tasks' Services, Fuel and Documents through ./slots.tsx. vite.config.ts names this
 * module's chunk into assets/household/, which the service worker caches on first use instead of
 * precaching (D101): all of it reads the server. The charts load later still, with the tab that
 * draws them (components/charts/lazy.tsx).
 */
export { VehicleCosts } from './costs-tab';
export { VehicleOverview } from './overview';
export { VehicleReadings } from './readings-tab';
export { VehicleSchedules } from './schedules-tab';
export { VehicleDocuments, VehicleFuel, VehicleReportSheet, VehicleServices } from './slots';
