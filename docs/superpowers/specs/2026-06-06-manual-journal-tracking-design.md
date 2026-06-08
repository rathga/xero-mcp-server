# Problem statement: tracking categories/codes missing on manual journals

**Status:** research complete, not yet implemented. Hand-off doc for a dedicated coding session.
**Repo:** `XeroAPI/xero-mcp-server` (this is a fresh clone of `main`).
**Author of this note:** investigation done 2026-06-06 for Richard Davies (Nestegg Rentals), who uses this MCP server for Xero year-end reconciliation and hit the bug below.

---

## Symptom (real-world)

When reading and editing **manual journals** through this MCP server, Xero **tracking codes do not come through**. During year-end reconciliation, manual journals need to carry property tracking (Nestegg tracks every line by property code: ES, CG, LW, BH, …). The MCP server neither shows the tracking on a journal it reads back, nor lets you set tracking when creating/editing one.

## Root cause — confirmed in code

This is **not** a Xero API limitation and **not** a mistranslation. Tracking on manual journal lines is **simply not implemented** in this server, on either the write or the read path. The original author left explicit placeholders:

```
$ grep -rn "tracking can be added here" src/
src/handlers/create-xero-manual-journal.handler.ts:30:      // TODO: tracking can be added here
src/handlers/update-xero-manual-journal.handler.ts:31:      // TODO: tracking can be added here
src/tools/create/create-manual-journal.tool.ts:36:          // TODO: TODO: tracking can be added here
src/tools/update/update-manual-journal-tool.ts:34:          // TODO: TODO: tracking can be added here
```

The Xero SDK (`xero-node`) `ManualJournalLine` type **does** carry a `tracking` property, and the API returns it fine — the MCP layer discards it.

### Write path (can't set tracking)
- `src/tools/create/create-manual-journal.tool.ts` — the Zod line schema (`manualJournalLines[]`) has **no `tracking` field** (TODO at line 36).
- `src/tools/update/update-manual-journal-tool.ts` — same; no `tracking` in the line schema (TODO at line 34). *(Note the non-standard filename: `update-manual-journal-tool.ts`, hyphen not `.tool.ts`.)*
- `src/handlers/create-xero-manual-journal.handler.ts` — line ~24–30, `journalLines.map(...)` maps only `lineAmount, accountCode, description, taxType`; TODO at line 30 where tracking should be forwarded.
- `src/handlers/update-xero-manual-journal.handler.ts` — same mapping, TODO at line 31.

### Read path (can't see tracking — this is the main user-facing symptom)
- `src/tools/list/list-manual-journals.tool.ts` — the inline per-line serializer (~line 62 onward) prints `Line Amount / Account Code / Description / Tax Type / Tax Amount` and **never references `line.tracking`**. There is no separate `get-manual-journal` tool — single-journal read is `list-manual-journals` with the optional `manualJournalId` arg, so this one serializer covers all reads.
- The create/update tool success responses serialize lines the same inline way and also omit tracking.

Manual journals do **not** use the shared `src/helpers/format-line-item.ts` helper (that one is for invoice/bank-transaction `LineItem` shapes), so the fix has to add tracking to the manual-journal-specific serializers.

## Reference implementation already in the repo

Invoices already support tracking on write — copy this pattern. Note it is **duplicated** in two places, which is the argument for extracting a shared helper:

- `src/tools/create/create-invoice.tool.ts` — defines a local `trackingSchema`:
  ```ts
  const trackingSchema = z.object({
    name: z.string().describe("The name of the tracking category. Can be obtained from the list-tracking-categories tool"),
    option: z.string().describe("The name of the tracking option. Can be obtained from the list-tracking-categories tool"),
    trackingCategoryID: z.string().describe("The ID of the tracking category. Can be obtained from the list-tracking-categories tool"),
  });
  // ...used on the line item schema as:
  tracking: z.array(trackingSchema).describe("Up to 2 tracking categories and options...").optional(),
  ```
- `src/tools/update/update-invoice.tool.ts` — defines the **same** `trackingSchema` again (lines 7–11).

