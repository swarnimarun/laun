/** Telegram identities are asserted by a trusted long-poll bridge and checked server-side. */
export interface TelegramIdentity {
  botId: string;
  userId: string;
  chatId: string;
  topicId?: string;
}
export interface TelegramInboundUpdate extends TelegramIdentity {
  updateId: number;
  text?: string;
  callbackData?: string;
  notice?: "edited" | "unsupported";
}
export interface TelegramDelivery {
  id: string;
  leaseId: string;
  chatId: string;
  topicId?: string;
  text: string;
  buttons?: Array<{ text: string; callbackData: string }>;
}
export interface TelegramIngestResult { accepted: true; callbackAnswer?: string }
export interface TelegramDeliveryAuthorization {authorized:true}
export interface TelegramLinkCode { code: string; expiresAt: string; botId: string }
