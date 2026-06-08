# Linked Transactions (Billable Expenses) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four thin-wrapper MCP tools that list / create / update / delete Xero linked transactions (billable expenses), plus a one-line `formatLineItem` enabler that surfaces each line's `Line Item ID` — so a cost on a contractor bill can be recharged onto a customer's sales invoice from the MCP.

**Architecture:** `list-linked-transactions` mirrors `list-credit-notes` (handler + tool + index). `create-` / `update-` / `delete-linked-transaction` mirror `create-invoice` / `update-invoice` / `delete-payroll-timesheet` respectively. Each handler maps 1:1 to one `xero-node` SDK call and returns the raw model — no aggregation, no business logic. The enabler adds one line to the pure `formatLineItem` helper (and, per repo convention, a Vitest test for that helper).

**Tech Stack:** TypeScript (ESM), `xero-node` SDK, Zod, `@modelcontextprotocol/sdk`. Vitest is used **only** for the `formatLineItem` enabler (a pure helper with logic — that is exactly what this repo tests). Handlers and tools get **no** unit tests — the repo has none on any branch; they are verified by build + lint + live smoke (see project `CLAUDE.md`).

**Spec:** `docs/superpowers/specs/2026-06-07-linked-transactions-design.md` (read it first — it lives only on `nestegg-fork-integration`; from a feature branch read it with `git show nestegg-fork-integration:docs/superpowers/specs/2026-06-07-linked-transactions-design.md`).

---

## Branch discipline (read before Task 0)

This is an upstream-PR feature. Per project `CLAUDE.md`:
- Cut the branch **fresh from `origin/main`** — NOT from `nestegg-fork-integration`.
- Phase A (Tasks 0–6) happens on `feat/linked-transactions`, then opens an upstream PR. **STOP after Task 6** — do not do Phase B.
- Phase B (Tasks 7–8) happens in the **main session** on `nestegg-fork-integration` (where `smoke-test.mjs` lives) to integrate into the running build and live-verify. It includes a merge reconciliation against PR #178 (see Task 7).

## SDK reference (verified against `node_modules/xero-node`)

`LinkedTransaction` model fields: `sourceTransactionID`, `sourceLineItemID`, `contactID`, `targetTransactionID`, `targetLineItemID`, `linkedTransactionID`, `status` (enum `APPROVED`/`DRAFT`/`ONDRAFT`/`BILLED`/`VOIDED`), `type` (enum, default `BILLABLEEXPENSE`), `sourceTransactionTypeCode` (`ACCPAY`/`SPEND`), `updatedDateUTC`.

SDK methods on `xeroClient.accountingApi` (all return `body: LinkedTransactions`, i.e. a `{ linkedTransactions: LinkedTransaction[] }` wrapper — even create/update, which return the single affected row at index 0; **delete returns no usable body**):
- `getLinkedTransactions(tenantId, page?, linkedTransactionID?, sourceTransactionID?, contactID?, status?, targetTransactionID?, options?)`
- `createLinkedTransaction(tenantId, linkedTransaction: LinkedTransaction, idempotencyKey?, options?)`
- `updateLinkedTransaction(tenantId, linkedTransactionID, linkedTransactions: LinkedTransactions, idempotencyKey?, options?)`
- `deleteLinkedTransaction(tenantId, linkedTransactionID, options?)`

> **Status enum gotcha:** the `.d.ts` declares `StatusEnum` without initialisers, so TS treats it as a numeric enum and a plain `string` is **not** assignable. The runtime values are string-equal to their names (`StatusEnum["APPROVED"] === "APPROVED"`). Map a string param through the enum by key: `LinkedTransaction.StatusEnum[status as keyof typeof LinkedTransaction.StatusEnum]`. Do **not** use `as LinkedTransaction.StatusEnum` (TS error 2352) or `as unknown as` (lint-noisy).

## File structure

**Create (Phase A, on `feat/linked-transactions`):**
- `src/handlers/list-xero-linked-transactions.handler.ts`
- `src/handlers/create-xero-linked-transaction.handler.ts`
- `src/handlers/update-xero-linked-transaction.handler.ts`
- `src/handlers/delete-xero-linked-transaction.handler.ts`
- `src/tools/list/list-linked-transactions.tool.ts`
- `src/tools/create/create-linked-transaction.tool.ts`
- `src/tools/update/update-linked-transaction.tool.ts`
- `src/tools/delete/delete-linked-transaction.tool.ts`
- `src/helpers/__tests__/format-line-item.test.ts` (absent on `origin/main` — created fresh here)

**Modify:**
- `src/helpers/format-line-item.ts` — add the `Line Item ID` line (the enabler)
- `src/tools/list/index.ts` — register 1 list tool
- `src/tools/create/index.ts` — register 1 create tool
- `src/tools/update/index.ts` — register 1 update tool
- `src/tools/delete/index.ts` — register 1 delete tool
- `smoke-test.mjs` — add verification block (Phase B only — file exists only on `nestegg-fork-integration`)

---

## Task 0: Branch setup

**Files:** none (git + deps)

- [ ] **Step 1: Cut the feature branch from upstream main**

