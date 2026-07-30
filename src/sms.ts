import AfricasTalkingInit from "africastalking";

const apiKey = process.env.AT_API_KEY ?? "";
const username = process.env.AT_USERNAME ?? "sandbox";
export const hasRealCredentials = Boolean(apiKey && apiKey !== "your_sandbox_api_key_here");

const at = hasRealCredentials ? AfricasTalkingInit({ apiKey, username }) : null;

/**
 * Sends an SMS via Africa's Talking. If no real sandbox API key is configured yet
 * (see .env), this logs to the console instead of throwing, so the rest of the
 * app keeps working while you're still setting up your AT account.
 */
export async function sendSms(to: string, message: string): Promise<void> {
  if (!at) {
    console.log(`[SMS - no AT_API_KEY set, logging instead] to=${to}: "${message}"`);
    return;
  }

  // Also log locally during dev so you can see OTPs/messages in the terminal
  // even though they're genuinely being sent through Africa's Talking now.
  console.log(`[SMS -> ${to}] "${message}"`);

  try {
    await at.SMS.send({ to: [to], message });
  } catch (err: any) {
    // Log only the useful bit - the full Axios error includes request headers,
    // which would print your API key straight into the console/logs.
    const detail = err?.response?.data ?? err?.message ?? err;
    console.error("Failed to send SMS via Africa's Talking:", detail);
  }
}
