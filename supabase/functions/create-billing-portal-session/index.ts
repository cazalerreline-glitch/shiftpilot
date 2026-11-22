import { createClient } from "npm:@supabase/supabase-js@2";

const APP_URL = "https://cazalerreline-glitch.github.io/shiftpilot/";
const APP_ORIGIN = "https://cazalerreline-glitch.github.io";
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
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return json({ error: "Seuls le propriétaire et les administrateurs peuvent gérer l’abonnement." }, 403);
    }

    const { data: subscription, error: subscriptionError } = await admin
      .from("Subscriptions")
      .select("stripe_customer_id")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (subscriptionError) throw subscriptionError;
    if (!subscription?.stripe_customer_id) {
      return json({ error: "Aucun client Stripe n’est encore associé à cet établissement. Si votre paiement a déjà été effectué, contactez l’assistance ShiftPilot." }, 404);
    }

    const params = new URLSearchParams();
    params.set("customer", subscription.stripe_customer_id);
    params.set("return_url", APP_URL + "?billing=return");
    const response = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + stripeKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    const session = await response.json();
    if (!response.ok || !session.url) {
      console.error("Stripe Billing Portal error:", JSON.stringify({
        type: session?.error?.type,
        code: session?.error?.code,
        message: session?.error?.message,
      }));
      return json({ error: "Le portail de facturation Stripe n’est pas encore configuré. Activez-le dans Stripe, puis réessayez." }, 502);
    }
    return json({ url: session.url });
  } catch (error) {
    console.error("create-billing-portal-session error:", error instanceof Error ? error.message : "unknown");
    return json({ error: "Une erreur est survenue pendant l’ouverture de la gestion de l’abonnement." }, 500);
  }
});