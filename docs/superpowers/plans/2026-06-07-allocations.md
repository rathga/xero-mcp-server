# Allocations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five thin-wrapper MCP tools that list overpayments/prepayments and apply credit notes / overpayments / prepayments to invoices, mapping 1:1 to the `xero-node` SDK.

**Architecture:** Two list tools mirror `list-credit-notes` (handler + tool + index registration). Three create tools mirror `create-payment`, sharing one extracted Zod `allocationLineSchema`. Each create handler builds the SDK `Allocations` wrapper and calls the matching endpoint. No business logic, no aggregation — raw SDK results out.

**Tech Stack:** TypeScript (ESM), `xero-node` SDK, Zod, `@modelcontextprotocol/sdk`. Vitest exists but is NOT used here (this is pure plumbing — repo convention is build + lint + live smoke test, see project `CLAUDE.md`).

**Spec:** `docs/superpowers/specs/2026-06-07-allocations-design.md` (read it first — it lives only on `nestegg-fork-integration`; from a feature branch read it with `git show nestegg-fork-integration:docs/superpowers/specs/2026-06-07-allocations-design.md`).

---

## Branch discipline (read before Task 0)

This is an upstream-PR feature. Per project `CLAUDE.md`:
- Cut the branch **fresh from `origin/main`** — NOT from `nestegg-fork-integration`.
- Phase A (Tasks 0–7) happens on `feat/allocations`, then opens an upstream PR.
- Phase B (Tasks 8–9) happens on `nestegg-fork-integration` (where `smoke-test.mjs` lives) to integrate into the running build and live-verify.

## File structure

**Create (Phase A, on `feat/allocations`):**
- `src/helpers/allocation-schema.ts` — shared `allocationLineSchema`
- `src/handlers/list-xero-overpayments.handler.ts`
- `src/handlers/list-xero-prepayments.handler.ts`
- `src/handlers/create-xero-credit-note-allocation.handler.ts`
- `src/handlers/create-xero-overpayment-allocation.handler.ts`
- `src/handlers/create-xero-prepayment-allocation.handler.ts`
- `src/tools/list/list-overpayments.tool.ts`
- `src/tools/list/list-prepayments.tool.ts`
- `src/tools/create/create-credit-note-allocation.tool.ts`
- `src/tools/create/create-overpayment-allocation.tool.ts`
- `src/tools/create/create-prepayment-allocation.tool.ts`

**Modify:**
- `src/tools/list/index.ts` — register 2 list tools
- `src/tools/create/index.ts` — register 3 create tools
- `smoke-test.mjs` — add verification blocks (Phase B only — file exists only on `nestegg-fork-integration`)

---

## Task 0: Branch setup

**Files:** none (git + deps)

- [ ] **Step 1: Cut the feature branch from upstream main**

```bash
git fetch origin
git switch -c feat/allocations origin/main
```

- [ ] **Step 2: Install deps (fresh worktree has no node_modules)**

```bash
npm install
```

- [ ] **Step 3: Read the spec**

```bash
git show nestegg-fork-integration:docs/superpowers/specs/2026-06-07-allocations-design.md
```

- [ ] **Step 4: Baseline build to confirm a clean start**

Run: `npm run build`
Expected: completes with `> tsc && shx chmod +x dist/*.js` and no errors.

---

## Task 1: Shared allocation-line schema

**Files:**
- Create: `src/helpers/allocation-schema.ts`

- [ ] **Step 1: Create the shared schema**

```ts
import { z } from "zod";

// One invoice that a credit note / overpayment / prepayment is applied to.
// Shared by all three create-allocation tools. Mirrors the SDK Allocation model
// (only the target invoice id, amount, and date are needed on the request body —
// the source object is identified by the endpoint path param).
export const allocationLineSchema = z.object({
  invoiceId: z
    .string()
    .describe(
      "The ID of the invoice to apply this allocation to. Obtain from the list-invoices tool. The invoice must be AUTHORISED and not fully paid.",
    ),
  amount: z
    .number()
    .positive()
    .describe(
      "The amount to apply to this invoice (must be positive and not exceed the invoice's amount due or the source's remaining balance).",
    ),
  date: z
    .string()
    .describe("The date the allocation is applied, in YYYY-MM-DD format."),
});
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/helpers/allocation-schema.ts
git commit -m "feat: add shared allocation-line Zod schema"
```

