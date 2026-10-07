/**
 * The price table (D167, D206; screens §5 AI settings and Admin → AI). Versioned: saving a price
 * adds a version and never rewrites a call already costed; "Stop pricing" means "no price from
 * now" (calls then have cost unknown). Rates are per million tokens: input, output, reasoning
 * (defaults to output) and cached input (defaults to input), plus a per-image rate for providers
 * that bill images apart. Nothing is seeded (Q8); the recommended model is priced from Groq's
 * listing when an instance admin connects it, and NoPriceNotice offers it in one tap.
 *
 * `mode="read"` for owners (AI settings, Advanced); `mode="edit"` for instance admins, with the
 * history, "Fill from <provider>'s listing" (proposed rows with the listing's date, saved only
 * when the admin saves them) and "Cost this month's unpriced calls".
 */
import { PROVIDER_KINDS, type ProviderKind, RECOMMENDED_PRICE } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { captureApi, captureKeys, useAiPrices } from '@/api/capture/queries';
import type { AiPrice, AiProvider, PutAiPriceBody } from '@/api/capture/types';
import { useMe } from '@/api/queries';
import { OverflowActions } from '@/components/inbox/overflow-actions';
import { ErrorState, List, LoadingRows, Notice, Pill, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { CurrencyPicker } from '@/components/things/pickers';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { useConfirm } from '@/components/ui/confirm';
import { DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useMoney, useProviderName } from './labels';

type Draft = PutAiPriceBody;

const decimal = (s: string | undefined) => !!s && /^\d+(\.\d+)?$/.test(s.trim());

function PriceSheet({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const online = useOnline();
  const providerName = useProviderName();
  const fmt = useFormat();
  const [d, setD] = useState<Draft>(draft);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const save = useMutation({
    mutationFn: () => {
      const body = d;
      const clean: PutAiPriceBody = {
        providerKind: body.providerKind,
        model: body.model.trim(),
        inputPerMtok: body.inputPerMtok.trim(),
        outputPerMtok: body.outputPerMtok.trim(),
        currency: body.currency,
        ...(decimal(body.reasoningPerMtok)
          ? { reasoningPerMtok: body.reasoningPerMtok?.trim() }
          : {}),
        ...(decimal(body.cachedInputPerMtok)
          ? { cachedInputPerMtok: body.cachedInputPerMtok?.trim() }
          : {}),
        ...(decimal(body.perImage) ? { perImage: body.perImage?.trim() } : {}),
        // A price from the provider's listing says when it was listed (T9: source provider_listing).
        ...(d.listingFetchedAt ? { listingFetchedAt: d.listingFetchedAt } : {}),
      };
      return captureApi.addAiPrice(clean);
    },
    onSuccess: async (p) => {
      await qc.invalidateQueries({ queryKey: captureKeys.ai.all });
      toast({ tone: 'ok', title: t`Price saved as version ${fmt.num(p.version)}` });
      onClose();
    },
    onError: (e) => toast({ tone: 'danger', title: errorText(e) }),
  });
  const valid =
    d.model.trim() !== '' && decimal(d.inputPerMtok) && decimal(d.outputPerMtok) && !!d.currency;
  const optional = (v: string | undefined) => !v || decimal(v);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {d.listingFetchedAt ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>
            From the provider's listing of {fmt.dateTime(d.listingFetchedAt)}. Check it, then save.
          </Trans>
        </p>
      ) : null}
      <Combobox
        label={<Trans>Provider</Trans>}
        items={PROVIDER_KINDS.map((k) => ({
          id: k,
          label: k === 'openai_compatible' ? t`OpenAI-compatible` : providerName(k),
        }))}
        selectedKey={d.providerKind}
        onSelectionChange={(k) =>
          k ? set({ providerKind: String(k) as ProviderKind }) : undefined
        }
      />
      <TextField
        label={<Trans context="ai model">Model</Trans>}
        value={d.model}
        onChange={(model) => set({ model })}
        inputProps={{ dir: 'ltr', spellCheck: false, autoCapitalize: 'none' }}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={<Trans>Input, per million tokens</Trans>}
          value={d.inputPerMtok}
          onChange={(inputPerMtok) => set({ inputPerMtok })}
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
        />
        <TextField
          label={<Trans>Output, per million tokens</Trans>}
          value={d.outputPerMtok}
          onChange={(outputPerMtok) => set({ outputPerMtok })}
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
        />
        <TextField
          label={<Trans>Reasoning, per million (optional)</Trans>}
          value={d.reasoningPerMtok ?? ''}
          onChange={(reasoningPerMtok) => set({ reasoningPerMtok })}
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
          description={<Trans>Empty: the output rate.</Trans>}
          isInvalid={!optional(d.reasoningPerMtok)}
        />
        <TextField
          label={<Trans>Cached input, per million (optional)</Trans>}
          value={d.cachedInputPerMtok ?? ''}
          onChange={(cachedInputPerMtok) => set({ cachedInputPerMtok })}
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
          description={<Trans>Empty: the input rate.</Trans>}
          isInvalid={!optional(d.cachedInputPerMtok)}
        />
        <TextField
          label={<Trans>Per image (optional)</Trans>}
          value={d.perImage ?? ''}
          onChange={(perImage) => set({ perImage })}
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
          description={<Trans>Only where the provider bills images apart from tokens.</Trans>}
          isInvalid={!optional(d.perImage)}
        />
        <CurrencyPicker
          label={<Trans>Currency</Trans>}
          value={d.currency}
          onChange={(currency) => set({ currency: currency ?? '' })}
        />
      </div>
      <p className="m-0 text-small text-ink-2">
        <Trans>Saving adds a new version from now. Calls already costed keep their price.</Trans>
      </p>
      <DialogFooter>
        <Button variant="ghost" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          type="submit"
          isDisabled={
            !online ||
            !valid ||
            !optional(d.reasoningPerMtok) ||
            !optional(d.cachedInputPerMtok) ||
            !optional(d.perImage)
          }
          isPending={save.isPending}
        >
          <Trans>Save price</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

function PriceRow({ price, edit }: { price: AiPrice; edit: boolean }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const money = useMoney();
  const providerName = useProviderName();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const [changing, setChanging] = useState(false);
  const r = price.rates;
  const stop = useMutation({
    mutationFn: () => captureApi.deleteAiPrice(price.providerKind, price.model),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: captureKeys.ai.all });
      toast({ tone: 'ok', title: t`No price from now` });
    },
    onError: (e) => toast({ tone: 'danger', title: errorText(e) }),
  });
  const recost = useMutation({
    mutationFn: () => {
      const d = new Date();
      const since = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
      return captureApi.recostAi({ providerKind: price.providerKind, model: price.model, since });
    },
    onSuccess: async (out) => {
      await qc.invalidateQueries({ queryKey: captureKeys.ai.all });
      toast({
        tone: 'ok',
        title: t`Costed ${fmt.num(out.recosted)} calls with this price`,
      });
    },
    onError: (e) => toast({ tone: 'danger', title: errorText(e) }),
  });
  const current = price.supersededAt === null;
  return (
    <li className="grid gap-1.5 px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold text-[15px] text-ink">
          {providerName(price.providerKind)}
          {sep()}
          <bdi dir="ltr" className="model-id font-mono text-[13px]">
            {price.model}
          </bdi>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Pill>
            <Trans>Version {fmt.num(price.version)}</Trans>
          </Pill>
          {current ? null : (
            <Pill>
              <Trans>Replaced</Trans>
            </Pill>
          )}
          {price.source === 'provider_listing' ? (
            <Pill tone="info">
              <Trans>From the listing</Trans>
            </Pill>
          ) : null}
        </span>
      </div>
      <span className="text-small text-ink-2 tabular-nums">
        <Trans>
          Input {money(r.inputPerMtok, price.currency)} · output{' '}
          {money(r.outputPerMtok, price.currency)} per million tokens
        </Trans>
        {r.reasoningPerMtok ? (
          <>
            {sep()}
            <Trans>reasoning {money(r.reasoningPerMtok, price.currency)}</Trans>
          </>
        ) : null}
        {r.cachedInputPerMtok ? (
          <>
            {sep()}
            <Trans>cached {money(r.cachedInputPerMtok, price.currency)}</Trans>
          </>
        ) : null}
        {r.perImage ? (
          <>
            {sep()}
            <Trans>{money(r.perImage, price.currency)} an image</Trans>
          </>
        ) : null}
      </span>
      <span className="text-small text-ink-3">
        {current ? (
          <Trans>Since {fmt.dateTime(price.effectiveFrom)}</Trans>
        ) : (
          <Trans>
            {fmt.dateTime(price.effectiveFrom)} to {fmt.dateTime(price.supersededAt ?? '')}
          </Trans>
        )}
      </span>
      {edit && current ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="small" variant="secondary" onPress={() => setChanging(true)}>
            <Trans>New version</Trans>
          </Button>
          {/* On a phone the other two fold into More: "Stop pricing" wrapped alone onto a row of
              its own under the long "Cost this month's unpriced calls" (the phone pass). */}
          <OverflowActions
            title={price.model}
            isDisabled={recost.isPending || stop.isPending}
            actions={[
              {
                id: 'recost',
                label: t`Cost this month's unpriced calls`,
                onAction: () => recost.mutate(),
              },
              {
                id: 'stop',
                label: t`Stop pricing`,
                onAction: async () => {
                  const ok = await confirm({
                    title: t`Stop pricing ${price.model}?`,
                    body: t`Calls from now have cost unknown until a new price is saved. Past calls keep theirs.`,
                    confirmLabel: t`Stop pricing`,
                  });
                  if (ok) stop.mutate();
                },
              },
            ]}
          />
        </div>
      ) : null}
      <Sheet isOpen={changing} onOpenChange={setChanging} title={t`New price version`} wide>
        {({ close }) => (
          <PriceSheet
            onClose={close}
            draft={{
              providerKind: price.providerKind,
              model: price.model,
              inputPerMtok: r.inputPerMtok,
              outputPerMtok: r.outputPerMtok,
              currency: price.currency,
              ...(r.reasoningPerMtok ? { reasoningPerMtok: r.reasoningPerMtok } : {}),
              ...(r.cachedInputPerMtok ? { cachedInputPerMtok: r.cachedInputPerMtok } : {}),
              ...(r.perImage ? { perImage: r.perImage } : {}),
            }}
          />
        )}
      </Sheet>
    </li>
  );
}

