/** Normalised donation event shared across all providers */
export interface DonationEvent {
  provider: 'kofi' | 'patreon';
  donorName: string;
  amount: string;
  currency: string;
  message?: string;
  isSubscription: boolean;
  rawEventType: string;
  isPublic: boolean;
}

/** Raw Ko-fi webhook payload (parsed from the body.data JSON string) */
export interface KofiPayload {
  verification_token: string;
  message_id: string;
  timestamp: string;
  type: string;
  from_name: string;
  amount: string;
  currency: string;
  message: string | null;
  is_public: boolean;
  is_subscription_payment: boolean;
  kofi_transaction_id: string;
  url: string;
}
