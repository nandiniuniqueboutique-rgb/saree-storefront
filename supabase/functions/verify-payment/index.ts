// Confirms the payment signature from the browser and marks the order paid.
import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyPaymentHandler } from "../_shared/handlers.js";
import { makeDb } from "../_shared/db.js";

const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(verifyPaymentHandler({
  db: makeDb(client),
  keySecret: Deno.env.get("RAZORPAY_KEY_SECRET"),
  allowedOrigins: (Deno.env.get("ALLOWED_ORIGINS") || "https://store.nandhiniunique.com").split(",").map(s => s.trim())
}));
