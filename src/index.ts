import { Hono } from "hono";
import { bookingsRouter } from "./routes/bookings.js";

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", bookingsRouter);

export default app;
