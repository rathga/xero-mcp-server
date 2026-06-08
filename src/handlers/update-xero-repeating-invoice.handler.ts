import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { RepeatingInvoice } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import {
  buildRepeatingInvoice,
  CreateRepeatingInvoiceInput,
} from "./create-xero-repeating-invoice.handler.js";

export type UpdateRepeatingInvoiceInput = Omit<
  CreateRepeatingInvoiceInput,
  "status"
> & {
  repeatingInvoiceId: string;
  status?: "DRAFT" | "AUTHORISED" | "DELETED";
};

/**
 * Update a repeating-invoice template in Xero. Full replace (POST-with-ID): every field
 * is re-sent, so line items and schedule not provided are wiped. Pass status="DELETED" to
 * delete the template (there is no separate delete endpoint).
 */
export async function updateXeroRepeatingInvoice(
  input: UpdateRepeatingInvoiceInput,
): Promise<XeroClientResponse<RepeatingInvoice>> {
  try {
    await xeroClient.authenticate();

    const repeatingInvoice = buildRepeatingInvoice(
      input as CreateRepeatingInvoiceInput & { repeatingInvoiceId: string },
    );

    const response =
      await xeroClient.accountingApi.updateOrCreateRepeatingInvoices(
        xeroClient.tenantId,
        { repeatingInvoices: [repeatingInvoice] },
        true, // summarizeErrors
        undefined, // idempotencyKey
        getClientHeaders(),
      );

    const updated = response.body.repeatingInvoices?.[0];
    if (!updated) {
      throw new Error("Repeating invoice update failed.");
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