The create-invoice handler forwards `tracking` straight to `accountingApi.createInvoices()` with no stripping — so the SDK accepts `tracking` on lines as-is.

## Caveat / scope notes

- **Bank transactions also lack tracking** (`create-bank-transaction.tool.ts` has a minimal inline line schema, no `tracking`). Out of scope for this fix, but worth a follow-up issue — same root pattern.
- There's an **open PR #178** ("Format line item tracking values") that fixes invoice/bank-tx tracking displaying as `[object Object]` in `format-line-item.ts`. It **does not touch manual journals.** Avoid colliding with it: don't refactor `format-line-item.ts`; keep this change inside the manual-journal files (+ optional new shared schema helper). Its formatting approach (render tracking as `category/option` text, omit when absent, with a Vitest test) is a good template to mirror for the read serializer here.
- **No existing issue or PR addresses tracking on manual journals** (searched open + closed). This is genuinely missing functionality, not a duplicate. Worth filing an issue and opening a PR upstream rather than just patching locally.

## Proposed change (for the coding session to confirm/refine)

1. **Extract** the invoice `trackingSchema` (`{ name, option, trackingCategoryID }`) into a shared module (e.g. `src/helpers/tracking-schema.ts`) and import it into `create-invoice.tool.ts`, `update-invoice.tool.ts`, and the two manual-journal tools. *(Decision point: extract-and-share, vs. just inline a copy into the journal tools for a smaller diff. Extracting is tidier and removes the existing invoice duplication; inlining is lower-risk. Lean extract unless it balloons the diff.)*
2. **Add** `tracking: z.array(trackingSchema).max(2).optional()` to the line schema in `create-manual-journal.tool.ts` and `update-manual-journal-tool.ts`.
3. **Forward** `tracking: journalLine.tracking` in the `journalLines.map(...)` payloads of both handlers (replace the two `// TODO: tracking can be added here` lines).
4. **Serialize** tracking on read: add a `Tracking:` line to the per-line output in `list-manual-journals.tool.ts` and the create/update success responses, formatted as `category/option` text (mirror PR #178), reading `line.tracking` and omitting cleanly when absent. **Do not** print the raw array (that's the `[object Object]` bug PR #178 fixes).
5. **Test:** add a Vitest test mirroring PR #178's pattern (tests live under `src/helpers/__tests__/`; framework is Vitest via `vitest.config.ts`).

## Build / test / contribute

- No `CONTRIBUTING.md`; informal fork → branch → PR. `package.json` scripts: `build`, `watch`, `test` / `test:watch` (Vitest), `lint` / `lint:fix` (ESLint).
- Run `npm run lint` and `npm test` before raising the PR.
- `.env.example` documents the credentials needed to run the server locally against a real Xero tenant for manual end-to-end verification (create a journal with tracking → read it back → confirm the code appears).

## Acceptance criteria

- [ ] `create-manual-journal` accepts `tracking` (≤2) per line and the codes land on the journal in Xero.
- [ ] `update-manual-journal` accepts and applies `tracking` per line.
- [ ] `list-manual-journals` (incl. single-journal read via `manualJournalId`) shows each line's tracking as readable `category/option` text.
- [ ] No regression to invoice tracking / no collision with PR #178.
- [ ] Lint + tests pass; new test covers manual-journal tracking serialization.

### Key files at a glance
| File | Gap |
|------|-----|
| `src/handlers/create-xero-manual-journal.handler.ts:30` | write: tracking not forwarded |
| `src/handlers/update-xero-manual-journal.handler.ts:31` | write: tracking not forwarded |
| `src/tools/create/create-manual-journal.tool.ts:36` | schema: no `tracking` field; response omits it |
| `src/tools/update/update-manual-journal-tool.ts:34` | schema: no `tracking` field |
| `src/tools/list/list-manual-journals.tool.ts` (~l.62) | read: serializer omits tracking |
| `src/tools/create/create-invoice.tool.ts` | reference `trackingSchema` to reuse |
| `src/tools/update/update-invoice.tool.ts:7` | duplicate `trackingSchema` (extract target) |
