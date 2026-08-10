import { Hono } from "hono";
import { bookingsRouter } from "./routes/bookings.js";
import { timelineRouter } from "./routes/timeline.js";

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", bookingsRouter);
app.route("/", timelineRouter);

export default app;
