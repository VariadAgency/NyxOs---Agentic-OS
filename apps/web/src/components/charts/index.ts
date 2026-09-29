// Gemeinsame Diagramm-Bausteine. Eigene SVG-Bausteine statt Recharts: volle Kontrolle über
// Einzeichnen, Tastatur-Tooltips, reduzierte Bewegung und ruhiges Hover (nur der Index-Zustand
// ändert sich, die Pfade sind memoisiert). Farben ausschließlich aus den `--a-*`-Tokens.
export { AreaChart, type AreaPoint, type AreaSeries } from "./AreaChart";
export { BarChart, type BarDatum } from "./BarChart";
export { ChartLegend, ChartTooltip } from "./ChartTooltip";
export { Donut, MiniRing, RingMeter, type DonutSegment } from "./Donut";
export { Heatmap, HeatLegend } from "./Heatmap";
export { Sparkline } from "./Sparkline";
export { StatCard, TrendChip, type StatTrend } from "./StatCard";
export * from "./scale";
