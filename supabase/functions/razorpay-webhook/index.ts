// Razorpay calls this directly (server to server). It is the safety net: if a customer pays
// but closes the browser before verify-payment runs, the order is still marked paid here.
import { createClient } from "npm:@supabase/supabase-js@2";
import { razorpayWebhookHandler } from "../_shared/handlers.js";
import { makeDb } from "../_shared/db.js";

const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(razorpayWebhookHandler({
  db: makeDb(client),
  webhookSecret: Deno.env.get("RAZORPAY_WEBHOOK_SECRET")
}));