```bash
git fetch origin
git switch -c feat/linked-transactions origin/main
```

- [ ] **Step 2: Install deps (fresh worktree has no node_modules)**

```bash
npm install
```

- [ ] **Step 3: Read the spec**

```bash
git show nestegg-fork-integration:docs/superpowers/specs/2026-06-07-linked-transactions-design.md
```

- [ ] **Step 4: Baseline build + lint to confirm a clean start**

Run: `npm run build && npm run lint`
Expected: build completes with `> tsc && shx chmod +x dist/*.js` and no errors; lint reports no errors.

---

## Task 1: Enabler — surface `Line Item ID` in `formatLineItem` (TDD)

**Files:**
- Test: `src/helpers/__tests__/format-line-item.test.ts` (create — absent on `origin/main`)
- Modify: `src/helpers/format-line-item.ts`

This is a pure helper with logic, so it follows the repo's helper-test convention (Vitest, `describe`/`it`/`expect`, like `format-error.test.ts`). TDD: write the failing test first.

- [ ] **Step 1: Write the failing test**

Create `src/helpers/__tests__/format-line-item.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LineItem } from "xero-node";
import { formatLineItem } from "../format-line-item.js";

describe("formatLineItem", () => {
  it("includes the line item ID so it can be used to link billable expenses", () => {
    const lineItem = {
      lineItemID: "li-123",
      description: "Consulting services",
      lineAmount: 120,
    } as LineItem;

    const result = formatLineItem(lineItem);

    expect(result).toContain("Line Item ID: li-123");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- format-line-item`
Expected: FAIL — the rendered output does not contain `Line Item ID: li-123` (the field is not printed yet).

- [ ] **Step 3: Add the line to `formatLineItem`**

In `src/helpers/format-line-item.ts`, add `Line Item ID` immediately after the `Item ID` line. The current (`origin/main`) file is:

```ts
import { LineItem } from "xero-node";

export const formatLineItem = (lineItem: LineItem): string => {
  return [
    `Item ID: ${lineItem.item}`,
    `Item Code: ${lineItem.itemCode}`,
    `Description: ${lineItem.description}`,
    `Quantity: ${lineItem.quantity}`,
    `Unit Amount: ${lineItem.unitAmount}`,
    `Account Code: ${lineItem.accountCode}`,
    `Tax Type: ${lineItem.taxType}`,
    `Tracking: ${lineItem.tracking}`,
    `Line Amount: ${lineItem.lineAmount}`,
  ].join("\n");
};
```

Change it to:

```ts
import { LineItem } from "xero-node";

export const formatLineItem = (lineItem: LineItem): string => {
  return [
    `Item ID: ${lineItem.item}`,
    `Line Item ID: ${lineItem.lineItemID}`,
    `Item Code: ${lineItem.itemCode}`,
    `Description: ${lineItem.description}`,
    `Quantity: ${lineItem.quantity}`,
    `Unit Amount: ${lineItem.unitAmount}`,
    `Account Code: ${lineItem.accountCode}`,
    `Tax Type: ${lineItem.taxType}`,
    `Tracking: ${lineItem.tracking}`,
    `Line Amount: ${lineItem.lineAmount}`,
  ].join("\n");
};
```

