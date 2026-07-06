import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import { searchTracks } from "./search.service.js";

const querySchema = z.object({
  q: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.get("/", async (request) => {
    const query = querySchema.parse(request.query);
    const keyword = query.q ?? query.query;
    return searchTracks({
      query: keyword ?? "",
      source: query.source,
      page: query.page,
      limit: query.limit,
    });
  });
}