---

## Task 2: list-overpayments

**Files:**
- Create: `src/handlers/list-xero-overpayments.handler.ts`
- Create: `src/tools/list/list-overpayments.tool.ts`
- Modify: `src/tools/list/index.ts`

- [ ] **Step 1: Create the handler** (mirrors `list-xero-credit-notes.handler.ts`)

```ts
import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { Overpayment } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";

async function getOverpayments(
  contactId: string | undefined,
  page: number,
  pageSize: number = 10,
): Promise<Overpayment[]> {
  await xeroClient.authenticate();

  const response = await xeroClient.accountingApi.getOverpayments(
    xeroClient.tenantId,
    undefined, // ifModifiedSince
    contactId ? `Contact.ContactID=guid("${contactId}")` : undefined, // where
    "UpdatedDateUTC DESC", // order
    page, // page
    undefined, // unitdp
    pageSize, // pageSize
    getClientHeaders(),
  );

  return response.body.overpayments ?? [];
}

/**
 * List overpayments from Xero
 */
export async function listXeroOverpayments(
  page: number = 1,
  contactId?: string,
  pageSize: number = 10,
): Promise<XeroClientResponse<Overpayment[]>> {
  try {
    const overpayments = await getOverpayments(contactId, page, pageSize);

    return {
      result: overpayments,
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
import { listXeroOverpayments } from "../../handlers/list-xero-overpayments.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const ListOverpaymentsTool = CreateXeroTool(
  "list-overpayments",
  `List overpayments in Xero. An overpayment is money a contact paid in excess of what
  they owed; its remaining balance can be allocated to an invoice with the
  create-overpayment-allocation tool. Optionally filter by contact. Ask the user if they
  want the next page after 10 are returned; if so, call again with the next page number.`,
  {
    page: z.number(),
    contactId: z.string().optional(),
    pageSize: z.number().min(1).max(100).default(10).optional().describe("Number of results per page (1-100, default 10)"),
  },
  async ({ page, contactId, pageSize }) => {
    const response = await listXeroOverpayments(page, contactId, pageSize);
    if (response.error !== null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing overpayments: ${response.error}`,
          },
        ],
      };
    }

    const overpayments = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${overpayments?.length || 0} overpayments:`,
        },
        ...(overpayments?.map((overpayment) => ({
          type: "text" as const,
          text: [
            `Overpayment ID: ${overpayment.overpaymentID}`,
            `Type: ${overpayment.type || "Unknown"}`,
            `Status: ${overpayment.status || "Unknown"}`,
            overpayment.contact
              ? `Contact: ${overpayment.contact.name} (${overpayment.contact.contactID})`
              : null,
            overpayment.date ? `Date: ${overpayment.date}` : null,
            `Total: ${overpayment.total ?? 0}`,
            `Remaining Credit: ${overpayment.remainingCredit ?? 0}`,
            overpayment.currencyCode ? `Currency: ${overpayment.currencyCode}` : null,
            overpayment.updatedDateUTC ? `Last Updated: ${overpayment.updatedDateUTC}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        })) || []),
      ],
    };
  },
);

export default ListOverpaymentsTool;
```

- [ ] **Step 3: Register the tool in `src/tools/list/index.ts`**

Add the import alongside the other imports:

```ts
import ListOverpaymentsTool from "./list-overpayments.tool.js";
```

Add `ListOverpaymentsTool,` to the `ListTools` array (e.g. after `ListPaymentsTool,`).

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: no errors, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/list-xero-overpayments.handler.ts src/tools/list/list-overpayments.tool.ts src/tools/list/index.ts
git commit -m "feat: add list-overpayments tool"
```

---

## Task 3: list-prepayments

**Files:**
- Create: `src/handlers/list-xero-prepayments.handler.ts`
- Create: `src/tools/list/list-prepayments.tool.ts`
- Modify: `src/tools/list/index.ts`

- [ ] **Step 1: Create the handler**