(Only the one `Line Item ID` line is added — leave everything else exactly as on `origin/main`. The `Tracking:` line is reworked separately by PR #178 on the integration branch; do **not** touch it here. Task 7 reconciles the two.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- format-line-item`
Expected: PASS.

- [ ] **Step 5: Build + lint**

Run: `npm run build && npm run lint`
Expected: no errors, no new warnings.

- [ ] **Step 6: Commit**

```bash
git add src/helpers/format-line-item.ts src/helpers/__tests__/format-line-item.test.ts
git commit -m "feat: surface Line Item ID in formatLineItem (enables billable-expense links)"
```

---

## Task 2: list-linked-transactions

**Files:**
- Create: `src/handlers/list-xero-linked-transactions.handler.ts`
- Create: `src/tools/list/list-linked-transactions.tool.ts`
- Modify: `src/tools/list/index.ts`

- [ ] **Step 1: Create the handler** (mirrors `list-xero-credit-notes.handler.ts`)

```ts
import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { LinkedTransaction } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";

async function getLinkedTransactions(
  page: number,
  linkedTransactionId?: string,
  sourceTransactionId?: string,
  contactId?: string,
  status?: string,
  targetTransactionId?: string,
): Promise<LinkedTransaction[]> {
  await xeroClient.authenticate();

  const response = await xeroClient.accountingApi.getLinkedTransactions(
    xeroClient.tenantId,
    page, // page
    linkedTransactionId, // linkedTransactionID
    sourceTransactionId, // sourceTransactionID
    contactId, // contactID
    status, // status
    targetTransactionId, // targetTransactionID
    getClientHeaders(),
  );

  return response.body.linkedTransactions ?? [];
}

/**
 * List linked transactions (billable expenses) from Xero
 */
export async function listXeroLinkedTransactions(
  page: number = 1,
  linkedTransactionId?: string,
  sourceTransactionId?: string,
  contactId?: string,
  status?: string,
  targetTransactionId?: string,
): Promise<XeroClientResponse<LinkedTransaction[]>> {
  try {
    const linkedTransactions = await getLinkedTransactions(
      page,
      linkedTransactionId,
      sourceTransactionId,
      contactId,
      status,
      targetTransactionId,
    );

    return {
      result: linkedTransactions,
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
```

- [ ] **Step 2: Create the tool** (mirrors `list-credit-notes.tool.ts`)

```ts
import { z } from "zod";
import { listXeroLinkedTransactions } from "../../handlers/list-xero-linked-transactions.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const ListLinkedTransactionsTool = CreateXeroTool(
  "list-linked-transactions",
  `List linked transactions (billable expenses) in Xero. A billable expense links a cost on a
  source bill (ACCPAY) or spend-money transaction to a customer so it can be recharged onto
  their sales invoice (ACCREC). Filter by any combination of: a single linkedTransactionId
  (exact fetch), sourceTransactionId (all links from one bill), contactId (the customer the
  expense is assigned to), status (APPROVED/DRAFT/ONDRAFT/BILLED/VOIDED), or targetTransactionId
  (all links allocated onto one sales invoice). To find expenses that are ready to recharge to a
  customer, filter by contactId plus status "APPROVED". Ask the user if they want the next page
  after a full page is returned; if so, call again with the next page number.`,
  {
    page: z.number(),
    linkedTransactionId: z
      .string()
      .optional()
      .describe("Fetch a single linked transaction by its ID."),
    sourceTransactionId: z
      .string()
      .optional()
      .describe("Filter to links created from this source bill/spend transaction ID."),
    contactId: z
      .string()
      .optional()
      .describe("Filter to links assigned to this customer (contact) ID."),
    status: z
      .string()
      .optional()
      .describe("Filter by status: APPROVED, DRAFT, ONDRAFT, BILLED, or VOIDED."),
    targetTransactionId: z
      .string()
      .optional()
      .describe("Filter to links allocated onto this sales invoice (target) ID."),
  },
  async ({
    page,
    linkedTransactionId,
    sourceTransactionId,
    contactId,
    status,
    targetTransactionId,
  }) => {
    const response = await listXeroLinkedTransactions(
      page,
      linkedTransactionId,
      sourceTransactionId,
      contactId,
      status,
      targetTransactionId,
    );
    if (response.error !== null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing linked transactions: ${response.error}`,
          },
        ],
      };
    }

    const linkedTransactions = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${linkedTransactions?.length || 0} linked transactions:`,
        },
        ...(linkedTransactions?.map((lt) => ({
          type: "text" as const,
          text: [
            `Linked Transaction ID: ${lt.linkedTransactionID}`,
            `Status: ${lt.status || "Unknown"}`,
            `Type: ${lt.type || "Unknown"}`,
            lt.sourceTransactionID ? `Source Transaction ID: ${lt.sourceTransactionID}` : null,
            lt.sourceLineItemID ? `Source Line Item ID: ${lt.sourceLineItemID}` : null,
            lt.sourceTransactionTypeCode ? `Source Type: ${lt.sourceTransactionTypeCode}` : null,
            lt.contactID ? `Contact ID: ${lt.contactID}` : null,
            lt.targetTransactionID ? `Target Transaction ID: ${lt.targetTransactionID}` : null,
            lt.targetLineItemID ? `Target Line Item ID: ${lt.targetLineItemID}` : null,
            lt.updatedDateUTC ? `Last Updated: ${lt.updatedDateUTC}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        })) || []),
      ],
    };
  },
);

export default ListLinkedTransactionsTool;
```

- [ ] **Step 3: Register the tool in `src/tools/list/index.ts`**

Add the import alongside the other imports:

```ts
import ListLinkedTransactionsTool from "./list-linked-transactions.tool.js";
```

Add `ListLinkedTransactionsTool,` to the `ListTools` array (e.g. after `ListInvoicesTool,`).

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: no errors, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/list-xero-linked-transactions.handler.ts src/tools/list/list-linked-transactions.tool.ts src/tools/list/index.ts
git commit -m "feat: add list-linked-transactions tool"
```

---

## Task 3: create-linked-transaction (stage 1)

**Files:**
- Create: `src/handlers/create-xero-linked-transaction.handler.ts`
- Create: `src/tools/create/create-linked-transaction.tool.ts`
- Modify: `src/tools/create/index.ts`

- [ ] **Step 1: Create the handler**

