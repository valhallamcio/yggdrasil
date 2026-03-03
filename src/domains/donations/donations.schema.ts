import { z } from 'zod';

/** Validates the form-urlencoded body from Ko-fi (contains a 'data' JSON string) */
export const kofiBodySchema = z.object({
  data: z.string().min(1),
});

/** Validates the parsed JSON object from the Ko-fi body.data field */
export const kofiPayloadSchema = z.object({
  verification_token: z.string(),
  type: z.string(),
  from_name: z.string(),
  amount: z.string(),
  currency: z.string(),
  message: z.string().nullable().optional(),
  email: z.string().optional(),
  is_subscription_payment: z.boolean().optional(),
  is_first_subscription_payment: z.boolean().optional(),
  kofi_transaction_id: z.string(),
  timestamp: z.string().optional(),
  message_id: z.string().optional(),
  is_public: z.boolean().optional(),
});

/** Validates the Patreon webhook JSON body (JSONAPI format). */
export const patreonBodySchema = z.object({
  data: z.object({
    attributes: z.object({
      amount_cents: z.number().optional(),
      currency: z.string().optional(),
      note: z.string().nullable().optional(),
      patron_status: z.string().nullable().optional(),
      last_charge_date: z.string().nullable().optional(),
      last_charge_status: z.string().nullable().optional(),
      lifetime_support_cents: z.number().optional(),
      pledge_relationship_start: z.string().nullable().optional(),
      currently_entitled_amount_cents: z.number().optional(),
      is_follower: z.boolean().optional(),
    }).passthrough(),
  }),
  included: z.array(z.object({
    type: z.string(),
    attributes: z.object({
      full_name: z.string().optional(),
      name: z.string().optional(),
      email: z.string().optional(),
    }).passthrough(),
  })).optional(),
});

export type KofiBody = z.infer<typeof kofiBodySchema>;
export type KofiPayloadValidated = z.infer<typeof kofiPayloadSchema>;
export type PatreonBody = z.infer<typeof patreonBodySchema>;