```ts
import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { Prepayment } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";

async function getPrepayments(
  contactId: string | undefined,
  page: number,
  pageSize: number = 10,
): Promise<Prepayment[]> {
  await xeroClient.authenticate();

  const response = await xeroClient.accountingApi.getPrepayments(
    xeroClient.tenantId,
    undefined, // ifModifiedSince
    contactId ? `Contact.ContactID=guid("${contactId}")` : undefined, // where
    "UpdatedDateUTC DESC", // order
    page, // page
    undefined, // unitdp
    pageSize, // pageSize
    getClientHeaders(),
  );

  return response.body.prepayments ?? [];
}

/**
 * List prepayments from Xero
 */
export async function listXeroPrepayments(
  page: number = 1,
  contactId?: string,
  pageSize: number = 10,
): Promise<XeroClientResponse<Prepayment[]>> {
  try {
    const prepayments = await getPrepayments(contactId, page, pageSize);

    return {
      result: prepayments,
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
import { listXeroPrepayments } from "../../handlers/list-xero-prepayments.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const ListPrepaymentsTool = CreateXeroTool(
  "list-prepayments",
  `List prepayments in Xero. A prepayment is money received in advance of an invoice; its
  remaining balance can be allocated to an invoice with the create-prepayment-allocation
  tool. Optionally filter by contact. Ask the user if they want the next page after 10 are
  returned; if so, call again with the next page number.`,
  {
    page: z.number(),
    contactId: z.string().optional(),
    pageSize: z.number().min(1).max(100).default(10).optional().describe("Number of results per page (1-100, default 10)"),
  },
  async ({ page, contactId, pageSize }) => {
    const response = await listXeroPrepayments(page, contactId, pageSize);
    if (response.error !== null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing prepayments: ${response.error}`,
          },
        ],
      };
    }

    const prepayments = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${prepayments?.length || 0} prepayments:`,
        },
        ...(prepayments?.map((prepayment) => ({
          type: "text" as const,
          text: [
            `Prepayment ID: ${prepayment.prepaymentID}`,
            `Type: ${prepayment.type || "Unknown"}`,
            `Status: ${prepayment.status || "Unknown"}`,
            prepayment.contact
              ? `Contact: ${prepayment.contact.name} (${prepayment.contact.contactID})`
              : null,
            prepayment.date ? `Date: ${prepayment.date}` : null,
            `Total: ${prepayment.total ?? 0}`,
            `Remaining Credit: ${prepayment.remainingCredit ?? 0}`,
            prepayment.currencyCode ? `Currency: ${prepayment.currencyCode}` : null,
            prepayment.updatedDateUTC ? `Last Updated: ${prepayment.updatedDateUTC}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        })) || []),
      ],
    };
  },
);

export default ListPrepaymentsTool;
```

- [ ] **Step 3: Register in `src/tools/list/index.ts`**

Add import `import ListPrepaymentsTool from "./list-prepayments.tool.js";` and add `ListPrepaymentsTool,` to the `ListTools` array.

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: no errors, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/list-xero-prepayments.handler.ts src/tools/list/list-prepayments.tool.ts src/tools/list/index.ts
git commit -m "feat: add list-prepayments tool"
```

---

## Task 4: create-credit-note-allocation

**Files:**
- Create: `src/handlers/create-xero-credit-note-allocation.handler.ts`
- Create: `src/tools/create/create-credit-note-allocation.tool.ts`
- Modify: `src/tools/create/index.ts`

- [ ] **Step 1: Create the handler**