```ts
import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { LinkedTransaction } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";

/**
 * Create a linked transaction (billable expense) in Xero — stage 1: mark a source
 * bill/spend line as billable to a customer. Optionally allocate it onto a sales
 * invoice line in the same call by supplying the target fields.
 */
export async function createXeroLinkedTransaction(
  sourceTransactionId: string,
  sourceLineItemId: string,
  contactId: string,
  targetTransactionId?: string,
  targetLineItemId?: string,
): Promise<XeroClientResponse<LinkedTransaction>> {
  try {
    await xeroClient.authenticate();

    const linkedTransaction: LinkedTransaction = {
      sourceTransactionID: sourceTransactionId,
      sourceLineItemID: sourceLineItemId,
      contactID: contactId,
      targetTransactionID: targetTransactionId,
      targetLineItemID: targetLineItemId,
    };

    const response = await xeroClient.accountingApi.createLinkedTransaction(
      xeroClient.tenantId,
      linkedTransaction,
      undefined, // idempotencyKey
      getClientHeaders(),
    );

    const created = response.body.linkedTransactions?.[0];
    if (!created) {
      throw new Error("Linked transaction creation failed.");
    }

    return {
      result: created,
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
```

- [ ] **Step 2: Create the tool**

```ts
import { z } from "zod";
import { createXeroLinkedTransaction } from "../../handlers/create-xero-linked-transaction.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const CreateLinkedTransactionTool = CreateXeroTool(
  "create-linked-transaction",
  `Create a linked transaction (billable expense) in Xero — stage 1 of recharging a cost to a
  customer. Marks a single line on a source bill (ACCPAY) as billable to a customer so it can
  later be allocated onto their sales invoice. Provide the source bill's transaction ID and the
  specific line item ID to recharge (both from list-invoices — the line item ID is shown as
  "Line Item ID" on each line), plus the customer's contact ID. Optionally also provide the
  target sales invoice's transaction ID and line item ID to create and allocate in one step (only
  if the sales invoice already exists; otherwise allocate later with update-linked-transaction).
  Returns the created linked transaction with its ID.`,
  {
    sourceTransactionId: z
      .string()
      .describe("The ID of the source bill (ACCPAY invoice) the cost came from. Obtain from list-invoices."),
    sourceLineItemId: z
      .string()
      .describe('The line item ID on the source bill to recharge. Shown as "Line Item ID" on the bill\'s line items in list-invoices.'),
    contactId: z
      .string()
      .describe("The ID of the customer (contact) the expense is being recharged to. Obtain from list-contacts."),
    targetTransactionId: z
      .string()
      .optional()
      .describe("Optional: the ID of the sales invoice (ACCREC) to allocate this expense onto. Only if it already exists; otherwise allocate later with update-linked-transaction."),
    targetLineItemId: z
      .string()
      .optional()
      .describe('Optional: the line item ID on the target sales invoice to allocate onto. Shown as "Line Item ID" in list-invoices.'),
  },
  async ({
    sourceTransactionId,
    sourceLineItemId,
    contactId,
    targetTransactionId,
    targetLineItemId,
  }) => {
    const response = await createXeroLinkedTransaction(
      sourceTransactionId,
      sourceLineItemId,
      contactId,
      targetTransactionId,
      targetLineItemId,
    );
    if (response.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error creating linked transaction: ${response.error}`,
          },
        ],
      };
    }

    const lt = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: [
            "Linked transaction created successfully:",
            `Linked Transaction ID: ${lt?.linkedTransactionID}`,
            `Status: ${lt?.status}`,
            `Source Transaction ID: ${lt?.sourceTransactionID}`,
            `Source Line Item ID: ${lt?.sourceLineItemID}`,
            `Contact ID: ${lt?.contactID}`,
            lt?.targetTransactionID ? `Target Transaction ID: ${lt.targetTransactionID}` : null,
            lt?.targetLineItemID ? `Target Line Item ID: ${lt.targetLineItemID}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  },
);

export default CreateLinkedTransactionTool;
```

- [ ] **Step 3: Register in `src/tools/create/index.ts`**

Add `import CreateLinkedTransactionTool from "./create-linked-transaction.tool.js";` and add `CreateLinkedTransactionTool,` to the `CreateTools` array.

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: no errors, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/create-xero-linked-transaction.handler.ts src/tools/create/create-linked-transaction.tool.ts src/tools/create/index.ts
git commit -m "feat: add create-linked-transaction tool"
```

---

## Task 4: update-linked-transaction (stage 2 / status)

**Files:**
- Create: `src/handlers/update-xero-linked-transaction.handler.ts`
- Create: `src/tools/update/update-linked-transaction.tool.ts`
- Modify: `src/tools/update/index.ts`

- [ ] **Step 1: Create the handler** (note the status-enum mapping — see the SDK reference at the top)

```ts
import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { LinkedTransaction } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";

/**
 * Update a linked transaction (billable expense) in Xero — stage 2: allocate it onto a
 * sales-invoice line (set target) and/or change its source line, contact, or status.
 */
export async function updateXeroLinkedTransaction(
  linkedTransactionId: string,
  targetTransactionId?: string,
  targetLineItemId?: string,
  sourceLineItemId?: string,
  contactId?: string,
  status?: string,
): Promise<XeroClientResponse<LinkedTransaction>> {
  try {
    await xeroClient.authenticate();

    const linkedTransaction: LinkedTransaction = {
      targetTransactionID: targetTransactionId,
      targetLineItemID: targetLineItemId,
      sourceLineItemID: sourceLineItemId,
      contactID: contactId,
      status: status
        ? LinkedTransaction.StatusEnum[
            status as keyof typeof LinkedTransaction.StatusEnum
          ]
        : undefined,
    };

    const response = await xeroClient.accountingApi.updateLinkedTransaction(
      xeroClient.tenantId,
      linkedTransactionId,
      { linkedTransactions: [linkedTransaction] },
      undefined, // idempotencyKey
      getClientHeaders(),
    );

    const updated = response.body.linkedTransactions?.[0];
    if (!updated) {
      throw new Error("Linked transaction update failed.");
    }

    return {
      result: updated,
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
```

- [ ] **Step 2: Create the tool**

```ts
import { z } from "zod";
import { updateXeroLinkedTransaction } from "../../handlers/update-xero-linked-transaction.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const UpdateLinkedTransactionTool = CreateXeroTool(
  "update-linked-transaction",
  `Update a linked transaction (billable expense) in Xero — stage 2 of recharging a cost to a
  customer. Use this to allocate an existing billable expense onto a customer's sales invoice by
  setting the target sales invoice's transaction ID and line item ID (both from list-invoices —
  the line item ID is shown as "Line Item ID"). You can also change the source line item,
  reassign the customer (contact), or change the status. Provide the linked transaction ID (from
  list-linked-transactions) plus only the fields you want to change. Returns the updated linked
  transaction.`,
  {
    linkedTransactionId: z
      .string()
      .describe("The ID of the linked transaction to update. Obtain from list-linked-transactions."),
    targetTransactionId: z
      .string()
      .optional()
      .describe("The ID of the sales invoice (ACCREC) to allocate this expense onto. Obtain from list-invoices."),
    targetLineItemId: z
      .string()
      .optional()
      .describe('The line item ID on the target sales invoice to allocate onto. Shown as "Line Item ID" in list-invoices.'),
    sourceLineItemId: z
      .string()
      .optional()
      .describe("Change the source bill line item this expense came from."),
    contactId: z
      .string()
      .optional()
      .describe("Reassign the customer (contact) the expense is recharged to. Obtain from list-contacts."),
    status: z
      .enum(["APPROVED", "DRAFT", "ONDRAFT", "BILLED", "VOIDED"])
      .optional()
      .describe("Change the status of the linked transaction."),
  },
  async ({
    linkedTransactionId,
    targetTransactionId,
    targetLineItemId,
    sourceLineItemId,
    contactId,
    status,
  }) => {
    const response = await updateXeroLinkedTransaction(
      linkedTransactionId,
      targetTransactionId,
      targetLineItemId,
      sourceLineItemId,
      contactId,
      status,
    );
    if (response.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error updating linked transaction: ${response.error}`,
          },
        ],
      };
    }

    const lt = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: [
            "Linked transaction updated successfully:",
            `Linked Transaction ID: ${lt?.linkedTransactionID}`,
            `Status: ${lt?.status}`,
            `Source Transaction ID: ${lt?.sourceTransactionID}`,
            `Source Line Item ID: ${lt?.sourceLineItemID}`,
            `Contact ID: ${lt?.contactID}`,
            lt?.targetTransactionID ? `Target Transaction ID: ${lt.targetTransactionID}` : null,
            lt?.targetLineItemID ? `Target Line Item ID: ${lt.targetLineItemID}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  },
);

export default UpdateLinkedTransactionTool;
```

- [ ] **Step 3: Register in `src/tools/update/index.ts`**

Add `import UpdateLinkedTransactionTool from "./update-linked-transaction.tool.js";` and add `UpdateLinkedTransactionTool,` to the `UpdateTools` array.

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: no errors, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/update-xero-linked-transaction.handler.ts src/tools/update/update-linked-transaction.tool.ts src/tools/update/index.ts
git commit -m "feat: add update-linked-transaction tool"
```

---

## Task 5: delete-linked-transaction

**Files:**
- Create: `src/handlers/delete-xero-linked-transaction.handler.ts`
- Create: `src/tools/delete/delete-linked-transaction.tool.ts`
- Modify: `src/tools/delete/index.ts`

- [ ] **Step 1: Create the handler** (mirrors `delete-xero-payroll-timesheet.handler.ts`)

```ts
import { xeroClient } from "../clients/xero-client.js";
import { formatError } from "../helpers/format-error.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { getClientHeaders } from "../helpers/get-client-headers.js";

async function deleteLinkedTransaction(linkedTransactionId: string): Promise<boolean> {
  await xeroClient.authenticate();

  await xeroClient.accountingApi.deleteLinkedTransaction(
    xeroClient.tenantId,
    linkedTransactionId,
    getClientHeaders(),
  );

  return true;
}

/**
 * Delete a linked transaction (billable expense) in Xero
 */
export async function deleteXeroLinkedTransaction(
  linkedTransactionId: string,
): Promise<XeroClientResponse<boolean>> {
  try {
    await deleteLinkedTransaction(linkedTransactionId);

    return {
      result: true,
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
```

- [ ] **Step 2: Create the tool** (mirrors `delete-payroll-timesheet.tool.ts`)

```ts
import { z } from "zod";
import { deleteXeroLinkedTransaction } from "../../handlers/delete-xero-linked-transaction.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const DeleteLinkedTransactionTool = CreateXeroTool(
  "delete-linked-transaction",
  `Delete a linked transaction (billable expense) in Xero by its ID. Use this to undo a
  billable-expense link created in error. Obtain the ID from list-linked-transactions.`,
  {
    linkedTransactionId: z
      .string()
      .describe("The ID of the linked transaction to delete. Obtain from list-linked-transactions."),
  },
  async ({ linkedTransactionId }: { linkedTransactionId: string }) => {
    const response = await deleteXeroLinkedTransaction(linkedTransactionId);

    if (response.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error deleting linked transaction: ${response.error}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Successfully deleted linked transaction with ID: ${linkedTransactionId}`,
        },
      ],
    };
  },
);

