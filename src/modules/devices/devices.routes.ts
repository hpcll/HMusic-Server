import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import { probeMiDeviceLink, hasStoredMiSession, refreshMiDevices } from "../mi/mi.service.js";
import { retargetPlayback } from "../playback/playback.service.js";
import {
  LOCAL_DEVICE_ID,
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
    const result = await selectDevice(params.id);
    // 默认设备即播放目标：否则切到本机后 resume 仍指向旧音箱。
    const playback = await retargetPlayback(params.id);
    return { ...result, playback };
  });

  app.post("/:id/probe", async (request) => {
    const params = paramsSchema.parse(request.params);
    // 真探测：音箱先发一次真实 ubus 状态查询（会话过期/离线当场暴露），
    // 通过了才返回能力表。本机虚拟设备无链路可测；未登录小米时无从真探测，
    // 二者都降级为直接返回能力表（不谎报成功，也不误报失败）。
    if (params.id !== LOCAL_DEVICE_ID && (await hasStoredMiSession())) {
      await probeMiDeviceLink(params.id);
    }
    return probeDevice(params.id);
  });
}
