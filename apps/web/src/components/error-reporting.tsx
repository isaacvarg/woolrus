"use client";

import { useEffect } from "react";
import { type BrowserErrorConfig, initBrowserErrorReporting } from "@/lib/browser-error-reporting";

/** Starts browser error reporting on mount; renders nothing. Errors before hydration aren't caught. */
export function ErrorReporting(config: BrowserErrorConfig) {
  const { dsn, userId, release, environment } = config;
  useEffect(() => {
    initBrowserErrorReporting({ dsn, userId, release, environment });
  }, [dsn, userId, release, environment]);
  return null;
}
