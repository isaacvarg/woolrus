"use client";

import { useQuery } from "@tanstack/react-query";
import type { ApprovalCredential, ApprovalInput, UnlockTile } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { NameTiles } from "@/components/name-tiles";
import { PIN_LENGTH, PinPad } from "@/components/pin-pad";
import { Button } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { createScanBurst } from "@/lib/scanner";

const REASON_MAX = 200;

export type ApprovalDialogProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: string;
  /** What is being approved, as the caller describes it (e.g. the tripped checks). */
  items: readonly ReactNode[];
  /** Who may approve, by their roles; loads the approver tiles. */
  permission: string;
  /**
   * Sends the action with `approval` in its input. Resolve to close the dialog; reject with the
   * action's error to show it in place (bad PIN, locked, not permitted, self).
   */
  onApprove: (approval: ApprovalInput) => Promise<unknown>;
};

/**
 * A second person's say-so, given in person (SPEC-identity A2, "UI"). Any screen opens it for an
 * action that needs approval: the approver taps their tile and enters their PIN, or scans their
 * badge, and a reason is always required. The credential goes with the action in one call
 * (decision 16), so nothing is approved until the action succeeds.
 */
export function ApprovalDialog({ isOpen, onOpenChange, ...props }: ApprovalDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4"
    >
      <Modal className="max-h-full w-full max-w-3xl overflow-y-auto rounded-box bg-base-100 p-6 shadow-xl">
        <AriaDialog className="outline-none">
          {({ close }) => <ApprovalForm {...props} close={close} />}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

function ApprovalForm({
  title,
  items,
  permission,
  onApprove,
  close,
}: Omit<ApprovalDialogProps, "isOpen" | "onOpenChange"> & { close: () => void }) {
  const t = useTranslations("approval");
  const ts = useTranslations("station");
  const tk = useTranslations();
  const errorMessage = useErrorMessage();
  const approvers = useQuery(orpc.approvers.list.queryOptions({ input: { permission } }));
  const [chosen, setChosen] = useState<UnlockTile | null>(null);
  const [pin, setPin] = useState("");
  const [badge, setBadge] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A PIN or badge given before the reason waits here until the reason is in.
  const [held, setHeld] = useState<ApprovalCredential | null>(null);
  const [pending, setPending] = useState(false);
  // A scanner types into whatever has focus, the reason field included: a burst there is a badge,
  // taken out of the reason so the code is never saved as text.
  const [reasonScan] = useState(createScanBurst);
  const badgeInput = useRef<HTMLInputElement>(null);
  const pinInput = useRef<HTMLInputElement>(null);
  const reasonInput = useRef<HTMLInputElement>(null);

  // A HID scanner types into whatever has focus, so the badge input has it until a name is chosen.
  useEffect(() => {
    (chosen ? pinInput : badgeInput).current?.focus();
  }, [chosen]);

  const choose = (tile: UnlockTile | null) => {
    setChosen(tile);
    setPin("");
    setHeld(null);
    setError(null);
  };

  const submit = async (credential: ApprovalCredential, reasonText = reason) => {
    const trimmed = reasonText.trim();
    if (trimmed.length < 1 || trimmed.length > REASON_MAX) {
      setHeld(credential);
      setError(tk("errors.approval.reasonRequired"));
      reasonInput.current?.focus();
      return;
    }
    setHeld(null);
    setPending(true);
    setError(null);
    try {
      await onApprove({ credential, reason: trimmed });
      close();
    } catch (err) {
      // The reason stays; the PIN goes, as on the lock screen.
      setError(errorMessage(err));
      setPin("");
      setPending(false);
      (chosen ? pinInput : badgeInput).current?.focus();
    }
  };

  const enterPin = (digits: string) => {
    setPin(digits);
    setError(null);
    if (chosen && digits.length === PIN_LENGTH) void submit({ userId: chosen.id, pin: digits });
  };

  const tiles = approvers.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Heading slot="title" className="text-2xl font-bold">
        {title}
      </Heading>
      <ul className="list-disc space-y-1 ps-6 text-lg">
        {items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the caller's list is fixed while open.
          <li key={i}>{item}</li>
        ))}
      </ul>

      {/* One line, so Enter approves a PIN or badge that is waiting for the reason. */}
      <form
        className="fieldset"
        onSubmit={(e) => {
          e.preventDefault();
          if (held) void submit(held);
        }}
      >
        <label htmlFor="approval-reason" className="fieldset-legend text-base">
          {t("reason")}
        </label>
        <input
          ref={reasonInput}
          id="approval-reason"
          autoComplete="off"
          value={reason}
          maxLength={REASON_MAX}
          disabled={pending}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            const code = reasonScan.handle({ key: e.key, time: e.timeStamp });
            if (code === null) return;
            e.preventDefault(); // The scanner's Enter mustn't also submit the reason form.
            const value = e.currentTarget.value;
            const at = value.lastIndexOf(code);
            const rest = at < 0 ? value : value.slice(0, at) + value.slice(at + code.length);
            setReason(rest);
            void submit({ badgeCode: code }, rest);
          }}
          className="input input-lg w-full"
        />
        <p className="label whitespace-normal">{t("reasonHelp")}</p>
      </form>

      <p aria-live="polite" role="alert" className="min-h-7 text-lg font-semibold text-error">
        {error}
      </p>

      {chosen ? (
        <section className="flex flex-col items-center gap-4">
          <PinPad
            id="approval-pin"
            label={ts("enterPin", { name: chosen.name })}
            value={pin}
            onChange={enterPin}
            isDisabled={pending}
            inputRef={pinInput}
          />
          <div className="flex gap-3">
            <Button className="btn-ghost btn-lg" isDisabled={pending} onPress={() => choose(null)}>
              {ts("cancel")}
            </Button>
            {/* A full PIN submits by itself; this is for after fixing the reason. */}
            <Button
              className="btn-primary btn-lg"
              isDisabled={pending || pin.length !== PIN_LENGTH}
              onPress={() => void submit({ userId: chosen.id, pin })}
            >
              {t("approve")}
            </Button>
          </div>
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <h3 className="text-xl font-semibold">{t("approvers")}</h3>
            {approvers.isSuccess && tiles.length === 0 ? (
              <p>{t("noApprovers")}</p>
            ) : (
              <NameTiles tiles={tiles} onChoose={choose} className="grid-cols-2 sm:grid-cols-3" />
            )}
          </section>
          {held && "badgeCode" in held && <p className="text-lg">{t("badgeHeld")}</p>}
          <form
            className="flex flex-col items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const code = badge.trim();
              setBadge("");
              if (code) void submit({ badgeCode: code });
            }}
          >
            <label htmlFor="approval-badge" className="text-sm opacity-70">
              {ts("badge")}
            </label>
            {/* Takes focus back when nothing else needs it, so a scan always lands here. */}
            <input
              ref={badgeInput}
              id="approval-badge"
              type="password"
              autoComplete="off"
              value={badge}
              disabled={pending}
              onChange={(e) => setBadge(e.target.value)}
              onBlur={(e) => {
                const input = e.currentTarget;
                if (!e.relatedTarget) setTimeout(() => input.focus(), 0);
              }}
              className="input input-sm w-64 text-center"
            />
          </form>
        </>
      )}

      <div className="flex justify-end gap-3">
        <Button className="btn-ghost btn-lg" isDisabled={pending} onPress={close}>
          {t("cancel")}
        </Button>
        {held && "badgeCode" in held && (
          <Button
            className="btn-primary btn-lg"
            isDisabled={pending}
            onPress={() => void submit(held)}
          >
            {t("approve")}
          </Button>
        )}
      </div>
    </div>
  );
}
