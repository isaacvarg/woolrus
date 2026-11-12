import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateLabelPrintInput } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { randomUUID } from "@/lib/uuid";

/**
 * Records a print, then opens its PDF in a new tab. The tab is opened on the tap itself (browsers
 * block pop-ups opened after an await) and pointed at the PDF once the print exists.
 */
export function useLabelPrint({ onPrinted }: { onPrinted?: () => void } = {}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<CreateLabelPrintInput, "idempotencyKey">) => {
      const tab = window.open("", "_blank");
      try {
        const { printId } = await client.shipping.createLabelPrint({
          ...input,
          idempotencyKey: randomUUID(),
        } as CreateLabelPrintInput);
        if (tab) tab.location.href = `/api/label-prints/${printId}.pdf`;
        else toast.error(t("print.popupBlocked"));
        return printId;
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
    onSuccess: () => onPrinted?.(),
    onError: (error) => toast.error(errorMessage(error)),
    // Counts and "Printed N×" changed; orders themselves did not.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: orpc.orders.key() });
      queryClient.invalidateQueries({ queryKey: orpc.shipping.key() });
    },
  });
}