export default DeleteLinkedTransactionTool;
```

- [ ] **Step 3: Register in `src/tools/delete/index.ts`**

The `origin/main` file is:

```ts
import DeletePayrollTimesheetTool from "./delete-payroll-timesheet.tool.js";

export const DeleteTools = [
  DeletePayrollTimesheetTool
];
```

Change it to:

```ts
import DeletePayrollTimesheetTool from "./delete-payroll-timesheet.tool.js";
import DeleteLinkedTransactionTool from "./delete-linked-transaction.tool.js";

export const DeleteTools = [
  DeletePayrollTimesheetTool,
  DeleteLinkedTransactionTool
];
```

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: no errors, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/delete-xero-linked-transaction.handler.ts src/tools/delete/delete-linked-transaction.tool.ts src/tools/delete/index.ts
git commit -m "feat: add delete-linked-transaction tool"
```

---

## Task 6: Push and open the upstream PR (END OF PHASE A — STOP HERE)

**Files:** none

- [ ] **Step 1: Final full build + lint + test**

Run: `npm run build && npm run lint && npm test`
Expected: no errors, no new warnings, all tests pass (including the new `format-line-item` test).

- [ ] **Step 2: Push the branch to the fork**

```bash
git push -u fork feat/linked-transactions
```

- [ ] **Step 3: Open the PR to upstream**

