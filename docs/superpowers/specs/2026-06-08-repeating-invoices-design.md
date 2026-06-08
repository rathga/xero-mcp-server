# Phase 4 — Repeating invoices

**Date:** 2026-06-08
**Feature:** Surface Xero repeating-invoice templates — list, get, create, and delete — so
recurring sales/purchase invoices (rent, standing charges, recurring supplier bills) can be
managed from the MCP.
**Roadmap:** see `2026-06-07-xero-mcp-coverage-roadmap.md` (feature #4, the last queued phase).

> **CORRECTION (2026-06-08, after live testing — supersedes the "update" design below).**
> The original design proposed an `update-repeating-invoice` (full-replace) tool. Live testing
> proved this is **impossible**: Xero's repeating-invoice API has **no edit operation**. A POST to
> `/RepeatingInvoices` with an existing `RepeatingInvoiceID` is only valid with `status=DELETED`;
> anything else returns `400 ValidationException: "Repeating invoice status must be set to DELETED"`.
> So `updateOrCreateRepeatingInvoices` is, in practice, **create-or-delete**. The 4th tool shipped
> as **`delete-repeating-invoice`** (POST id + `status=DELETED`; a minimal `{id, status}` body
> works) instead of `update`. Editing a template = delete + recreate, left to higher-level tooling
> per the thin-wrapper rule. Shipped tool set: **list / get / create / delete**. Where the text
> below says "update", read "delete".

## Goal

Let the agent manage Xero **repeating invoices** — the templates Xero uses to auto-generate
invoices on a schedule. A template carries an invoice body (contact, line items, reference) plus
a **`Schedule`** (how often, when it starts/ends, payment terms) and **auto-send flags** (whether
Xero emails the generated invoice). The server stays a thin wrapper: each tool maps 1:1 to a
`xero-node` SDK call and returns the raw result. The tools should look **very similar to the
existing invoice tools** (`create-invoice` / `update-invoice` / `list-invoices`), differing only
in the repeating-specific data (the schedule and template/auto-send options).

## What the Xero API supports

SDK methods (all on `accountingApi`):

- `getRepeatingInvoices(tenantId, where?, order?, options?)` — list (no paging, no curated filters)
- `getRepeatingInvoice(tenantId, repeatingInvoiceID, options?)` — single, **full** template incl.
  line items
- `createRepeatingInvoices(tenantId, repeatingInvoices: RepeatingInvoices, summarizeErrors?, idempotencyKey?, options?)`
  — takes the **plural** `RepeatingInvoices` wrapper (`{ repeatingInvoices: [...] }`)
- `updateOrCreateRepeatingInvoices(tenantId, repeatingInvoices: RepeatingInvoices, summarizeErrors?, idempotencyKey?, options?)`
  — a **POST-with-ID**: set `repeatingInvoiceID` in the body. **In practice this is delete-only** —
  see the CORRECTION banner above. The only valid POST-with-ID is `status="DELETED"`; Xero rejects
  edits with `400 ValidationException`. There is no `deleteRepeatingInvoice` method, so this call
  *is* the delete path.

`RepeatingInvoice` model fields used:

- `type` — `ACCREC` (sales, default) / `ACCPAY` (purchase/bill)
- `contact` — `{ contactID }`
- `schedule` — a `Schedule` object (see below)
- `lineItems` — same `LineItem` shape as invoices
- `reference`, `brandingThemeID`, `currencyCode`, `lineAmountTypes`
- `status` — `DRAFT` (default) / `AUTHORISED` / `DELETED`
- `repeatingInvoiceID` — set in the body to target an update
- auto-send flags: `approvedForSending`, `sendCopy`, `markAsSent`, `includePDF` (booleans)

`Schedule` model fields:

- `period` (int — e.g. `1` = every 1, `2` = every 2) + `unit` (`WEEKLY` / `MONTHLY`)
- `startDate` (YYYY-MM-DD — first generation date)
- `dueDate` (int) + `dueDateType` (`DAYSAFTERBILLDATE` / `DAYSAFTERBILLMONTH` /
  `DAYSAFTERINVOICEDATE` / `DAYSAFTERINVOICEMONTH` / `OFCURRENTMONTH` / `OFFOLLOWINGMONTH`) —
  the payment terms
- `endDate` (YYYY-MM-DD, optional)
- `nextScheduledDate` (read-only — the next date Xero will generate)

## Scope — four thin-wrapper tools

Two getRepeating methods are **distinct SDK calls**, so unlike Phase 3 (where a single optional
ID folded into the list call 1:1) the faithful thin-wrapper mapping here is **separate `list` and
`get` tools** — one tool per SDK method. The `get-` prefix already exists in the repo
(`get-invoice-as-pdf`, `get-invoice-online-url`, `get-payroll-timesheet`), so `get-repeating-invoice`
sits naturally alongside `list-repeating-invoices` with no naming collision.

| Tool | Dir | SDK call | Role |
|------|-----|----------|------|
| `list-repeating-invoices` | `list/` | `getRepeatingInvoices` | find templates; raw `where`/`order` filters |
| `get-repeating-invoice` | `get/` | `getRepeatingInvoice` | full template incl. line items (read before an update) |
| `create-repeating-invoice` | `create/` | `createRepeatingInvoices` | new template |
| `delete-repeating-invoice` | `delete/` | `updateOrCreateRepeatingInvoices` (POST id + `status=DELETED`) | delete a template (no edit exists — see CORRECTION) |

The repo already has `create/`, `get/`, `list/`, `update/` tool categories, each with its own
`index.ts` aggregated by `tool-factory.ts`. No factory restructuring needed.

## Shared input shapes

### Line item schema — identical to the invoice tools

Reuse the **exact** `lineItemSchema` from `create-invoice.tool.ts` / `update-invoice.tool.ts`,
defined inline in each repeating-invoice tool (the repo defines it per-tool rather than sharing it):

```
description, quantity, unitAmount, accountCode, taxType, itemCode?, tracking?  // tracking via trackingSchema
```

The handler-side `RepeatingInvoiceLineItem` interface mirrors the invoice handlers'
`InvoiceLineItem` (same fields + `tracking?: LineItemTracking[]`).

### Schedule schema (create + update)

A nested `schedule` object:

- Required: `period` (number), `unit` (`WEEKLY` | `MONTHLY`), `startDate` (YYYY-MM-DD)
- Optional: `dueDate` (number), `dueDateType` (the 6-value enum above), `endDate` (YYYY-MM-DD)

The handler maps these to `Schedule.UnitEnum` / `Schedule.DueDateTypeEnum` via the SDK enums (same
`Enum[value as keyof typeof Enum]` pattern used in `update-xero-linked-transaction.handler.ts`).

## Tool details

### `list-repeating-invoices`
Params: `where?`, `order?` — both optional, passed straight through to `getRepeatingInvoices`. No
paging param exists on this endpoint. Return the raw `RepeatingInvoice[]` (serialize id, type,
contact name, schedule summary incl. `nextScheduledDate`, status, total).

### `get-repeating-invoice`
Param: `repeatingInvoiceId` (required). Calls `getRepeatingInvoice`, returns the single raw
template including line items — the canonical read before a full-replace update.

### `create-repeating-invoice`
Mirrors `create-invoice` plus the repeating-specific fields.

- Required: `contactId`, `schedule`, `lineItems`
- Optional: `type` (`ACCREC` default), `status` (`DRAFT` default), `reference`, `brandingThemeId`,
  `currencyCode`, `lineAmountTypes` (mapped via the existing `map-line-amount-type` helper),
  and auto-send flags `approvedForSending` / `sendCopy` / `markAsSent` / `includePDF`.

Builds a `RepeatingInvoice`, wraps as `{ repeatingInvoices: [x] }`, calls
`createRepeatingInvoices(tenantId, …, true /*summarizeErrors*/)`. Returns the created template.

### `update-repeating-invoice` (full replace; also delete)
Identical param set to create **plus required `repeatingInvoiceId`**. Full-replace semantics — the
tool description carries the same warning as `update-invoice`: *"All line items must be provided.
Any line items not provided will be removed, including existing ones."* The expected workflow is
`get-repeating-invoice` → edit → resubmit the whole template. Passing `status="DELETED"` deletes
the template.

Builds a `RepeatingInvoice` with `repeatingInvoiceID` set, wraps as `{ repeatingInvoices: [x] }`,
calls `updateOrCreateRepeatingInvoices(tenantId, …, true)`. Returns the updated template.

**No DRAFT-only guard.** `update-invoice` pre-fetches and blocks edits to non-DRAFT invoices.
Repeating-invoice *templates* have no such restriction — an `AUTHORISED` template is still editable
in Xero — so we do **not** replicate that guard. (One fewer round-trip, and it matches Xero's
actual behaviour.)

## Output / formatting

Thin wrapper → return **raw** `RepeatingInvoice` fields. No deep link: the `get-deeplink` helper
has no `RepeatingInvoice` type and Xero exposes no stable per-template deep link. Tools format a
short summary (id, type, contact, schedule period/unit, `nextScheduledDate`, status, total,
line-item count) the same array-of-strings-`join("\n")` way the invoice tools do.

## Tests

Per the verified upstream convention (unit-test pure helpers with logic in
`src/helpers/__tests__/`; no handler or tool tests): this feature introduces **no new pure helper
with logic** — line/amount/tracking helpers already exist and are tested, and schedule handling is
plain field-mapping. So **no unit tests** are added.

Verification is the **live smoke block** appended to `smoke-test.mjs` (on
`nestegg-fork-integration` only): `create` a DRAFT template named `ZZZ … delete` → `get` it →
`update` it → delete it (`status="DELETED"`), all in one run, cleaning up after itself. Build +
lint is necessary but not sufficient; the smoke run against the real tenant is mandatory before
the PR is considered verified.

## Branch / PR discipline

Cut `feat/repeating-invoices` fresh from `origin/main`; implement only the four tools + handlers
there; PR to `XeroAPI/xero-mcp-server`. This spec and the smoke-test block are committed **only on
`nestegg-fork-integration`** and never appear in the PR.

## Out of scope

- **Attachments** on repeating invoices (`RepeatingInvoiceAttachments*` SDK methods) — separate
  concern, tracked under the attachments PRs in the roadmap.
- **History & notes** for repeating invoices — the history factory could be extended later; not
  part of this phase.
