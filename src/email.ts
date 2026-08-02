import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY ?? "";
// Resend requires this to be either their shared onboarding@resend.dev sender
// (which can only deliver to your own Resend account's email until you verify
// a domain) or an address on a domain you've verified with them.
const fromAddress = process.env.RESEND_FROM_EMAIL || "VibeMatch <onboarding@resend.dev>";
export const hasEmailCredentials = Boolean(apiKey);

const resend = hasEmailCredentials ? new Resend(apiKey) : null;

/**
 * Sends an email via Resend. If no RESEND_API_KEY is configured yet, this logs
 * to the console instead of throwing, same as sendSms's dev-mode fallback.
 */
export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (!resend) {
    console.log(`[Email - no RESEND_API_KEY set, logging instead] to=${to} subject="${subject}": ${text}`);
    return;
  }

  console.log(`[Email -> ${to}] "${subject}"`);

  try {
    const result = await resend.emails.send({ from: fromAddress, to: [to], subject, text });
    // Like Africa's Talking, a successful HTTP call doesn't guarantee delivery -
    // check the actual result instead of assuming success.
    if (result.error) {
      console.error("Failed to send email via Resend:", result.error);
    } else {
      console.log(`[Email result] id=${result.data?.id}`);
    }
  } catch (err: any) {
    console.error("Failed to send email via Resend:", err?.message ?? err);
  }
}