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
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const publishableKeys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    const secretKey = secretKeys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const publishableKey = publishableKeys.default || Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !secretKey || !publishableKey) {
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
    const employeeId = String(body.employee_id || "");
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !organizationId || !employeeId) {
      return json({ error: "Adresse e-mail ou collaborateur invalide." }, 400);
    }

    const admin = createClient(url, secretKey, {
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
      return json({ error: "Seuls le propriétaire et les administrateurs peuvent inviter un collaborateur." }, 403);
    }

    const { data: subscription, error: subscriptionError } = await admin
      .from("Subscriptions")
      .select("status,current_period_end")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (subscriptionError) throw subscriptionError;
    const periodStillOpen = subscription?.current_period_end &&
      new Date(subscription.current_period_end).getTime() > Date.now();
    const hasAccess = ["active", "trialing"].includes(subscription?.status || "") ||
      (subscription?.status === "past_due" && Boolean(periodStillOpen));
    if (!hasAccess) {
      return json({ error: "Un abonnement ShiftPilot actif est nécessaire pour inviter un collaborateur." }, 403);
    }

    const { data: employee, error: employeeError } = await admin
      .from("Employées")
      .select("id,name,user_id")
      .eq("id", employeeId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (employeeError) throw employeeError;
    if (!employee) return json({ error: "Collaborateur introuvable dans cet établissement." }, 404);
    if (employee.user_id) return json({ error: "Cette fiche est déjà associée à un compte." }, 409);

    const { data: existingInvite, error: existingError } = await admin
      .from("ShiftPilotInvitations")
      .select("id,expires_at")
      .eq("email", email)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existingInvite && new Date(existingInvite.expires_at).getTime() > Date.now()) {
      return json({ error: "Une invitation est déjà en attente pour cette adresse." }, 409);
    }
    if (existingInvite) {
      const { error } = await admin.from("ShiftPilotInvitations").delete().eq("id", existingInvite.id);
      if (error) throw error;
    }

    const { error: pendingError } = await admin.from("ShiftPilotInvitations").insert({
      email,
      organization_id: organizationId,
      employee_id: employeeId,
      invited_by: user.id,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    if (pendingError) throw pendingError;

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "invite",
      email,
      options: {
        redirectTo: APP_URL,
        data: { full_name: employee.name || "Collaborateur", shiftpilot_invited: true },
      },
    });
    if (linkError || !linkData?.properties?.action_link) {
      await admin.from("ShiftPilotInvitations").delete().eq("email", email);
      return json({ error: "Impossible de créer le lien d’activation. Vérifiez l’adresse e-mail et réessayez." }, 400);
    }

    return json({
      success: true,
      message: "Lien d’activation créé. Copiez-le et envoyez-le au collaborateur par message.",
      invite_url: linkData.properties.action_link,
      invited_user_id: linkData.user?.id || null,
    });
  } catch (error) {
    console.error("invite-employee error:", error instanceof Error ? error.message : "unknown");
    return json({ error: "Une erreur est survenue pendant la création du lien. Réessayez plus tard." }, 500);
  }
});