"use client";

import { createContext, useContext, useSyncExternalStore } from "react";

// Chart colours come from daisyUI's CSS variables, so Recharts' SVG follows the light, dark and
// contrast themes. The theme is `<html data-theme>`, or the system's colour scheme when unset.

const SERIES = ["primary", "secondary", "accent", "info", "success", "warning", "error"] as const;

export type ChartColors = {
  /** One per series, in order; wraps after seven. */
  series: string[];
  text: string;
  grid: string;
  surface: string;
};

const FALLBACK: ChartColors = {
  series: ["#605dff", "#f43098", "#00d3bb", "#00bafe", "#00d390", "#fcb700", "#ff627d"],
  text: "#1f2937",
  grid: "#e5e7eb",
  surface: "#ffffff",
};

let cached: { key: string; colors: ChartColors } | null = null;

function read(): ChartColors {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    style.getPropertyValue(`--color-${name}`).trim() || fallback;
  const colors: ChartColors = {
    series: SERIES.map((name, i) => v(name, FALLBACK.series[i] as string)),
    text: v("base-content", FALLBACK.text),
    grid: v("base-300", FALLBACK.grid),
    surface: v("base-100", FALLBACK.surface),
  };
  // A stable object while nothing changed, as useSyncExternalStore requires.
  const key = JSON.stringify(colors);
  if (cached?.key !== key) cached = { key, colors };
  return cached.colors;
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    scheme.removeEventListener("change", onChange);
  };
}

export function useChartColors(): ChartColors {
  return useSyncExternalStore(subscribe, read, () => FALLBACK);
}

export const seriesColor = (colors: ChartColors, index: number) =>
  colors.series[index % colors.series.length] as string;

/** Report pages turn chart animation off, so printing never catches a line half drawn. */
export const ChartAnimation = createContext(true);

export const useChartAnimation = () => useContext(ChartAnimation);
