"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PriorityRule, PriorityRuleCondition } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Button, NumberField, Radio, RadioGroup, Switch, TextField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

type ConditionType = PriorityRuleCondition["type"];
type Level = 0 | 1 | 2;
const conditionTypes: ConditionType[] = ["lineItem", "shippingMethod", "orderAge"];
const levels: Level[] = [0, 1, 2];

/** Every condition type's inputs at once, so switching type in the dialog keeps what was typed. */
type FormState = {
  name: string;
  type: ConditionType;
  match: "sku" | "name";
  value: string;
  contains: string;
  minHours: number;
  priority: Level;
};

const emptyForm: FormState = {
  name: "",
  type: "lineItem",
  match: "sku",
  value: "",
  contains: "",
  minHours: Number.NaN,
  priority: 2,
};

function toForm(rule: PriorityRule): FormState {
  return { ...emptyForm, ...rule.condition, name: rule.name, priority: rule.priority as Level };
}

function toCondition(form: FormState): PriorityRuleCondition {
  switch (form.type) {
    case "lineItem":
      return { type: "lineItem", match: form.match, value: form.value };
    case "shippingMethod":
      return { type: "shippingMethod", contains: form.contains };
    case "orderAge":
      return { type: "orderAge", minHours: form.minHours };
  }
}

/** A priority change reorders every queue, so order queries refetch along with the rules. */
function useInvalidate() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.priorityRules.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.orders.key() }),
    ]);
}

