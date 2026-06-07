# Phase 3 — Linked transactions (billable expenses)

**Date:** 2026-06-07
**Feature:** Surface Xero linked transactions (billable expenses) — list, create, allocate,
and delete — so costs can be recharged onto a customer's sales invoice from the MCP.
**Roadmap:** see `2026-06-07-xero-mcp-coverage-roadmap.md` (feature #3).

## Goal

Let the agent recharge a cost (a contractor bill, a utility, etc.) onto a tenant's or property
owner's sales invoice. In Xero this is a **billable expense**, modelled as a `LinkedTransaction`.
The flow is two-staged: a source bill/spend line is marked billable to a customer (stage 1), then
later allocated onto a sales invoice line (stage 2). The server stays a thin wrapper — each tool
maps 1:1 to a `xero-node` SDK call and returns the raw result.

## What the Xero API supports

SDK methods (all on `accountingApi`):

- `getLinkedTransactions(tenantId, page?, linkedTransactionID?, sourceTransactionID?, contactID?, status?, targetTransactionID?, options?)`
- `getLinkedTransaction(tenantId, linkedTransactionID, options?)` — single (we fold this into the
  list tool via the `linkedTransactionID` filter instead of a separate tool)
- `createLinkedTransaction(tenantId, linkedTransaction: LinkedTransaction, idempotencyKey?, options?)`
- `updateLinkedTransaction(tenantId, linkedTransactionID, linkedTransactions: LinkedTransactions, idempotencyKey?, options?)`
- `deleteLinkedTransaction(tenantId, linkedTransactionID, options?)`

`LinkedTransaction` model fields used:

- `sourceTransactionID` — the ACCPAY bill or SPEND bank-transaction the cost came from
- `sourceLineItemID` — which line on the source
- `contactID` — the customer the expense is assigned to (to be recharged)
- `targetTransactionID` — the ACCREC sales invoice it is allocated onto (set at stage 2)
- `targetLineItemID` — which line on the target sales invoice
- `linkedTransactionID`, `status` (`APPROVED` / `DRAFT` / `ONDRAFT` / `BILLED` / `VOIDED`),
  `type` (always `BILLABLEEXPENSE`, SDK default), `sourceTransactionTypeCode` (`ACCPAY` / `SPEND`)

`createLinkedTransaction` takes a **singular** `LinkedTransaction`; `updateLinkedTransaction` takes
the **plural** `LinkedTransactions` wrapper (`{ linkedTransactions: LinkedTransaction[] }`).

A billable expense becomes rechargeable when `status=APPROVED` and it has no target yet; allocating
it (setting target) moves it toward `BILLED`.

## Scope — four thin-wrapper tools + one enabler

| Tool | Dir | SDK call | Role |
|------|-----|----------|------|
| `list-linked-transactions` | `list/` | `getLinkedTransactions` | find billable expenses; single-fetch via optional ID |
| `create-linked-transaction` | `create/` | `createLinkedTransaction` | stage 1 — mark a source line billable to a customer |
| `update-linked-transaction` | `update/` | `updateLinkedTransaction` | stage 2 — allocate onto a sales-invoice line / change status |
| `delete-linked-transaction` | `delete/` | `deleteLinkedTransaction` | remove a link (corrections) |

The repo already has `create/`, `update/`, `delete/`, `list/` tool categories and a `tool-factory`
that aggregates each, so every tool has a natural home; no factory restructuring needed.

### Enabler: expose `lineItemID` in `formatLineItem`

The whole feature hinges on line-item IDs (`sourceLineItemID` from the bill, `targetLineItemID`
from the sales invoice). Today `src/helpers/format-line-item.ts` does **not** print
`lineItem.lineItemID`, so the agent cannot obtain them. Add one line —
`Line Item ID: ${lineItem.lineItemID}` — to `formatLineItem`. Additive, upstreamable, benefits
every line-item display. (See "Merge note" below re: PR #178.)

## Tool details

### `list-linked-transactions`
Expose the SDK's native filters: `page`, `linkedTransactionId` (single fetch), `sourceTransactionId`,
`contactId`, `status`, `targetTransactionId` — all optional. Finding rechargeable expenses for a
customer = `contactId` + `status="APPROVED"`. Serialize the raw fields (IDs, status, type,
source/target transaction + line IDs, updatedDateUTC).

### `create-linked-transaction` (stage 1)
Required: `sourceTransactionId`, `sourceLineItemId`, `contactId`. Optional: `targetTransactionId`,
`targetLineItemId` (allows a one-shot create+allocate when the sales invoice already exists). Build
a `LinkedTransaction` object; `type` is left to the SDK default (`BILLABLEEXPENSE`). Return the
created linked transaction.

### `update-linked-transaction` (stage 2 / status)
Required: `linkedTransactionId`. Optional: `targetTransactionId`, `targetLineItemId`,
`sourceLineItemId`, `contactId`, `status`. Build a `LinkedTransaction` from the provided fields,
wrap as `LinkedTransactions` (`{ linkedTransactions: [lt] }`), call `updateLinkedTransaction`.
Return the updated linked transaction.

### `delete-linked-transaction`
Required: `linkedTransactionId`. Calls `deleteLinkedTransaction`. Returns a success confirmation
(the SDK delete returns no body).

## Data flow — how the agent gets line IDs

Primary case = contractor **bills (ACCPAY)**:
1. Agent calls `list-invoices` with the bill's `invoiceNumbers` → the response includes its line
   items, now showing `Line Item ID` (via the enabler) → use as `sourceLineItemId`.
2. For the target, agent calls `list-invoices` with the sales invoice's number → line IDs →
   `targetLineItemId`.

**SPEND (bank-transaction) sources are out of scope for this phase** — bank-transaction line
serialization is a separate path and most Nestegg recharges are contractor bills. Documented as a
follow-up; the create tool still *accepts* a SPEND `sourceTransactionId` if the agent supplies the
line ID by other means, but we don't add tooling to surface SPEND line IDs here.

## Error handling / testing

Standard `formatError` handling, matching every other handler.

**Upstream test convention (verified, not assumed):** the repo tests **pure helper functions with
logic** under `src/helpers/__tests__/` (`format-error`, and — via the open PRs — `format-line-item`,
`format-tracking`, `map-line-amount-type`). It has **no handler or tool tests** on any branch.
Following that convention:

- **Handlers and tools** (the four new ones) get **no unit tests** — consistent with the entire
  repo, where handlers/tools are exercised only at runtime. (This is the repo's convention, which
  happens to align with the parent workspace rule — but the deciding authority here is the upstream
  repo.)
- **The `formatLineItem` enabler DOES get a test.** It modifies a pure helper, which is exactly what
  this repo tests. Add `src/helpers/__tests__/format-line-item.test.ts` asserting the rendered
  output includes the `Line Item ID: <id>` line, mirroring the existing helper-test style (Vitest,
  `describe`/`it`/`expect`). Run with `npm test`.
  - **Note:** this test file does **not** exist on `origin/main` (only the `format-error` test
    does), so the upstream PR creates it. On `nestegg-fork-integration`, PR #178 also adds a
    `format-line-item.test.ts`; reconcile the two at merge time (combine cases — both just assert
    different lines of the same formatter output).

Beyond the helper test, verification is build + lint + live smoke.

## Verification (live, against the connected tenant)

Add blocks to `smoke-test.mjs` (fork-private e2e suite; see project `CLAUDE.md`):

- **`list-linked-transactions`** — read-only: call with no filters, assert no error, report count.
- **create → update → delete** — self-contained, fully cleaned up:
  1. Create a throwaway contact.
  2. Create an AUTHORISED ACCPAY bill with one line (using a real expense account code fetched from
     `getAccounts`); read back its `lineItems[0].lineItemID`.
  3. Create an AUTHORISED ACCREC sales invoice for the same contact with one line; read back its
     line ID.
  4. `create-linked-transaction` (source bill line + contact); assert a `linkedTransactionID` comes
     back.
  5. `update-linked-transaction` to set the target (sales-invoice line); assert target is applied.
  6. `delete-linked-transaction`; then void the bill + invoice. Leaves nothing behind.
  If any step fails, best-effort void the fixtures before rethrowing.

## Merge note (Phase B)

The `formatLineItem` enabler touches a shared file that **PR #178** also modified (tracking
display — present on `nestegg-fork-integration` but not `origin/main`). On the upstream feature
branch (cut from `origin/main`) it is a clean one-line addition. When merging the feature branch
into `nestegg-fork-integration`, reconcile with #178 (trivial — both only add lines to
`formatLineItem`). Same class of merge already handled for #176/#110.

## Out of scope (noted follow-ups)

- **SPEND/bank-transaction line-ID surfacing** for billable expenses sourced from spend-money
  (see Data flow).
- The remaining roadmap feature (repeating invoices).

## Build / verify

- `npm run build` and `npm run lint` succeed.
- `node smoke-test.mjs` (credentials injected from `~/.claude.json`) passes the new blocks.
