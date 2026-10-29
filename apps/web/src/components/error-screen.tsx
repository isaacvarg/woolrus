"use client";

import { useEffect } from "react";
import { captureRenderError } from "@/lib/browser-error-reporting";

/** What the error screen says; `error.tsx` passes translations, `global-error.tsx` the catalog. */
export type ErrorScreenText = { title: string; body: string; retry: string; reference: string };

export function ErrorScreen({
  error,
  retry,
  text,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  text: ErrorScreenText;
}) {
  useEffect(() => {
    captureRenderError(error);
  }, [error]);
  return (
    <main
      role="alert"
      className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6"
    >
      <h1 className="text-3xl font-bold">{text.title}</h1>
      <p>{text.body}</p>
      {error.digest && (
        <p className="text-sm opacity-70">
          {text.reference} <code>{error.digest}</code>
        </p>
      )}
      <button type="button" className="btn btn-primary self-start" onClick={retry}>
        {text.retry}
      </button>
    </main>
  );
}
