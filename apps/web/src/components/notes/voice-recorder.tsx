"use client";

import { NOTE_VOICE_MAX_MS, type NoteAttachment } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";

/** A recorded memo, ready to send with the note. */
export type VoiceMemo = { file: File; durationMs: number };

/** What the server accepts, best first; Safari only records MP4, so it falls through to that. */
const RECORDING_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

const extensionOf = (type: string) =>
  type.startsWith("audio/mp4") ? "m4a" : type.startsWith("audio/ogg") ? "ogg" : "webm";

/** `m:ss`, the way a recorder shows time. */
export const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

type Recording = { recorder: MediaRecorder; stream: MediaStream; startedAt: number };

/**
 * Record voice: record, stop, replay (the player), discard. A timer runs while recording, and the
 * recording stops by itself at 5 minutes. The duration sent is the one measured here; the server
 * only range-checks it.
 */
export function VoiceRecorder({
  value,
  onChange,
  onRecordingChange,
}: {
  value: VoiceMemo | null;
  onChange: (memo: VoiceMemo | null) => void;
  /** While it's true the form shouldn't submit: the memo isn't there until recording stops. */
  onRecordingChange?: (recording: boolean) => void;
}) {
  const t = useTranslations();
  const [recording, setRecording] = useState<Recording | null>(null);
  const onRecordingChangeRef = useRef(onRecordingChange);
  onRecordingChangeRef.current = onRecordingChange;
  useEffect(() => onRecordingChangeRef.current?.(recording !== null), [recording]);
  const [elapsed, setElapsed] = useState(0);
  const recordingRef = useRef<Recording | null>(null);
  // Called from the recorder's events, which outlive the render that started it.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!recording) return;
    const tick = setInterval(() => setElapsed(Date.now() - recording.startedAt), 250);
    const cap = setTimeout(() => {
      toast.success(t("notes.voiceCapped"));
      recording.recorder.stop();
    }, NOTE_VOICE_MAX_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(cap);
    };
  }, [recording, t]);

  // Leaving mid-recording (closing the dialog) releases the microphone and keeps nothing.
  useEffect(
    () => () => {
      const current = recordingRef.current;
      if (!current) return;
      current.recorder.ondataavailable = null;
      current.recorder.onstop = null;
      if (current.recorder.state !== "inactive") current.recorder.stop();
      for (const track of current.stream.getTracks()) track.stop();
    },
    [],
  );

  async function start() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Denied, no microphone, or no `mediaDevices` at all (plain http off localhost).
      toast.error(t("notes.micUnavailable"));
      return;
    }
    const mimeType = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      recordingRef.current = null;
      setRecording(null);
      const type = recorder.mimeType || mimeType || "audio/webm";
      const durationMs = Math.min(Math.max(Date.now() - startedAt, 1), NOTE_VOICE_MAX_MS);
      const file = new File(chunks, `voice-memo.${extensionOf(type)}`, { type });
      onChangeRef.current({ file, durationMs });
    };
    recorder.start();
    const next = { recorder, stream, startedAt };
    recordingRef.current = next;
    setElapsed(0);
    setRecording(next);
  }

  if (recording) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button className="btn-error min-h-12" onPress={() => recording.recorder.stop()}>
          {t("notes.stopRecording")}
        </Button>
        <span role="timer" className="font-mono tabular-nums">
          {t("notes.recording", {
            elapsed: clock(elapsed),
            max: clock(NOTE_VOICE_MAX_MS),
          })}
        </span>
      </div>
    );
  }
  if (value) return <RecordedMemo memo={value} onDiscard={() => onChange(null)} />;
  return (
    <Button className="btn-outline min-h-12" onPress={start}>
      {t("notes.recordVoice")}
    </Button>
  );
}

function RecordedMemo({ memo, onDiscard }: { memo: VoiceMemo; onDiscard: () => void }) {
  const t = useTranslations();
  const url = useMemo(() => URL.createObjectURL(memo.file), [memo.file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* biome-ignore lint/a11y/useMediaCaption: a voice memo the user just recorded */}
      <audio controls src={url} aria-label={t("notes.newVoice")} className="min-h-12" />
      <span className="font-mono tabular-nums">{clock(memo.durationMs)}</span>
      <Button className="btn-ghost min-h-12" onPress={onDiscard}>
        {t("notes.discardVoice")}
      </Button>
    </div>
  );
}

/** A note's memo, played inline; the route answers `Range`, so seeking works. */
export function VoicePlayer({ memo }: { memo: NoteAttachment }) {
  const t = useTranslations();
  const label = t("notes.voiceMemo", { duration: clock(memo.durationMs ?? 0) });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* biome-ignore lint/a11y/useMediaCaption: staff voice memos have no captions */}
      <audio controls preload="metadata" src={memo.url} aria-label={label} className="min-h-12" />
      <span className="font-mono text-sm tabular-nums opacity-70">
        {clock(memo.durationMs ?? 0)}
      </span>
    </div>
  );
}
