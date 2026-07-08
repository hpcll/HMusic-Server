import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import { getChart, listCharts } from "./charts.service.js";

const paramsSchema = z.object({
  id: z.string().min(1),
});

export async function chartsRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.get("/", async () => {
    return { charts: listCharts() };
  });

  app.get("/:id", async (request) => {
    const params = paramsSchema.parse(request.params);
    return getChart(params.id);
  });
}