```bash
gh pr create --repo XeroAPI/xero-mcp-server --base main --head rathga:feat/linked-transactions \
  --title "feat: add linked-transaction (billable expense) tools + surface Line Item ID" \
  --body "Adds four thin-wrapper tools mapping 1:1 to the SDK: list-linked-transactions, create-linked-transaction, update-linked-transaction, and delete-linked-transaction. These cover the billable-expense flow — marking a cost on a source bill (ACCPAY) line as billable to a customer (stage 1) and allocating it onto that customer's sales invoice line (stage 2). Also surfaces each line's \`Line Item ID\` in formatLineItem, which the flow depends on to obtain source/target line IDs (with a Vitest test, matching the repo's helper-test convention). Mirrors the existing list-credit-notes / create-invoice / update-invoice / delete-payroll-timesheet patterns.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: prints the new PR URL. Record it; hand it back to the main session.

**STOP. Do not proceed to Phase B. The main session does Tasks 7–8.**

---

## Task 7: Integrate into the running build (Phase B — main session, on `nestegg-fork-integration`)

**Files:**
- Reconcile: `src/helpers/format-line-item.ts` and `src/helpers/__tests__/format-line-item.test.ts` (merge conflict vs PR #178)

- [ ] **Step 1: Switch to the integration branch and merge the feature**

```bash
git switch nestegg-fork-integration
git merge feat/linked-transactions -m "Merge feat/linked-transactions: linked-transaction (billable expense) tools + Line Item ID enabler (PR #<n>)"
```

(Replace `<n>` with the PR number from Task 6.)

- [ ] **Step 2: Resolve the `formatLineItem` conflict (combine, don't clobber)**

PR #178 (on the integration branch, not `origin/main`) reworked `formatLineItem` to use a `formatTracking` helper and `.filter(Boolean)`. This feature added the `Line Item ID` line to the older `origin/main` version. The merge conflicts on `src/helpers/format-line-item.ts`. **Keep #178's structure AND add the `Line Item ID` line.** The resolved file is:

```ts
import { LineItem } from "xero-node";

const formatTracking = (tracking: LineItem["tracking"]): string | undefined => {
  if (!tracking?.length) {
    return undefined;
  }

  return tracking
    .map((trackingItem) =>
      [
        trackingItem.name ? `Category: ${trackingItem.name}` : undefined,
        trackingItem.trackingCategoryID
          ? `Category ID: ${trackingItem.trackingCategoryID}`
          : undefined,
        trackingItem.option ? `Option: ${trackingItem.option}` : undefined,
        trackingItem.trackingOptionID
          ? `Option ID: ${trackingItem.trackingOptionID}`
          : undefined,
      ]
        .filter(Boolean)
        .join(", "),
    )
    .filter(Boolean)
    .join("; ");
};