```ts
import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { Allocation, Allocations } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";

export type AllocationLine = {
  invoiceId: string;
  amount: number;
  date: string;
};

function toAllocations(lines: AllocationLine[]): Allocations {
  return {
    allocations: lines.map((line) => ({
      invoice: { invoiceID: line.invoiceId },
      amount: line.amount,
      date: line.date,
    })),
  };
}

/**
 * Apply a credit note to one or more invoices.
 */
export async function createXeroCreditNoteAllocation(
  creditNoteId: string,
  allocations: AllocationLine[],
): Promise<XeroClientResponse<Allocation[]>> {
  try {
    await xeroClient.authenticate();

    const response = await xeroClient.accountingApi.createCreditNoteAllocation(
      xeroClient.tenantId,
      creditNoteId,
      toAllocations(allocations),
      undefined, // summarizeErrors
      undefined, // idempotencyKey
      getClientHeaders(),
    );

    return {
      result: response.body.allocations ?? [],
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
import { createXeroCreditNoteAllocation } from "../../handlers/create-xero-credit-note-allocation.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { allocationLineSchema } from "../../helpers/allocation-schema.js";

const CreateCreditNoteAllocationTool = CreateXeroTool(
  "create-credit-note-allocation",
  `Apply a credit note to one or more invoices in Xero. Provide the credit note ID (from
  list-credit-notes) and one allocation per target invoice (invoice ID from list-invoices,
  the amount to apply, and the date). The credit note must be AUTHORISED with remaining
  credit; each invoice must be AUTHORISED and not fully paid. The total allocated cannot
  exceed the credit note's remaining credit.`,
  {
    creditNoteId: z
      .string()
      .describe("The ID of the credit note to allocate. Obtain from the list-credit-notes tool."),
    allocations: z
      .array(allocationLineSchema)
      .min(1)
      .describe("One entry per invoice the credit note is applied to."),
  },
  async ({ creditNoteId, allocations }) => {
    const response = await createXeroCreditNoteAllocation(creditNoteId, allocations);
    if (response.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error creating credit note allocation: ${response.error}`,
          },
        ],
      };
    }

    const applied = response.result ?? [];

    return {
      content: [
        {
          type: "text" as const,
          text: `Applied credit note ${creditNoteId} to ${applied.length} invoice(s):`,
        },
        ...applied.map((allocation) => ({
          type: "text" as const,
          text: [
            `Allocation ID: ${allocation.allocationID ?? "(not returned)"}`,
            `Invoice ID: ${allocation.invoice?.invoiceID ?? "Unknown"}`,
            `Amount: ${allocation.amount}`,
            `Date: ${allocation.date}`,
          ].join("\n"),
        })),
      ],
    };
  },
);

export default CreateCreditNoteAllocationTool;
```

- [ ] **Step 3: Register in `src/tools/create/index.ts`**

Add `import CreateCreditNoteAllocationTool from "./create-credit-note-allocation.tool.js";` and add `CreateCreditNoteAllocationTool,` to the `CreateTools` array.

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: no errors, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/create-xero-credit-note-allocation.handler.ts src/tools/create/create-credit-note-allocation.tool.ts src/tools/create/index.ts
git commit -m "feat: add create-credit-note-allocation tool"
```

---

## Task 5: create-overpayment-allocation

**Files:**
- Create: `src/handlers/create-xero-overpayment-allocation.handler.ts`
- Create: `src/tools/create/create-overpayment-allocation.tool.ts`
- Modify: `src/tools/create/index.ts`

- [ ] **Step 1: Create the handler** (same shape as Task 4; reuses the shared `AllocationLine` type and a local `toAllocations`)

```ts
import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { Allocation, Allocations } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { AllocationLine } from "./create-xero-credit-note-allocation.handler.js";

function toAllocations(lines: AllocationLine[]): Allocations {
  return {
    allocations: lines.map((line) => ({
      invoice: { invoiceID: line.invoiceId },
      amount: line.amount,
      date: line.date,
    })),
  };
}

/**
 * Apply an overpayment to one or more invoices.
 */
export async function createXeroOverpaymentAllocation(
  overpaymentId: string,
  allocations: AllocationLine[],
): Promise<XeroClientResponse<Allocation[]>> {
  try {
    await xeroClient.authenticate();

    const response = await xeroClient.accountingApi.createOverpaymentAllocations(
      xeroClient.tenantId,
      overpaymentId,
      toAllocations(allocations),
      undefined, // summarizeErrors
      undefined, // idempotencyKey
      getClientHeaders(),
    );

    return {
      result: response.body.allocations ?? [],
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

> Note: `AllocationLine` and the `toAllocations` shape are intentionally re-imported / repeated. `AllocationLine` is exported from the credit-note handler (Task 4); importing it keeps one source of truth for the type. The tiny `toAllocations` helper is repeated per handler to keep each handler self-contained (3 identical 6-line functions is acceptable; extracting a shared mapper would be the only other option but adds an import for marginal gain — follow the repo's existing tolerance for small local helpers).

- [ ] **Step 2: Create the tool**

```ts
import { z } from "zod";
import { createXeroOverpaymentAllocation } from "../../handlers/create-xero-overpayment-allocation.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { allocationLineSchema } from "../../helpers/allocation-schema.js";

const CreateOverpaymentAllocationTool = CreateXeroTool(
  "create-overpayment-allocation",
  `Apply an overpayment to one or more invoices in Xero. Provide the overpayment ID (from
  list-overpayments) and one allocation per target invoice (invoice ID from list-invoices,
  the amount to apply, and the date). The overpayment must have remaining credit; each
  invoice must be AUTHORISED and not fully paid. The total allocated cannot exceed the
  overpayment's remaining credit.`,
  {
    overpaymentId: z
      .string()
      .describe("The ID of the overpayment to allocate. Obtain from the list-overpayments tool."),
    allocations: z
      .array(allocationLineSchema)
      .min(1)
      .describe("One entry per invoice the overpayment is applied to."),
  },
  async ({ overpaymentId, allocations }) => {
    const response = await createXeroOverpaymentAllocation(overpaymentId, allocations);
    if (response.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error creating overpayment allocation: ${response.error}`,
          },
        ],
      };
    }

    const applied = response.result ?? [];

    return {
      content: [
        {
          type: "text" as const,
          text: `Applied overpayment ${overpaymentId} to ${applied.length} invoice(s):`,
        },
        ...applied.map((allocation) => ({
          type: "text" as const,
          text: [
            `Allocation ID: ${allocation.allocationID ?? "(not returned)"}`,
            `Invoice ID: ${allocation.invoice?.invoiceID ?? "Unknown"}`,
            `Amount: ${allocation.amount}`,
            `Date: ${allocation.date}`,
          ].join("\n"),
        })),
      ],
    };
  },
);

export default CreateOverpaymentAllocationTool;
```

- [ ] **Step 3: Register in `src/tools/create/index.ts`**

Add `import CreateOverpaymentAllocationTool from "./create-overpayment-allocation.tool.js";` and add `CreateOverpaymentAllocationTool,` to the `CreateTools` array.

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: no errors, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/create-xero-overpayment-allocation.handler.ts src/tools/create/create-overpayment-allocation.tool.ts src/tools/create/index.ts
git commit -m "feat: add create-overpayment-allocation tool"
```

---

## Task 6: create-prepayment-allocation

**Files:**
- Create: `src/handlers/create-xero-prepayment-allocation.handler.ts`
- Create: `src/tools/create/create-prepayment-allocation.tool.ts`
- Modify: `src/tools/create/index.ts`

- [ ] **Step 1: Create the handler**

```ts
import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { Allocation, Allocations } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { AllocationLine } from "./create-xero-credit-note-allocation.handler.js";

function toAllocations(lines: AllocationLine[]): Allocations {
  return {
    allocations: lines.map((line) => ({
      invoice: { invoiceID: line.invoiceId },
      amount: line.amount,
      date: line.date,
    })),
  };
}

/**
 * Apply a prepayment to one or more invoices.
 */
export async function createXeroPrepaymentAllocation(
  prepaymentId: string,
  allocations: AllocationLine[],
): Promise<XeroClientResponse<Allocation[]>> {
  try {
    await xeroClient.authenticate();

    const response = await xeroClient.accountingApi.createPrepaymentAllocations(
      xeroClient.tenantId,
      prepaymentId,
      toAllocations(allocations),
      undefined, // summarizeErrors
      undefined, // idempotencyKey
      getClientHeaders(),
    );

    return {
      result: response.body.allocations ?? [],
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
import { createXeroPrepaymentAllocation } from "../../handlers/create-xero-prepayment-allocation.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { allocationLineSchema } from "../../helpers/allocation-schema.js";

const CreatePrepaymentAllocationTool = CreateXeroTool(
  "create-prepayment-allocation",
  `Apply a prepayment to one or more invoices in Xero. Provide the prepayment ID (from
  list-prepayments) and one allocation per target invoice (invoice ID from list-invoices,
  the amount to apply, and the date). The prepayment must have remaining credit; each
  invoice must be AUTHORISED and not fully paid. The total allocated cannot exceed the
  prepayment's remaining credit.`,
  {
    prepaymentId: z
      .string()
      .describe("The ID of the prepayment to allocate. Obtain from the list-prepayments tool."),
    allocations: z
      .array(allocationLineSchema)
      .min(1)
      .describe("One entry per invoice the prepayment is applied to."),
  },
  async ({ prepaymentId, allocations }) => {
    const response = await createXeroPrepaymentAllocation(prepaymentId, allocations);
    if (response.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error creating prepayment allocation: ${response.error}`,
          },
        ],
      };
    }

    const applied = response.result ?? [];

    return {
      content: [
        {
          type: "text" as const,
          text: `Applied prepayment ${prepaymentId} to ${applied.length} invoice(s):`,
        },
        ...applied.map((allocation) => ({
          type: "text" as const,
          text: [
            `Allocation ID: ${allocation.allocationID ?? "(not returned)"}`,
            `Invoice ID: ${allocation.invoice?.invoiceID ?? "Unknown"}`,
            `Amount: ${allocation.amount}`,
            `Date: ${allocation.date}`,
          ].join("\n"),
        })),
      ],
    };
  },
);

export default CreatePrepaymentAllocationTool;
```

- [ ] **Step 3: Register in `src/tools/create/index.ts`**

Add `import CreatePrepaymentAllocationTool from "./create-prepayment-allocation.tool.js";` and add `CreatePrepaymentAllocationTool,` to the `CreateTools` array.

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: no errors, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/create-xero-prepayment-allocation.handler.ts src/tools/create/create-prepayment-allocation.tool.ts src/tools/create/index.ts
git commit -m "feat: add create-prepayment-allocation tool"
```

---

## Task 7: Push and open the upstream PR

**Files:** none

- [ ] **Step 1: Final full build + lint**

Run: `npm run build && npm run lint`
Expected: no errors, no new warnings.

- [ ] **Step 2: Push the branch to the fork**

```bash
git push -u fork feat/allocations
```

- [ ] **Step 3: Open the PR to upstream**

```bash
gh pr create --repo XeroAPI/xero-mcp-server --base main --head rathga:feat/allocations \
  --title "feat: add allocation tools (credit note / overpayment / prepayment) + list-overpayments/list-prepayments" \
  --body "Adds five thin-wrapper tools mapping 1:1 to the SDK: list-overpayments, list-prepayments, and create-credit-note-allocation / create-overpayment-allocation / create-prepayment-allocation. Each create tool applies a source's remaining credit to one or more invoices via the Allocations array. Mirrors the existing list-credit-notes and create-payment patterns; shares one extracted allocation-line Zod schema.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: prints the new PR URL. Record it.

---

## Task 8: Integrate into the running build

**Files:** none (git)

- [ ] **Step 1: Switch to the integration branch and merge the feature**

```bash
git switch nestegg-fork-integration
git merge feat/allocations -m "Merge feat/allocations: allocation + list-overpayments/prepayments tools (PR #<n>)"
```

(Replace `<n>` with the PR number from Task 7.)

- [ ] **Step 2: Rebuild**

Run: `npm run build`
Expected: no errors.

---

## Task 9: Live verification (on `nestegg-fork-integration`)

**Files:**
- Modify: `smoke-test.mjs`

This task runs the freshly-built `dist/` handlers against the real tenant. Source documents for the create tests are created as clearly-labelled throwaways and cleaned up (allocation deleted; fixture documents voided). Overpayment/prepayment allocation tests run only if a real source with balance exists, else they log a skip (these objects can't be created via API).

- [ ] **Step 1: Add imports at the top of `smoke-test.mjs`** (after the existing handler imports)

```js
import { listXeroOverpayments } from "./dist/handlers/list-xero-overpayments.handler.js";
import { listXeroPrepayments } from "./dist/handlers/list-xero-prepayments.handler.js";
import { createXeroCreditNoteAllocation } from "./dist/handlers/create-xero-credit-note-allocation.handler.js";
import { createXeroOverpaymentAllocation } from "./dist/handlers/create-xero-overpayment-allocation.handler.js";
import { createXeroPrepaymentAllocation } from "./dist/handlers/create-xero-prepayment-allocation.handler.js";
```

- [ ] **Step 2: Add the allocation test blocks before the `// ---- cleanup safety net ----` section**

```js
// ---- Allocations: list tools (read-only) ----
let opWithBalance, ppWithBalance;
await test("list-overpayments (#allocations)", async () => {
  const ops = unwrap(await listXeroOverpayments(1, undefined, 10));
  opWithBalance = (ops ?? []).find(o => (o.remainingCredit ?? 0) > 0);
  pass("list-overpayments (#allocations)", `${ops?.length ?? 0} overpayment(s); ${opWithBalance ? "one has balance" : "none with balance"}`);
});
await test("list-prepayments (#allocations)", async () => {
  const pps = unwrap(await listXeroPrepayments(1, undefined, 10));
  ppWithBalance = (pps ?? []).find(p => (p.remainingCredit ?? 0) > 0);
  pass("list-prepayments (#allocations)", `${pps?.length ?? 0} prepayment(s); ${ppWithBalance ? "one has balance" : "none with balance"}`);
});

// ---- create-credit-note-allocation: self-contained fixture, fully cleaned up ----
await test("create-credit-note-allocation (#allocations)", async () => {
  const today = new Date().toISOString().split("T")[0];
  // Pick a revenue account code for the fixture line items.
  const accResp = await xeroClient.accountingApi.getAccounts(xeroClient.tenantId, undefined, 'Class=="REVENUE"');
  const revCode = accResp.body.accounts?.[0]?.code;
  if (!revCode) throw new Error("no REVENUE account found for fixture");
  // Throwaway contact.
  const contactResp = await xeroClient.accountingApi.createContacts(xeroClient.tenantId, { contacts: [{ name: `ZZZ Alloc Test ${Date.now()}` }] });
  const contactID = contactResp.body.contacts?.[0]?.contactID;
  // Authorised sales invoice for 100.
  const invResp = await xeroClient.accountingApi.createInvoices(xeroClient.tenantId, { invoices: [{
    type: "ACCREC", contact: { contactID }, date: today, dueDate: today, status: "AUTHORISED",
    lineAmountTypes: "NoTax", lineItems: [{ description: "smoke test", quantity: 1, unitAmount: 100, accountCode: revCode }],
  }] });
  const invoiceID = invResp.body.invoices?.[0]?.invoiceID;
  // Authorised credit note for 100 (same contact).
  const cnResp = await xeroClient.accountingApi.createCreditNotes(xeroClient.tenantId, { creditNotes: [{
    type: "ACCRECCREDIT", contact: { contactID }, date: today, status: "AUTHORISED",
    lineAmountTypes: "NoTax", lineItems: [{ description: "smoke test", quantity: 1, unitAmount: 100, accountCode: revCode }],
  }] });
  const creditNoteID = cnResp.body.creditNotes?.[0]?.creditNoteID;
  try {
    const applied = unwrap(await createXeroCreditNoteAllocation(creditNoteID, [{ invoiceId: invoiceID, amount: 100, date: today }]));
    if (!applied.length) throw new Error("no allocation returned");
    const allocationID = applied[0].allocationID;
    // Cleanup: delete allocation, void both fixtures.
    if (allocationID) await xeroClient.accountingApi.deleteCreditNoteAllocations(xeroClient.tenantId, creditNoteID, allocationID);
    await xeroClient.accountingApi.updateInvoice(xeroClient.tenantId, invoiceID, { invoices: [{ status: "VOIDED" }] });
    await xeroClient.accountingApi.updateCreditNote(xeroClient.tenantId, creditNoteID, { creditNotes: [{ status: "VOIDED" }] });
    pass("create-credit-note-allocation (#allocations)", `applied 100 to invoice, allocation ${allocationID}, cleaned up`);
  } catch (e) {
    // Best-effort cleanup even on failure (comment keeps catch non-empty for eslint no-empty).
    try { await xeroClient.accountingApi.updateInvoice(xeroClient.tenantId, invoiceID, { invoices: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    try { await xeroClient.accountingApi.updateCreditNote(xeroClient.tenantId, creditNoteID, { creditNotes: [{ status: "VOIDED" }] }); } catch { /* ignore */ }
    throw e;
  }
});

// ---- overpayment / prepayment allocation: only if a real source with balance exists ----
await test("create-overpayment-allocation (#allocations)", async () => {
  if (!opWithBalance) { pass("create-overpayment-allocation (#allocations)", "SKIPPED — no overpayment with balance in tenant (cannot create one via API)"); return; }
  const today = new Date().toISOString().split("T")[0];
  const contactID = opWithBalance.contact?.contactID;
  const inv = unwrap(await listXeroInvoices({ where: `Type=="ACCREC" AND Status=="AUTHORISED" AND Contact.ContactID==guid("${contactID}")`, pageSize: 1 }));
  const target = (inv ?? []).find(i => (i.amountDue ?? 0) > 0);
  if (!target) { pass("create-overpayment-allocation (#allocations)", "SKIPPED — overpayment has balance but no matching unpaid invoice for its contact"); return; }
  const amt = Math.min(0.01, opWithBalance.remainingCredit, target.amountDue);
  const applied = unwrap(await createXeroOverpaymentAllocation(opWithBalance.overpaymentID, [{ invoiceId: target.invoiceID, amount: amt, date: today }]));
  const allocationID = applied[0]?.allocationID;
  if (allocationID) await xeroClient.accountingApi.deleteOverpaymentAllocations(xeroClient.tenantId, opWithBalance.overpaymentID, allocationID);
  pass("create-overpayment-allocation (#allocations)", `applied ${amt} then deleted allocation ${allocationID}`);
});

await test("create-prepayment-allocation (#allocations)", async () => {
  if (!ppWithBalance) { pass("create-prepayment-allocation (#allocations)", "SKIPPED — no prepayment with balance in tenant (cannot create one via API)"); return; }
  const today = new Date().toISOString().split("T")[0];
  const contactID = ppWithBalance.contact?.contactID;
  const inv = unwrap(await listXeroInvoices({ where: `Type=="ACCREC" AND Status=="AUTHORISED" AND Contact.ContactID==guid("${contactID}")`, pageSize: 1 }));
  const target = (inv ?? []).find(i => (i.amountDue ?? 0) > 0);
  if (!target) { pass("create-prepayment-allocation (#allocations)", "SKIPPED — prepayment has balance but no matching unpaid invoice for its contact"); return; }
  const amt = Math.min(0.01, ppWithBalance.remainingCredit, target.amountDue);
  const applied = unwrap(await createXeroPrepaymentAllocation(ppWithBalance.prepaymentID, [{ invoiceId: target.invoiceID, amount: amt, date: today }]));
  const allocationID = applied[0]?.allocationID;
  if (allocationID) await xeroClient.accountingApi.deletePrepaymentAllocations(xeroClient.tenantId, ppWithBalance.prepaymentID, allocationID);
  pass("create-prepayment-allocation (#allocations)", `applied ${amt} then deleted allocation ${allocationID}`);
});
```

- [ ] **Step 3: Run the smoke suite**

```powershell
$cfg = Get-Content "$env:USERPROFILE\.claude.json" -Raw | ConvertFrom-Json
$cfg.mcpServers.xero.env.PSObject.Properties | ForEach-Object { Set-Item -Path "Env:$($_.Name)" -Value $_.Value }
node smoke-test.mjs
```

Expected: summary shows all blocks PASS (overpayment/prepayment may report SKIPPED — acceptable per spec).

- [ ] **Step 4: Commit the smoke-test additions on the integration branch**

```bash
git add smoke-test.mjs
git commit -m "test: add live smoke blocks for allocation tools"
```

- [ ] **Step 5: Confirm to the user** that the running MCP must be restarted to pick up the new `dist/`, and report the smoke-test summary + the upstream PR URL.

---

## Notes for the implementer

- **Thin wrapper only.** No aggregation, no business logic. If a transformation feels like a "decision", it belongs in business-workspace tooling, not here.
- **`AllocationLine` is the one shared type**, exported from the credit-note handler and imported by the other two. The 6-line `toAllocations` is repeated per handler by choice (self-contained handlers > one more import for a trivial mapper).
- **Verify SDK response property names** as you go: `response.body.overpayments`, `.prepayments`, and `.allocations`. If the build complains about a property, check the model `.d.ts` under `node_modules/xero-node/dist/gen/model/accounting/`.