/** The admin list of priority rules (FR-LIST-04): add, edit, enable, reorder and delete. */
export function RulesManager() {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const invalidate = useInvalidate();
  const rules = useQuery(orpc.priorityRules.list.queryOptions());

  const toggle = useMutation({
    mutationFn: (rule: PriorityRule) =>
      client.priorityRules.update({ id: rule.id, enabled: !rule.enabled }),
    onSuccess: (rule) =>
      toast.success(
        t(rule.enabled ? "priorityRules.enabledToast" : "priorityRules.disabledToast", {
          name: rule.name,
        }),
      ),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: invalidate,
  });

  // A list changed by another admin since it loaded is refused (conflict); the refetch shows it.
  const reorder = useMutation({
    mutationFn: (ids: string[]) => client.priorityRules.reorder({ ids }),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: invalidate,
  });
  const move = (index: number, by: -1 | 1) => {
    const ids = (rules.data ?? []).map((rule) => rule.id);
    const [id] = ids.splice(index, 1);
    if (id === undefined) return;
    ids.splice(index + by, 0, id);
    reorder.mutate(ids);
  };

  if (rules.isPending) return <p>{t("common.loading")}</p>;
  if (rules.error) {
    return (
      <p role="alert" className="text-error">
        {errorMessage(rules.error)}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <RuleDialog />
      </div>
      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
        <table className="table" aria-label={t("priorityRules.title")}>
          <thead>
            <tr>
              <th>{t("priorityRules.rule")}</th>
              <th>{t("priorityRules.level")}</th>
              <th>{t("priorityRules.enabled")}</th>
              <th>
                <span className="sr-only">{t("priorityRules.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rules.data.length === 0 && (
              <tr>
                <td colSpan={4}>{t("priorityRules.empty")}</td>
              </tr>
            )}
            {rules.data.map((rule, index) => (
              <tr key={rule.id} className={rule.enabled ? undefined : "text-base-content/50"}>
                {/* Condition under the name, so the row fits a tablet without scrolling sideways. */}
                <td className="break-words">
                  <p className="font-medium">{rule.name}</p>
                  <p className="text-sm text-base-content/70">
                    {t(`priorityRules.summary.${rule.condition.type}`, summaryParams(rule))}
                  </p>
                </td>
                <td>
                  <span className={`badge ${levelBadge[rule.priority as Level]}`}>
                    {t(`queue.priorityLevel.${rule.priority as Level}`)}
                  </span>
                </td>
                <td>
                  <Switch
                    isSelected={rule.enabled}
                    isDisabled={toggle.isPending}
                    onChange={() => toggle.mutate(rule)}
                  >
                    <span className="sr-only">
                      {t("priorityRules.enableRule", { name: rule.name })}
                    </span>
                  </Switch>
                </td>
                <td>
                  <div className="flex justify-end gap-1">
                    <Button
                      className="btn-ghost btn-square"
                      aria-label={t("priorityRules.moveUp", { name: rule.name })}
                      isDisabled={index === 0 || reorder.isPending}
                      onPress={() => move(index, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      className="btn-ghost btn-square"
                      aria-label={t("priorityRules.moveDown", { name: rule.name })}
                      isDisabled={index === rules.data.length - 1 || reorder.isPending}
                      onPress={() => move(index, 1)}
                    >
                      ↓
                    </Button>
                    <RuleDialog rule={rule} />
                    <DeleteDialog rule={rule} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const levelBadge: Record<Level, string> = {
  0: "badge-ghost",
  1: "badge-warning",
  2: "badge-error",
};

function summaryParams(rule: PriorityRule): Record<string, string | number> {
  const { condition } = rule;
  switch (condition.type) {
    case "lineItem":
      return { match: condition.match, value: condition.value };
    case "shippingMethod":
      return { contains: condition.contains };
    case "orderAge":
      return { hours: condition.minHours };
  }
}

/** Add (no `rule`) or edit a rule. New rules start enabled, at the end of the list. */
function RuleDialog({ rule }: { rule?: PriorityRule }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const invalidate = useInvalidate();
  const [form, setForm] = useState(() => (rule ? toForm(rule) : emptyForm));
  // One key per dialog opening: a retried submission can't create two rules.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const edit = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  const save = useMutation({
    mutationFn: (input: FormState) => {
      const fields = { name: input.name, condition: toCondition(input), priority: input.priority };
      return rule
        ? client.priorityRules.update({ id: rule.id, ...fields })
        : client.priorityRules.create({ idempotencyKey, ...fields });
    },
    onSuccess: (saved) =>
      toast.success(
        t(rule ? "priorityRules.updated" : "priorityRules.created", { name: saved.name }),
      ),
    onSettled: invalidate,
  });

  const title = rule ? t("priorityRules.editRule", { name: rule.name }) : t("priorityRules.add");

  return (
    <DialogTrigger
      onOpenChange={(open) => {
        if (!open) return;
        setForm(rule ? toForm(rule) : emptyForm);
        setIdempotencyKey(crypto.randomUUID());
        save.reset();
      }}
    >
      {rule ? (
        <Button
          className="btn-ghost btn-sm"
          aria-label={t("priorityRules.editRule", { name: rule.name })}
        >
          {t("priorityRules.edit")}
        </Button>
      ) : (
        <Button>{t("priorityRules.add")}</Button>
      )}
      <Dialog title={title}>
        {(close) => (
          <Form
            className="space-y-2"
            validationErrors={fieldErrors(save.error)}
            onSubmit={(event) => {
              event.preventDefault();
              save.mutateAsync(form).then(close, () => {});
            }}
          >
            <TextField
              label={t("priorityRules.name")}
              name="name"
              isRequired
              maxLength={80}
              value={form.name}
              onChange={(name) => edit({ name })}
              autoFocus
            />
            <RadioGroup
              label={t("priorityRules.type")}
              name="condition.type"
              value={form.type}
              onChange={(type) => edit({ type: type as ConditionType })}
            >
              {conditionTypes.map((type) => (
                <Radio key={type} value={type}>
                  {t(`priorityRules.types.${type}`)}
                </Radio>
              ))}
            </RadioGroup>
            {form.type === "lineItem" && (
              <div className="grid gap-x-4 sm:grid-cols-2">
                <RadioGroup
                  label={t("priorityRules.match")}
                  name="condition.match"
                  value={form.match}
                  onChange={(match) => edit({ match: match as FormState["match"] })}
                >
                  <Radio value="sku">{t("priorityRules.matchBy.sku")}</Radio>
                  <Radio value="name">{t("priorityRules.matchBy.name")}</Radio>
                </RadioGroup>
                <TextField
                  label={t(`priorityRules.matchBy.${form.match}`)}
                  name="condition.value"
                  isRequired
                  maxLength={200}
                  value={form.value}
                  onChange={(value) => edit({ value })}
                />
              </div>
            )}
            {form.type === "shippingMethod" && (
              <TextField
                label={t("priorityRules.contains")}
                description={t("priorityRules.containsHint")}
                name="condition.contains"
                isRequired
                maxLength={200}
                value={form.contains}
                onChange={(contains) => edit({ contains })}
              />
            )}
            {form.type === "orderAge" && (
              <NumberField
                label={t("priorityRules.minHours")}
                description={t("priorityRules.minHoursHint")}
                name="condition.minHours"
                isRequired
                minValue={1}
                maxValue={720}
                formatOptions={{ maximumFractionDigits: 0 }}
                value={form.minHours}
                onChange={(minHours) => edit({ minHours })}
              />
            )}
            <RadioGroup
              label={t("priorityRules.level")}
              name="priority"
              value={String(form.priority)}
              onChange={(priority) => edit({ priority: Number(priority) as Level })}
            >
              {levels.map((level) => (
                <Radio key={level} value={String(level)}>
                  {t(`queue.priorityLevel.${level}`)}
                </Radio>
              ))}
            </RadioGroup>
            {save.error && (
              <p role="alert" className="text-error">
                {errorMessage(save.error)}
              </p>
            )}
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" isPending={save.isPending}>
                {t("common.save")}
              </Button>
            </div>
          </Form>
        )}
      </Dialog>
    </DialogTrigger>
  );
}

function DeleteDialog({ rule }: { rule: PriorityRule }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const invalidate = useInvalidate();
  const remove = useMutation({
    mutationFn: () => client.priorityRules.delete({ id: rule.id }),
    onSuccess: () => toast.success(t("priorityRules.deleted", { name: rule.name })),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: invalidate,
  });

  return (
    <DialogTrigger>
      <Button
        className="btn-ghost btn-sm text-error"
        aria-label={t("priorityRules.deleteRule", { name: rule.name })}
      >
        {t("priorityRules.delete")}
      </Button>
      <Dialog title={t("priorityRules.deleteRule", { name: rule.name })}>
        {(close) => (
          <>
            <p>{t("priorityRules.deleteBody")}</p>
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("common.cancel")}
              </Button>
              <Button
                className="btn-error"
                isPending={remove.isPending}
                onPress={() => remove.mutateAsync().then(close, () => {})}
              >
                {t("priorityRules.delete")}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </DialogTrigger>
  );
}