export const formatLineItem = (lineItem: LineItem): string => {
  const tracking = formatTracking(lineItem.tracking);

  return [
    `Item ID: ${lineItem.item}`,
    `Line Item ID: ${lineItem.lineItemID}`,
    `Item Code: ${lineItem.itemCode}`,
    `Description: ${lineItem.description}`,
    `Quantity: ${lineItem.quantity}`,
    `Unit Amount: ${lineItem.unitAmount}`,
    `Account Code: ${lineItem.accountCode}`,
    `Tax Type: ${lineItem.taxType}`,
    tracking ? `Tracking: ${tracking}` : undefined,
    `Line Amount: ${lineItem.lineAmount}`,
  ]
    .filter(Boolean)
    .join("\n");
};
```

- [ ] **Step 3: Resolve the `format-line-item.test.ts` conflict (combine both cases)**

Both branches created this file (feature: the Line Item ID case; #178: the two tracking cases). Combine all three into one `describe` block:

```ts
import { describe, expect, it } from "vitest";
import { LineItem } from "xero-node";
import { formatLineItem } from "../format-line-item.js";

describe("formatLineItem", () => {
  it("includes the line item ID so it can be used to link billable expenses", () => {
    const lineItem = {
      lineItemID: "li-123",
      description: "Consulting services",
      lineAmount: 120,
    } as LineItem;

    const result = formatLineItem(lineItem);

    expect(result).toContain("Line Item ID: li-123");
  });

  it("formats tracking categories without object stringification", () => {
    const lineItem = {
      itemCode: "CONSULT",
      description: "Consulting services",
      tracking: [
        {
          name: "Project",
          option: "Website Redesign",
          trackingCategoryID: "category-1",
          trackingOptionID: "option-1",
        },
        {
          name: "Cost Centre",
          option: "Marketing",
          trackingCategoryID: "category-2",
          trackingOptionID: "option-2",
        },
      ],
      lineAmount: 120,
    } as LineItem;

    const result = formatLineItem(lineItem);

    expect(result).toContain(
      "Tracking: Category: Project, Category ID: category-1, Option: Website Redesign, Option ID: option-1; Category: Cost Centre, Category ID: category-2, Option: Marketing, Option ID: option-2",
    );
    expect(result).not.toContain("[object Object]");
  });

  it("omits tracking when there are no tracking categories", () => {
    expect(
      formatLineItem({ description: "No tracking" } as LineItem),
    ).not.toContain("Tracking:");
  });
});
```

- [ ] **Step 4: Complete the merge**

```bash
git add src/helpers/format-line-item.ts src/helpers/__tests__/format-line-item.test.ts
git commit --no-edit
```

- [ ] **Step 5: Rebuild + lint + test**

Run: `npm run build && npm run lint && npm test`
Expected: no errors; all tests pass (the combined `format-line-item` test included).

---

## Task 8: Live verification (on `nestegg-fork-integration`)

**Files:**
- Modify: `smoke-test.mjs`

This task runs the freshly-built `dist/` handlers against the real tenant. The create→update→delete test builds its own throwaway fixtures (a contact, an AUTHORISED ACCPAY bill, an AUTHORISED ACCREC sales invoice) and cleans everything up (link deleted; bill + invoice voided; contact archived). Best-effort cleanup on failure.

- [ ] **Step 1: Add imports at the top of `smoke-test.mjs`** (after the existing handler imports, before the `xeroClient` import)

```js
import { listXeroLinkedTransactions } from "./dist/handlers/list-xero-linked-transactions.handler.js";
import { createXeroLinkedTransaction } from "./dist/handlers/create-xero-linked-transaction.handler.js";
import { updateXeroLinkedTransaction } from "./dist/handlers/update-xero-linked-transaction.handler.js";
import { deleteXeroLinkedTransaction } from "./dist/handlers/delete-xero-linked-transaction.handler.js";
```

- [ ] **Step 2: Add the linked-transaction test blocks before the `// ---- cleanup safety net ----` section**

