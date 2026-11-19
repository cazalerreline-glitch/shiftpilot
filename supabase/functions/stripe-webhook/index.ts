import Stripe from "npm:stripe@^22";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const stripe = new Stripe(stripeKey);
const cryptoProvider = Stripe.createSubtleCryptoProvider();

async function getStripeSubscription(subscriptionId: string) {
  const response = await fetch("https://api.stripe.com/v1/subscriptions/" + encodeURIComponent(subscriptionId), {
    headers: { Authorization: "Bearer " + stripeKey },
  });
  const data = await response.json();
  if (!response.ok) throw new Error("Impossible de récupérer l’abonnement Stripe.");
  return data;
}

async function syncSubscription(admin: ReturnType<typeof createClient>, sub: Record<string, any>, fallbackOrgId?: string) {
  const organizationId = String(sub.metadata?.organization_id || fallbackOrgId || "");
  if (!organizationId) throw new Error("organization_id absent des métadonnées Stripe.");

  const priceId = sub.items?.data?.[0]?.price?.id || null;
  const periodEnd = sub.current_period_end
    ? new Date(Number(sub.current_period_end) * 1000).toISOString()
    : null;

  const { error } = await admin.from("Subscriptions").upsert({
    organization_id: organizationId,
    provider: "stripe",
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id || null,
    stripe_subscription_id: sub.id,
    stripe_price_id: priceId,
    status: sub.status || "inactive",
    current_period_end: periodEnd,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    updated_at: new Date().toISOString(),
  }, { onConflict: "organization_id" });

  if (error) throw error;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!stripeKey || !webhookSecret) {
    console.error("Stripe webhook secrets are not configured.");
    return new Response("Webhook configuration missing", { status: 500 });
  }

  const signature = req.headers.get("Stripe-Signature") || "";
  const body = await req.text();
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      webhookSecret,
      undefined,
      cryptoProvider,
    );
  } catch (error) {
    console.error("Stripe signature verification failed:", error instanceof Error ? error.message : "unknown");
    return new Response("Invalid signature", { status: 400 });
  }

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const supabaseSecret = secretKeys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !supabaseSecret) throw new Error("Supabase admin configuration missing.");

    const admin = createClient(url, supabaseSecret, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });

    const object = event.data.object as Record<string, any>;

    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      if (object.mode === "subscription" && object.subscription) {
        const subscriptionId = typeof object.subscription === "string" ? object.subscription : object.subscription.id;
        const sub = await getStripeSubscription(subscriptionId);
        await syncSubscription(admin, sub, String(object.metadata?.organization_id || object.client_reference_id || ""));
      }
    } else if (event.type.startsWith("customer.subscription.")) {
      await syncSubscription(admin, object);
    } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const subscriptionId = typeof object.subscription === "string" ? object.subscription : object.subscription?.id;
      if (subscriptionId) {
        const sub = await getStripeSubscription(subscriptionId);
        await syncSubscription(admin, sub);
      }
    }

    const { error: eventError } = await admin.from("StripeEvents").upsert({
      id: event.id,
      event_type: event.type,
    }, { onConflict: "id", ignoreDuplicates: true });
    if (eventError) throw eventError;

    return Response.json({ received: true });
  } catch (error) {
    console.error("stripe-webhook processing error:", error instanceof Error ? error.message : "unknown");
    return new Response("Webhook processing failed", { status: 500 });
  }
});