export function Prices({
  mode,
  provider,
}: {
  mode: 'read' | 'edit';
  /** The instance provider, for "Fill from <provider>'s listing" (edit mode). */
  provider?: AiProvider | null;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const providerName = useProviderName();
  const [history, setHistory] = useState(false);
  const [adding, setAdding] = useState<Draft | null>(null);
  const [proposed, setProposed] = useState<Draft[] | null>(null);
  const q = useAiPrices(history);
  const prefill = useMutation({
    mutationFn: (id: string) => captureApi.prefillAiPrices(id),
    onSuccess: (out) => setProposed(out.prices),
    onError: (e) => toast({ tone: 'danger', title: errorText(e) }),
  });
  const edit = mode === 'edit';
  const blank: Draft = {
    providerKind: provider?.kind ?? 'groq',
    model: '',
    inputPerMtok: '',
    outputPerMtok: '',
    currency: 'USD',
  };
  return (
    <div className="grid gap-3">
      {edit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="small" onPress={() => setAdding(blank)}>
            <Trans>Add a price</Trans>
          </Button>
          {provider && (provider.kind === 'groq' || provider.kind === 'openrouter') ? (
            <Button
              size="small"
              variant="secondary"
              isPending={prefill.isPending}
              onPress={() => prefill.mutate(provider.id)}
            >
              <Trans>Fill from {providerName(provider.kind)}'s listing</Trans>
            </Button>
          ) : null}
          <Switch isSelected={history} onChange={setHistory}>
            <Trans>Show earlier versions</Trans>
          </Switch>
        </div>
      ) : null}
      {proposed ? (
        <div className="grid gap-2 rounded-[10px] border border-info p-3">
          <p className="m-0 font-semibold text-[14px]">
            {proposed.length ? (
              <Plural
                value={proposed.length}
                one="# price proposed from the listing. Nothing is saved until you save it."
                other="# prices proposed from the listing. Nothing is saved until you save them."
              />
            ) : (
              <Trans>The listing has no prices Kept can use.</Trans>
            )}
          </p>
          {proposed.map((p) => (
            <div key={p.model} className="flex flex-wrap items-center justify-between gap-2">
              <bdi dir="ltr" className="model-id font-mono text-[13px]">
                {p.model}
              </bdi>
              <Button size="small" variant="secondary" onPress={() => setAdding(p)}>
                <Trans>Review and save</Trans>
              </Button>
            </div>
          ))}
          <Button
            size="small"
            variant="ghost"
            onPress={() => setProposed(null)}
            className="justify-self-start"
          >
            <Trans>Dismiss</Trans>
          </Button>
        </div>
      ) : null}
      {q.isPending ? (
        <LoadingRows rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.prices.length === 0 ? (
        <p className="m-0 text-small text-ink-2">
          {edit ? (
            <Trans>
              No prices yet. Without one, calls are counted in tokens and their cost is unknown.
            </Trans>
          ) : (
            <Trans>No prices yet: an instance admin adds them. Until then, cost is unknown.</Trans>
          )}
        </p>
      ) : (
        <List aria-label={t`Prices`}>
          {[...q.data.prices]
            .sort((a, b) => a.model.localeCompare(b.model) || b.version - a.version)
            .map((p) => (
              <PriceRow key={`${p.providerKind}:${p.model}:${p.version}`} price={p} edit={edit} />
            ))}
        </List>
      )}
      <Sheet
        isOpen={adding !== null}
        onOpenChange={(open) => (open ? undefined : setAdding(null))}
        title={t`Add a price`}
        wide
      >
        {({ close }) =>
          adding ? (
            <PriceSheet
              draft={adding}
              onClose={() => {
                close();
                setAdding(null);
              }}
            />
          ) : null
        }
      </Sheet>
    </div>
  );
}

/**
 * No price for the model photos are read with: every call says "cost unknown" (the maintainer's
 * iPhone, 2026-09-29, before the recommended model was priced on a key's save). Prominent, above
 * the rest of AI settings. An instance admin gets one tap for the recommended model: the price
 * from Groq's current listing when it has one, else Groq's as recorded on 2026-09-26
 * (RECOMMENDED_PRICE), then this month's unpriced calls are costed. Any other model: the price
 * table. Everyone else: who can set it.
 */
export function NoPriceNotice({ provider }: { provider: AiProvider | null }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const me = useMe();
  const errorText = useErrorText();
  const fmt = useFormat();
  const q = useAiPrices();
  const model = provider?.models.vision;
  const rec = RECOMMENDED_PRICE;
  const use = useMutation({
    mutationFn: async () => {
      let row: PutAiPriceBody | undefined;
      if (provider)
        try {
          const listed = await captureApi.prefillAiPrices(provider.id);
          row = listed.prices.find((p) => p.model === rec.model && p.currency === 'USD');
        } catch {
          // No listing to read: Groq's recorded price below.
        }
      row ??= {
        providerKind: rec.kind,
        model: rec.model,
        inputPerMtok: rec.inputPerMtok,
        outputPerMtok: rec.outputPerMtok,
        cachedInputPerMtok: rec.cachedInputPerMtok,
        currency: rec.currency,
        listingFetchedAt: rec.listingFetchedAt,
      };
      await captureApi.addAiPrice(row);
      return captureApi.recostAi({
        providerKind: rec.kind,
        model: rec.model,
        since: rec.listingFetchedAt,
      });
    },
    onSuccess: async (out) => {
      await qc.invalidateQueries({ queryKey: captureKeys.ai.all });
      toast({
        tone: 'ok',
        title: t`Price saved`,
        ...(out.recosted
          ? { description: plural(out.recosted, { one: '# call costed', other: '# calls costed' }) }
          : {}),
      });
    },
    onError: (e) => toast({ tone: 'danger', title: errorText(e) }),
  });
  if (!provider || !model || !q.data) return null;
  const priced = q.data.prices.some(
    (p) => p.providerKind === provider.kind && p.model === model && !p.supersededAt,
  );
  if (priced) return null;
  const admin = me.data?.user.instanceAdmin === true;
  const recommended = provider.kind === rec.kind && model === rec.model;
  const input = fmt.num(Number(rec.inputPerMtok));
  const output = fmt.num(Number(rec.outputPerMtok));
  const listed = fmt.day(rec.listingFetchedAt);
  return (
    <Notice
      tone="warn"
      title={<Trans>No price for this model, so every call says cost unknown</Trans>}
      action={
        admin && recommended ? (
          <Button size="small" isPending={use.isPending} onPress={() => use.mutate()}>
            <Trans>Use Groq's listed price</Trans>
          </Button>
        ) : admin ? (
          <Link
            to="/admin/ai"
            className="font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
          >
            <Trans>Set a price in Admin → AI</Trans>
          </Link>
        ) : null
      }
    >
      <span className="[text-wrap:pretty]">
        <bdi dir="ltr" className="model-id font-mono text-[12.5px]">
          {model}
        </bdi>{' '}
        {admin && recommended ? (
          <Trans>
            Groq listed it at USD {input} per million input tokens and {output} per million output
            tokens on {listed}. You can change it in the price table.
          </Trans>
        ) : admin ? (
          <Trans>Tokens are counted; the cost shows once the model has a price.</Trans>
        ) : (
          <Trans>Tokens are counted; the cost shows once an instance admin sets a price.</Trans>
        )}
      </span>
    </Notice>
  );
}
