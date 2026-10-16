// Database adapter used by the deployed functions (Supabase service role).
export function makeDb(client) {
  return {
    async getProducts(ids) {
      const { data, error } = await client.from("products").select("id,name,price,stock,active").in("id", ids);
      if (error) throw error;
      return data || [];
    },
    async createOrder(order, lines) {
      const { data, error } = await client.from("orders").insert(order).select("id").single();
      if (error) throw error;
      const { error: itemsError } = await client.from("order_items").insert(lines.map(line => ({ ...line, order_id: data.id })));
      if (itemsError) {
        await client.from("orders").delete().eq("id", data.id);
        throw itemsError;
      }
      return data;
    },
    async markPaid(razorpayOrderId, paymentId) {
      const { data, error } = await client.rpc("mark_order_paid", { p_razorpay_order_id: razorpayOrderId, p_payment_id: paymentId });
      if (error) throw error;
      return data;
    },
    async markFailed(razorpayOrderId) {
      const { error } = await client.from("orders").update({ status: "failed" }).eq("razorpay_order_id", razorpayOrderId).eq("status", "pending");
      if (error) throw error;
    }
  };
}
