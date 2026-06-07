# Phase 2 — Allocations

**Date:** 2026-06-07
**Feature:** Surface Xero allocations — apply credit notes / overpayments / prepayments to
invoices — plus the two missing list tools that feed them.
**Roadmap:** see `2026-06-07-xero-mcp-coverage-roadmap.md` (feature #2).

## Goal

Let the agent apply a credit note, overpayment, or prepayment against one or more outstanding
invoices, and list the overpayments/prepayments available to allocate. This removes a recurring
manual browser step in Nestegg bookkeeping. The server stays a thin wrapper: each tool maps 1:1
to a `xero-node` SDK call and returns the raw result.

## What the Xero API supports

SDK methods (all on `accountingApi`):

- `createCreditNoteAllocation(tenantId, creditNoteID, allocations, summarizeErrors?, idempotencyKey?, options?)`
- `createOverpaymentAllocations(tenantId, overpaymentID, allocations, …)`
- `createPrepaymentAllocations(tenantId, prepaymentID, allocations, …)`
- `getOverpayments(tenantId, ifModifiedSince?, where?, order?, page?, unitdp?, pageSize?, options?)`
- `getPrepayments(tenantId, …)` — same shape as `getOverpayments`
- `deleteCreditNoteAllocations` / `deleteOverpaymentAllocations` / `deletePrepaymentAllocations`
  exist too (used by the smoke test for cleanup; **no tool** built for them this phase — see
  Out of scope).

Models:

- `Allocations` = `{ allocations: Allocation[] }` (the wrapper passed to each create endpoint).
- `Allocation` = `{ invoice (required), amount (required), date (required),
  creditNote? / overpayment? / prepayment?, allocationID?, isDeleted? }`. To apply, only the
  target `invoice` (just its `invoiceID`), `amount`, and `date` are needed; the source object is
  identified by the endpoint's path param, not in the body.

**Note:** overpayments and prepayments **cannot be created via the API** — Xero generates them
from payments/bank transactions that exceed an invoice. So the create tools *allocate existing*
overpayments/prepayments; they don't create the source object.

## Scope — five thin-wrapper tools

Structure **A** (chosen): three separate create tools, 1:1 with the SDK endpoints. Rejected:
**B** a single unified `create-allocation` tool with a `sourceType` enum + `sourceId`, which
pushes dispatch logic into the tool and yields a less self-documenting schema (against the
thin-wrapper rule). Rejected **C** merging the two list tools, which would be inconsistent with
the existing standalone `list-credit-notes`.

| Tool | SDK call | Notes |
|------|----------|-------|
| `list-overpayments` | `getOverpayments` | new — none exists today |
| `list-prepayments` | `getPrepayments` | new |
| `create-credit-note-allocation` | `createCreditNoteAllocation` | apply a credit note to invoice(s) |
| `create-overpayment-allocation` | `createOverpaymentAllocations` | apply an overpayment to invoice(s) |
| `create-prepayment-allocation` | `createPrepaymentAllocations` | apply a prepayment to invoice(s) |

All three create endpoints accept an `Allocations` **array**, so each tool supports allocating to
multiple invoices in one call for free.

## Changes

### List tools (mirror `list-credit-notes`)

1. **`src/handlers/list-xero-overpayments.handler.ts`** and
   **`src/handlers/list-xero-prepayments.handler.ts`** — each with an inner `get…` fn taking
   `(page=1, pageSize=10, contactId?)`, building the same `Contact.ContactID==guid("…")`
   where-clause as `list-xero-credit-notes.handler.ts`, and an exported
   `listXeroOverpayments`/`listXeroPrepayments` returning `XeroClientResponse<Overpayment[]>` /
   `<Prepayment[]>`.
2. **`src/tools/list/list-overpayments.tool.ts`** and **`list-prepayments.tool.ts`** — expose
   exactly the `list-credit-notes` param set: `page`, `pageSize`, `contactId`. (`getOverpayments`
   /`getPrepayments` have no by-ID path, and the sibling `list-credit-notes` exposes no single-ID
   arg, so we don't add one — filter by `contactId` and page through.) Return the raw SDK objects
   (each carries its remaining `allocations` and outstanding amount — what the agent needs to
   decide what to apply).

### Create tools (mirror `create-xero-payment`)

3. **`src/helpers/allocation-schema.ts`** — new shared Zod `allocationLineSchema`:
   `{ invoiceId, amount, date }`, with descriptions telling the agent to source invoice IDs from
   `list-invoices` and the source ID from the relevant list tool. Same extract-and-share pattern
   used for the tracking schema.
4. **`src/handlers/create-xero-credit-note-allocation.handler.ts`** (+ overpayment, prepayment)
   — each takes a params object `{ sourceId, allocations: { invoiceId, amount, date }[] }`,
   builds the SDK `Allocations` wrapper `{ allocations: [{ invoice: { invoiceID: invoiceId },
   amount, date }] }`, calls the matching endpoint, returns `{ result, isError, error }` with the
   raw created allocation(s). Standard `formatError` handling.
5. **`src/tools/create/create-credit-note-allocation.tool.ts`** (+ overpayment, prepayment) —
   `creditNoteId`/`overpaymentId`/`prepaymentId` (string) + `allocations`
   (`z.array(allocationLineSchema).min(1)`); assemble the params object and call the handler.

### Registration

6. Register the two list tools in `src/tools/list/index.ts` and the three create tools in
   `src/tools/create/index.ts`. No deeplinks (allocations have no standalone Xero UI page).

## Testing

**Upstream test convention (verified):** the repo unit-tests **pure helper functions with logic**
in `src/helpers/__tests__/` and has **no handler or tool tests** on any branch. This feature adds
only handlers, tools, and a Zod schema *declaration* (`allocation-schema.ts`) — none of which the
repo tests (a raw schema has no logic; the one trivial `toAllocations` mapper lives inside the
handler, not as a standalone helper). So **no unit tests** are added, consistent with the upstream
convention. Verification is build + lint + live smoke test.

## Verification (live, against the connected tenant)

Add a block per tool to `smoke-test.mjs` (the fork-private e2e suite; see project `CLAUDE.md`).

- **List tools** — read-only: call each, assert no error, report counts and whether any
  overpayment/prepayment has remaining balance.
- **`create-credit-note-allocation`** — fully self-cleaning: create a throwaway AUTHORISED credit
  note + AUTHORISED invoice for a test contact (matching contact, so it can allocate), apply the
  allocation, assert it lands, then `deleteCreditNoteAllocations` and void both source documents.
  Leaves nothing behind.
- **`create-overpayment-allocation` / `create-prepayment-allocation`** — the source object can't
  be created via API. The smoke test allocates against a *real existing* overpayment/prepayment
  **iff `list-*` surfaces one with remaining balance**, then deletes the allocation; if none
  exists, it logs the gap and verifies only that the call is well-formed (the API's validation
  response is interpreted, not asserted as success). This limitation is documented, not hidden.

## Out of scope (noted follow-ups)

- **Delete-allocation tools.** The SDK has `delete*Allocations` for all three. Un-applying an
  allocation **is** a real Nestegg need — specifically when going back to correct an invoice that
  already has allocations attached — but it is lower-frequency and currently done in the browser,
  so it's deferred. The smoke test still *uses* the delete endpoints directly for cleanup. Good
  candidate for a small fast-follow phase.
- The other roadmap features (linked transactions, repeating invoices).

## Build / verify

- `npm run build` and `npm run lint` succeed.
- `node smoke-test.mjs` (credentials injected from `~/.claude.json`) passes the new blocks.