```js
// ---- Linked transactions: list tool (read-only) ----
await test("list-linked-transactions (#<n>)", async () => {
  const lts = unwrap(await listXeroLinkedTransactions(1));
  pass("list-linked-transactions (#<n>)", `${lts?.length ?? 0} linked transaction(s)`);
});

// ---- create → update → delete: self-contained fixtures, fully cleaned up ----
await test("linked-transaction create→update→delete (#<n>)", async () => {
  const today = new Date().toISOString().split("T")[0];
  // Account codes for the fixture lines: one expense (the bill), one revenue (the sales invoice).
  const expResp = await xeroClient.accountingApi.getAccounts(xeroClient.tenantId, undefined, 'Class=="EXPENSE"');
  const expCode = expResp.body.accounts?.[0]?.code;
  const revResp = await xeroClient.accountingApi.getAccounts(xeroClient.tenantId, undefined, 'Class=="REVENUE"');
  const revCode = revResp.body.accounts?.[0]?.code;
  if (!expCode || !revCode) throw new Error("need an EXPENSE and a REVENUE account for fixtures");
  // One throwaway contact serving as both the bill supplier and the recharge customer.
  const contactResp = await xeroClient.accountingApi.createContacts(xeroClient.tenantId, { contacts: [{ name: `ZZZ LinkedTx Test ${Date.now()}` }] });
  const contactID = contactResp.body.contacts?.[0]?.contactID;
  // AUTHORISED ACCPAY bill (the source cost), one line.
  const billResp = await xeroClient.accountingApi.createInvoices(xeroClient.tenantId, { invoices: [{
    type: "ACCPAY", contact: { contactID }, date: today, dueDate: today, status: "AUTHORISED",
    lineAmountTypes: "NoTax", lineItems: [{ description: "smoke test cost", quantity: 1, unitAmount: 50, accountCode: expCode }],
  }] });
  const billID = billResp.body.invoices?.[0]?.invoiceID;
  const sourceLineItemID = billResp.body.invoices?.[0]?.lineItems?.[0]?.lineItemID;
  // AUTHORISED ACCREC sales invoice (the target to recharge onto), one line.
  const invResp = await xeroClient.accountingApi.createInvoices(xeroClient.tenantId, { invoices: [{
    type: "ACCREC", contact: { contactID }, date: today, dueDate: today, status: "AUTHORISED",
    lineAmountTypes: "NoTax", lineItems: [{ description: "smoke test recharge", quantity: 1, unitAmount: 50, accountCode: revCode }],
  }] });
  const invoiceID = invResp.body.invoices?.[0]?.invoiceID;
  const targetLineItemID = invResp.body.invoices?.[0]?.lineItems?.[0]?.lineItemID;
  const voidAll = async () => {
    try { await xeroClient.accountingApi.updateInvoice(xeroClient.tenantId, billID, { invoices: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    try { await xeroClient.accountingApi.updateInvoice(xeroClient.tenantId, invoiceID, { invoices: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    try { await xeroClient.accountingApi.updateContact(xeroClient.tenantId, contactID, { contacts: [{ contactStatus: "ARCHIVED" }] }); } catch { /* ignore */ }
  };
  try {
    if (!sourceLineItemID || !targetLineItemID) throw new Error("fixture line item IDs not returned");
    // Stage 1: mark the bill line billable to the customer.
    const created = unwrap(await createXeroLinkedTransaction(billID, sourceLineItemID, contactID));
    const ltID = created.linkedTransactionID;
    if (!ltID) throw new Error("create returned no linkedTransactionID");
    // Stage 2: allocate onto the sales-invoice line.
    const updated = unwrap(await updateXeroLinkedTransaction(ltID, invoiceID, targetLineItemID));
    if (updated.targetTransactionID !== invoiceID) throw new Error(`target not applied: ${updated.targetTransactionID}`);
    // Cleanup: delete the link, then void both fixtures + archive the contact.
    unwrap(await deleteXeroLinkedTransaction(ltID));
    await voidAll();
    pass("linked-transaction create→update→delete (#<n>)", `link ${ltID} created, allocated to invoice ${invoiceID}, deleted, fixtures cleaned up`);
  } catch (e) {
    await voidAll();
    throw e;
  }
});
```

(Replace `#<n>` with the PR number from Task 6.)

- [ ] **Step 3: Run the smoke suite**

```powershell
$cfg = Get-Content "$env:USERPROFILE\.claude.json" -Raw | ConvertFrom-Json
$cfg.mcpServers.xero.env.PSObject.Properties | ForEach-Object { Set-Item -Path "Env:$($_.Name)" -Value $_.Value }
node smoke-test.mjs
```

Expected: summary shows all blocks PASS, including the two new linked-transaction blocks.

> If the stage-2 allocation (`updateXeroLinkedTransaction` setting the target) is rejected by Xero with a validation error, capture the exact message and surface it — do **not** silently weaken the assertion. The spec's verification plan requires the target to be applied; a real API constraint is a finding worth reporting, not papering over.

- [ ] **Step 4: Commit the smoke-test additions on the integration branch**

```bash
git add smoke-test.mjs
git commit -m "test: add live smoke blocks for linked-transaction tools"
```

- [ ] **Step 5: Wrap up.** Report the smoke-test summary + the upstream PR URL. Remind the user to **restart the MCP** so it picks up the new `dist/`. Then (main session) remove the agent worktree and update the `xero-mcp-fork-wiring` memory + `MEMORY.md` index to include the new PR.

---

## Notes for the implementer

- **Thin wrapper only.** No aggregation, no business logic. Each handler is one SDK call in, raw model out.
- **`create`/`update` return the plural wrapper.** Even though you send a singular `LinkedTransaction` to create and one wrapped in `LinkedTransactions` to update, both responses come back as `body.linkedTransactions` — read index `[0]`.
- **Status enum:** map strings via `LinkedTransaction.StatusEnum[status as keyof typeof LinkedTransaction.StatusEnum]` (see the SDK reference at the top). Don't reach for `as`-casts.
- **SPEND sources are out of scope** (spec). The create tool still accepts a SPEND `sourceTransactionId` if the caller supplies the line ID by other means, but we add no tooling to surface SPEND line IDs.
- **Verify SDK response property names** as you go: `response.body.linkedTransactions`. If the build complains about a property, check `node_modules/xero-node/dist/gen/model/accounting/linkedTransaction.d.ts`.
</content>
</invoke>
