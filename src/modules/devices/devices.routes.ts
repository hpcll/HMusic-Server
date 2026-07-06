import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import { refreshMiDevices } from "../mi/mi.service.js";
import {
  listDevices,
  probeDevice,
  selectDevice,
  upsertDevice,
} from "./devices.service.js";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const capabilitySchema = z
  .object({
    supportsPlayUrl: z.boolean().optional(),
    supportsPauseResume: z.boolean().optional(),
    supportsSeek: z.boolean().optional(),
    supportsVolume: z.boolean().optional(),
    supportsRichStatus: z.boolean().optional(),
    supportsDeviceNext: z.boolean().optional(),
  })
  .strict();

const upsertDeviceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.string().optional(),
    ip: z.string().optional(),
    isOnline: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    capabilities: capabilitySchema.optional(),
  })
  .strict();

export async function devicesRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.get("/", async () => ({
    devices: await listDevices(),
  }));

  app.post("/refresh", async () => refreshMiDevices());

  // Development contract endpoint. The real Xiaomi login flow will call the same service.
  app.post("/mock", async (request) => {
    const body = upsertDeviceSchema.parse(request.body);
    return upsertDevice(body);
  });

  app.post("/:id/select", async (request) => {
    const params = paramsSchema.parse(request.params);
    return selectDevice(params.id);
  });

  app.post("/:id/probe", async (request) => {
    const params = paramsSchema.parse(request.params);
    return probeDevice(params.id);
  });
}
