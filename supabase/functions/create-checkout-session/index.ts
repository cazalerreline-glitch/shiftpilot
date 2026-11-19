import { createClient } from "npm:@supabase/supabase-js@2";

const APP_URL = "https://cazalerreline-glitch.github.io/shiftpilot/";
const APP_ORIGIN = "https://cazalerreline-glitch.github.io";
const STRIPE_PRICE_ID = "price_1UYd1pQy4VpzdvFnpHyA1Azm";
const corsHeaders = {
  "Access-Control-Allow-Origin": APP_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return json({ error: "Connexion requise." }, 401);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const publishableKeys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    const supabaseSecret = secretKeys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const publishableKey = publishableKeys.default || Deno.env.get("SUPABASE_ANON_KEY");

    if (!url || !stripeKey || !supabaseSecret || !publishableKey) {
      return json({ error: "Configuration sécurisée indisponible." }, 500);
    }

    const authClient = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Session invalide. Reconnectez-vous." }, 401);
    const user = authData.user;

    const body = await req.json();
    const organizationId = String(body.organization_id || "");
    if (!organizationId) return json({ error: "Établissement introuvable." }, 400);

    const admin = createClient(url, supabaseSecret, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });

    const { data: membership, error: membershipError } = await admin
      .from("Memberships")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return json({ error: "Seuls le propriétaire et les administrateurs peuvent gérer l’abonnement." }, 403);
    }

    const { data: existing, error: existingError } = await admin
      .from("Subscriptions")
      .select("stripe_customer_id,status")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing && ["active", "trialing", "past_due", "incomplete"].includes(existing.status)) {
      return json({ error: "Un abonnement existe déjà pour cet établissement. Contactez l’assistance pour le gérer." }, 409);
    }

    const params = new URLSearchParams();
    params.set("mode", "subscription");
    params.set("line_items[0][price]", STRIPE_PRICE_ID);
    params.set("line_items[0][quantity]", "1");
    params.set("success_url", APP_URL + "?checkout=success&session_id={CHECKOUT_SESSION_ID}");
    params.set("cancel_url", APP_URL + "?checkout=cancel");
    params.set("client_reference_id", organizationId);
    params.set("metadata[organization_id]", organizationId);
    params.set("metadata[supabase_user_id]", user.id);
    params.set("subscription_data[metadata][organization_id]", organizationId);
    params.set("subscription_data[metadata][supabase_user_id]", user.id);
    params.set("allow_promotion_codes", "true");

    if (existing?.stripe_customer_id) {
      params.set("customer", existing.stripe_customer_id);
    } else if (user.email) {
      params.set("customer_email", user.email);
    }

    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + stripeKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    const session = await stripeResponse.json();
    if (!stripeResponse.ok || !session.url) {
      console.error("Stripe Checkout error:", session?.error?.type || "unknown", session?.error?.code || "");
      return json({ error: "Impossible de préparer le paiement. Réessayez plus tard." }, 502);
    }

    return json({ url: session.url });
  } catch (error) {
    console.error("create-checkout-session error:", error instanceof Error ? error.message : "unknown");
    return json({ error: "Une erreur est survenue pendant la préparation du paiement." }, 500);
  }
});